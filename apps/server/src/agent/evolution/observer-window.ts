/**
 * The Observer's window: which of a conversation's messages an extraction
 * phase has not processed yet, split into chunks an extraction call can take,
 * and the earlier conversation each chunk is read beside. See
 * design/evolution.md → Observation Window.
 */

import * as R from "remeda";
import type { Transactor } from "../../db/index.js";
import { computeBudget, type PartialLimits, resolveLimits } from "../../llm/models.js";
import type { Message } from "../../llm/types.js";
import type { AgentStore, ObservedPhase, ObserverBounds } from "../store/index.js";
import { formatMessage, type ObserverTranscript } from "./extract-corrections.js";

/** Chunks a phase extracts in one fire; the rest of its window waits for the next. */
export const MAX_CHUNKS_PER_FIRE = 3;

/** Messages before a chunk sent as its context: Mem0's m = 10. */
export const CONTEXT_MESSAGES = 10;

/** Messages a plan reads at a time while it cuts chunks. */
export const PLAN_PAGE_SIZE = 100;

/**
 * The share of the extraction model's input budget one chunk may fill, and
 * its context (summary included) may fill again. Leaves room for the system
 * prompt and the estimate's error.
 */
const CHUNK_BUDGET_SHARE = 0.25;

/**
 * The smallest chunk limit extraction runs with. A quarter of a small budget
 * is raised to it; a model whose budget can't hold a chunk and its context at
 * this size isn't used for extraction at all.
 */
export const MIN_CHUNK_TOKENS = 1_000;

export const OBSERVED_PHASES: ReadonlyArray<ObservedPhase> = ["corrections", "memories"];

/** A run of a phase's window: the messages after `after` (from the start when null) through `through`. */
export interface ObserverChunk {
  after: string | null;
  through: string;
  messages: number;
}

/**
 * A phase's chunks for one fire and the token limit they were cut to, or
 * `budget_too_small` when the extraction model can't take a chunk.
 */
export type PhasePlan =
  | { kind: "planned"; tokenLimit: number; chunks: ReadonlyArray<ObserverChunk> }
  | { kind: "budget_too_small" };

/** A phase's window is empty when its cursor already names the fire's last message. */
export function isCaughtUp(bounds: ObserverBounds, phase: ObservedPhase): boolean {
  return bounds.lastMessageId === null || bounds.observedThrough[phase] === bounds.lastMessageId;
}

/**
 * The tokens one chunk, or its context, may take on `model`: a quarter of its
 * input budget, at least `MIN_CHUNK_TOKENS`. Null when the budget can't hold a
 * chunk and its context at that minimum.
 */
export function chunkTokenLimit(model: string, limits: PartialLimits): number | null {
  const budget = computeBudget(resolveLimits(model, limits));
  if (budget < 2 * MIN_CHUNK_TOKENS) return null;
  return Math.max(MIN_CHUNK_TOKENS, Math.floor(budget * CHUNK_BUDGET_SHARE));
}

/**
 * A conservative token count, computed locally: a third of a token per ASCII
 * character (code runs near three characters a token, English near four) and
 * half a token per UTF-8 byte of anything else (a CJK character is three
 * bytes, so 1.5 tokens; Cyrillic or an accented letter is two, so one). The
 * provider's `countTokens` is a network call per message, too dear to cut
 * chunks with.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(R.sumBy([...text], thirdsOf) / 3);
}

/** A character's estimate in thirds of a token: 1 for ASCII, else 1.5 per UTF-8 byte. */
function thirdsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 3 : code < 0x10000 ? 4.5 : 6;
}

/** `text` cut to `tokenLimit` estimated tokens, the cut marked; unchanged when it fits. */
export function truncateToTokens(text: string, tokenLimit: number): string {
  if (estimateTokens(text) <= tokenLimit) return text;
  const marker = (omitted: number) => `\n[… ${omitted} characters truncated]`;
  const room = (tokenLimit - estimateTokens(marker(text.length))) * 3;
  const chars = [...text];
  let thirds = 0;
  let kept = 0;
  // A stateful scan that stops at the limit.
  for (const char of chars) {
    const weight = thirdsOf(char);
    if (thirds + weight > room) break;
    thirds += weight;
    kept += 1;
  }
  return chars.slice(0, kept).join("") + marker(chars.length - kept);
}

/** A message's transcript line, cut to `tokenLimit`; "" when nothing in it is shown. */
export function messageLine(message: Message, tokenLimit: number): string {
  return truncateToTokens(formatMessage(message), tokenLimit);
}

/** Cuts a phase's window into chunks, fed a message at a time. */
interface ChunkCutter {
  /** Whether the maximum number of chunks is closed, so no later message is needed. */
  full(): boolean;
  add(message: Message & { id: string }): void;
  /** The closed chunks, and the open one while there is room for it. */
  finish(): ObserverChunk[];
}

/**
 * Chunks of at most `tokenLimit` estimated tokens, at message boundaries. A
 * message larger than the limit is a chunk of its own, cut down when read.
 */
