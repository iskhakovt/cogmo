/**
 * The Observer's window: which of a conversation's messages each extraction
 * phase has not processed yet, split into chunks an extraction call can take,
 * and the earlier conversation each chunk is read beside. See
 * design/evolution.md → Observation Window.
 */

import type { Transactor } from "../../db/index.js";
import { computeBudget, type PartialLimits, resolveLimits } from "../../llm/models.js";
import type { Message } from "../../llm/types.js";
import type { AgentStore, ObservedPhase, ObserverBounds } from "../store/index.js";
import { formatMessage, type ObserverTranscript } from "./extract-corrections.js";

/** Chunks a phase extracts in one fire; the rest of its window waits for the next. */
export const MAX_CHUNKS_PER_FIRE = 3;

/** Messages before a chunk sent as its context: Mem0's m = 10. */
export const CONTEXT_MESSAGES = 10;

/**
 * The share of the extraction model's input budget one chunk may fill, and
 * its context may fill again. Leaves room for the system prompt and for the
 * four-characters-a-token estimate, which runs up to about 2× low on code and
 * non-Latin text.
 */
const CHUNK_BUDGET_SHARE = 0.25;

/** A run of a phase's window: the messages after `after` (from the start when null) through `through`. */
export interface ObserverChunk {
  after: string | null;
  through: string;
  messages: number;
}

/** What a fire extracts: the chunks of each phase, and the token limit they were cut to. */
export interface ObserverPlan {
  tokenLimit: number;
  chunks: Readonly<Record<ObservedPhase, ReadonlyArray<ObserverChunk>>>;
}

export const OBSERVED_PHASES: ReadonlyArray<ObservedPhase> = ["corrections", "memories"];

/** A phase's window is empty when its cursor already names the fire's last message. */
export function isCaughtUp(bounds: ObserverBounds, phase: ObservedPhase): boolean {
  return bounds.lastMessageId === null || bounds.observedThrough[phase] === bounds.lastMessageId;
}

/** The tokens one chunk, or its context, may take on `model`. */
export function chunkTokenLimit(model: string, limits: PartialLimits): number {
  return Math.floor(computeBudget(resolveLimits(model, limits)) * CHUNK_BUDGET_SHARE);
}

/** Four characters a token, over the text extraction sends for the message. */
function estimateTokens(message: Message): number {
  return Math.ceil(formatMessage(message).length / 4);
}

/**
 * Split a phase's window into chunks of at most `tokenLimit` estimated tokens,
 * at message boundaries, keeping the first `maxChunks`. A message larger than
 * the limit is a chunk of its own.
 */
export function planChunks(
  window: ReadonlyArray<Message & { id: string }>,
  after: string | null,
  tokenLimit: number,
  maxChunks: number,
): ObserverChunk[] {
  const chunks: ObserverChunk[] = [];
  let start = after;
  let tokens = 0;
  let count = 0;
  let last: string | null = null;
  // A stateful scan that stops at `maxChunks`.
  for (const message of window) {
    const size = estimateTokens(message);
    if (last !== null && count > 0 && tokens + size > tokenLimit) {
      chunks.push({ after: start, through: last, messages: count });
      if (chunks.length === maxChunks) return chunks;
      start = last;
      tokens = 0;
      count = 0;
    }
    tokens += size;
    count += 1;
    last = message.id;
  }
  if (last !== null && count > 0) chunks.push({ after: start, through: last, messages: count });
  return chunks;
}

export interface ObserverWindowDeps {
  runInTx: Transactor;
  store: Pick<
    AgentStore,
    "listMessagesInRange" | "listMessagesThrough" | "getLatestSummaryThrough"
  >;
}

/**
 * Plan the chunks of each of `phases` for a fire whose window tops out at
 * `bounds.lastMessageId`; the other phases get none. Reads the messages after
 * the lower cursor once and returns only the chunks' bounds, so the plan
 * stays small as step state.
 */
export async function planObserverChunks(
  deps: ObserverWindowDeps,
  args: {
    conversationId: string;
    bounds: ObserverBounds;
    phases: ReadonlyArray<ObservedPhase>;
    tokenLimit: number;
  },
): Promise<ObserverPlan> {
  const { bounds, tokenLimit } = args;
  const top = bounds.lastMessageId;
  const behind = args.phases.filter((phase) => !isCaughtUp(bounds, phase));
  if (top === null || behind.length === 0) {
    return { tokenLimit, chunks: { corrections: [], memories: [] } };
  }
  // Canonical UUID text sorts as the UUID's bytes, and UUIDv7 bytes sort by time.
  const lowest = behind
    .map((phase) => bounds.observedThrough[phase])
    .reduce((a, b) => (a === null || b === null ? null : a < b ? a : b));
  const window = await deps.runInTx((tx) =>
    deps.store.listMessagesInRange(tx, args.conversationId, { after: lowest, through: top }),
  );
  const chunksOf = (phase: ObservedPhase): ObserverChunk[] => {
    if (!behind.includes(phase)) return [];
    const cursor = bounds.observedThrough[phase];
    // A higher cursor is a message inside the window; its phase's part follows it.
    const unseen =
      cursor === lowest ? window : window.slice(window.findIndex((m) => m.id === cursor) + 1);
    return planChunks(unseen, cursor, tokenLimit, MAX_CHUNKS_PER_FIRE);
  };
  return {
    tokenLimit,
    chunks: { corrections: chunksOf("corrections"), memories: chunksOf("memories") },
  };
}

/**
 * A chunk's messages and the earlier conversation it is read beside: the
 * widest summary ending at or before the chunk's start, and up to the last
 * `CONTEXT_MESSAGES` messages before it, the oldest dropped past `tokenLimit`.
 * A chunk at the start of the conversation has neither.
 */
export async function loadChunkTranscript(
  deps: ObserverWindowDeps,
  args: { conversationId: string; chunk: ObserverChunk; tokenLimit: number },
): Promise<ObserverTranscript> {
  const { conversationId, chunk } = args;
  const { summary, context, messages } = await deps.runInTx(async (tx) => ({
    summary:
      chunk.after === null
        ? undefined
        : await deps.store.getLatestSummaryThrough(tx, conversationId, chunk.after),
    context:
      chunk.after === null
        ? []
        : await deps.store.listMessagesThrough(tx, conversationId, chunk.after, CONTEXT_MESSAGES),
    messages: await deps.store.listMessagesInRange(tx, conversationId, chunk),
  }));
  return {
    summary: summary?.summary ?? null,
    context: fitContext(context, args.tokenLimit),
    messages,
    throughMessageId: chunk.through,
  };
}

/** The newest messages of `context` that fit in `tokenLimit`, oldest first. */
function fitContext(context: ReadonlyArray<Message>, tokenLimit: number): Message[] {
  const kept: Message[] = [];
  let tokens = 0;
  // Newest first, stopping at the first message that doesn't fit.
  for (const message of [...context].reverse()) {
    tokens += estimateTokens(message);
    if (tokens > tokenLimit) break;
    kept.unshift(message);
  }
  return kept;
}