function chunkCutter(after: string | null, tokenLimit: number, maxChunks: number): ChunkCutter {
  const chunks: ObserverChunk[] = [];
  let start = after;
  let last: string | null = null;
  let tokens = 0;
  let count = 0;
  const full = () => chunks.length >= maxChunks;
  return {
    full,
    add(message) {
      const size = estimateTokens(messageLine(message, tokenLimit));
      if (last !== null && count > 0 && tokens + size > tokenLimit) {
        chunks.push({ after: start, through: last, messages: count });
        start = last;
        tokens = 0;
        count = 0;
        if (full()) return;
      }
      tokens += size;
      count += 1;
      last = message.id;
    },
    finish() {
      if (!full() && last !== null && count > 0) {
        chunks.push({ after: start, through: last, messages: count });
      }
      return [...chunks];
    },
  };
}

/** Split a window already in hand into chunks, keeping the first `maxChunks`. */
export function planChunks(
  window: ReadonlyArray<Message & { id: string }>,
  after: string | null,
  tokenLimit: number,
  maxChunks: number,
): ObserverChunk[] {
  const cutter = chunkCutter(after, tokenLimit, maxChunks);
  for (const message of window) {
    if (cutter.full()) break;
    cutter.add(message);
  }
  return cutter.finish();
}

export interface ObserverWindowDeps {
  runInTx: Transactor;
  store: Pick<
    AgentStore,
    "listMessagesInRange" | "listMessagesThrough" | "getLatestSummaryThrough"
  >;
}

/**
 * Plan one phase's chunks: the messages after `after` through `through`, read
 * a page at a time until `MAX_CHUNKS_PER_FIRE` chunks are closed or the window
 * ends. Returns only the chunks' bounds, so the plan stays small as step state.
 */
export async function planPhaseChunks(
  deps: ObserverWindowDeps,
  args: {
    conversationId: string;
    after: string | null;
    through: string;
    tokenLimit: number | null;
  },
): Promise<PhasePlan> {
  const { tokenLimit } = args;
  if (tokenLimit === null) return { kind: "budget_too_small" };
  const cutter = chunkCutter(args.after, tokenLimit, MAX_CHUNKS_PER_FIRE);
  await deps.runInTx(async (tx) => {
    let after = args.after;
    // Sequential pages, each starting after the last message read.
    while (!cutter.full()) {
      const page = await deps.store.listMessagesInRange(tx, args.conversationId, {
        after,
        through: args.through,
        limit: PLAN_PAGE_SIZE,
      });
      for (const message of page) {
        if (cutter.full()) break;
        cutter.add(message);
      }
      const last = page.at(-1);
      if (last === undefined || page.length < PLAN_PAGE_SIZE) break;
      after = last.id;
    }
  });
  return { kind: "planned", tokenLimit, chunks: cutter.finish() };
}

/**
 * A chunk's messages as transcript lines and the earlier conversation they are
 * read beside: the widest summary ending at or before the chunk's start, and
 * up to the last `CONTEXT_MESSAGES` messages before it. Every line is cut to
 * `tokenLimit`; the summary to half of it, and the context lines, oldest
 * dropped first, to what the summary leaves. A chunk at the start of the
 * conversation has no earlier conversation.
 */
export async function loadChunkTranscript(
  deps: ObserverWindowDeps,
  args: { conversationId: string; chunk: ObserverChunk; tokenLimit: number },
): Promise<ObserverTranscript> {
  const { conversationId, chunk, tokenLimit } = args;
  const { summary, context, messages } = await deps.runInTx(async (tx) => ({
    summary:
      chunk.after === null
        ? undefined
        : await deps.store.getLatestSummaryThrough(tx, conversationId, chunk.after),
    context:
      chunk.after === null
        ? []
        : await deps.store.listMessagesThrough(tx, conversationId, chunk.after, CONTEXT_MESSAGES),
    messages: await deps.store.listMessagesInRange(tx, conversationId, {
      after: chunk.after,
      through: chunk.through,
      limit: null,
    }),
  }));
  const summaryText =
    summary === undefined ? null : truncateToTokens(summary.summary, Math.floor(tokenLimit / 2));
  const summaryTokens = summaryText === null ? 0 : estimateTokens(summaryText);
  return {
    summary: summaryText,
    context: fitContext(context, tokenLimit, tokenLimit - summaryTokens),
    messages: messages.flatMap((m) => {
      const line = messageLine(m, tokenLimit);
      return line.length === 0 ? [] : [{ id: m.id, line }];
    }),
  };
}

/** The newest lines of `context` that fit in `room` tokens, oldest first. */
function fitContext(context: ReadonlyArray<Message>, tokenLimit: number, room: number): string[] {
  const kept: string[] = [];
  let tokens = 0;
  // Newest first, stopping at the first line that doesn't fit.
  for (const message of [...context].reverse()) {
    const line = messageLine(message, tokenLimit);
    if (line.length === 0) continue;
    tokens += estimateTokens(line);
    if (tokens > room) break;
    kept.unshift(line);
  }
  return kept;
}
