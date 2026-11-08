/**
 * Transcript heads (design/prompt-caching.md → Head check): a digest chain
 * over the provider-neutral request with `harness` removed, so a message the
 * loop holds in memory and its persisted row digest the same.
 * `h₀ = H(system, tools)` and `hᵢ = H(hᵢ₋₁ ‖ H(messageᵢ))`, each part as
 * canonical JSON; a request's head is `(length, hₙ)`.
 *
 * Imports nothing else from `agent/`, so the store schema can import it.
 */

import { z } from "zod";
import type { InputTransformation, Message, ToolDefinition } from "../llm/types.js";
import { canonicalJson, sha256 } from "../util/canonical-json.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const RequestHeadSchema = z.object({
  /** How many messages the chain covers. */
  length: z.number().int().nonnegative(),
  /** The chain's digest at `length`. */
  digest: z.string().regex(SHA256_HEX),
});

/** The head of a request: the chain over its first `length` messages. */
export type RequestHead = z.infer<typeof RequestHeadSchema>;

/**
 * `messages.transcript_head`, set on each assistant row a turn writes: the
 * head of the row's request, extended through every message up to and
 * including the row.
 *
 * - `base`: h₀, the system prompt and tools the chain starts from.
 * - `historyStart`: the first message after the summary the turn's view
 *   started from.
 * - `status`: `compacted` when the turn's own compaction rewrote its view
 *   without a stored summary, else `diverged` when a request saw a
 *   server-reported mismatch, else `intact`.
 */
export const TranscriptHeadSchema = RequestHeadSchema.extend({
  base: z.string().regex(SHA256_HEX),
  historyStart: z.string().min(1),
  status: z.enum(["intact", "compacted", "diverged"]),
}).strict();
export type TranscriptHead = z.infer<typeof TranscriptHeadSchema>;

/** `message` with `harness` dropped from its text and `tool_result` blocks: what adapters send. */
function withoutHarness(message: Message): Message {
  if (typeof message.content === "string") return message;
  return {
    role: message.role,
    content: message.content.map((block) => {
      if (block.type !== "text" && block.type !== "tool_result") return block;
      const { harness: _, ...sent } = block;
      return sent;
    }),
  };
}

/** One message's digest: its canonical JSON without `harness`. */
function messageDigest(message: Message): string {
  return sha256(canonicalJson(withoutHarness(message)));
}

/** h₀: the digest of the system prompt and the provider-neutral tool definitions. */
export function baseDigest(system: string, tools: ReadonlyArray<ToolDefinition>): string {
  return sha256(canonicalJson({ system, tools }));
}

/**
 * Builds heads, digesting each message once per hasher. Digests are memoized
 * by object identity, so a message must not be mutated once digested; the
 * loop and the transcript replace messages rather than edit them.
 */
export class TranscriptHasher {
  readonly #digests = new WeakMap<Message, string>();

  /** The head of a request sending `messages` under `base`. */
  head(base: string, messages: ReadonlyArray<Message>): RequestHead {
    return this.extend({ length: 0, digest: base }, messages, 0);
  }

  /** `head` extended by `messages[from..]`, one chain step per message. */
  extend(head: RequestHead, messages: ReadonlyArray<Message>, from: number): RequestHead {
    return messages.slice(from).reduce<RequestHead>(
      (h, message) => ({
        length: h.length + 1,
        digest: sha256(h.digest + this.#digest(message)),
      }),
      head,
    );
  }

  #digest(message: Message): string {
    const known = this.#digests.get(message);
    if (known !== undefined) return known;
    const digest = messageDigest(message);
    this.#digests.set(message, digest);
    return digest;
  }
}

/** `thinking_dropped` reasons that mean the provider saw a history other than the one the block was bound to. */
const DIVERGING_DROP_REASONS: ReadonlySet<string> = new Set([
  "prefix_binding_mismatch",
  "organization_binding_mismatch",
]);

/**
 * Whether a server-reported transformation means the request's history
 * diverged from the one its thinking was bound to: `thinking_mismatch_allowed`,
 * or a `thinking_dropped` for a prefix or organization binding. A model or
 * end-user binding drop follows a model switch or a routing change, and
 * changes nothing the next turn sends.
 */
export function isDivergingTransformation(t: InputTransformation): boolean {
  return (
    t.type === "thinking_mismatch_allowed" ||
    (t.type === "thinking_dropped" && DIVERGING_DROP_REASONS.has(t.reason))
  );
}

/** One request a loop sent: its length, and its digest unless its memo predates heads. */
export interface SentRequest {
  length: number;
  digest: string | null;
}

/** The requests one agent loop sent, in order, which the heads of its persisted rows extend. */
export interface LoopRequests {
  /** The system prompt every request sent. */
  system: string;
  /** The tool definitions every request sent; empty when it sent none. */
  tools: ReadonlyArray<ToolDefinition>;
  /** Where the loop's new messages start: the length of the history it was given, as sent. */
  historyLength: number;
  /** One per iteration that reached the provider, by increasing length. */
  sent: ReadonlyArray<SentRequest>;
  /** Whether any response reported a transformation {@link isDivergingTransformation} accepts. */
  diverged: boolean;
}

/** What a turn's row heads take from its view. */
export interface HeadView {
  /** The first message the loaded history holds after its summary. */
  historyStart: string;
  /** Whether the turn's own compaction rewrote its view without a stored summary. */
  compacted: boolean;
}

/**
 * The transcript head of each of `rows`, the loop's new messages as persisted,
 * positionally: null for a user row, and for a row no head can describe. An
 * assistant row at position `p` takes the head of the last request whose
 * length is at most `p`, extended through every row up to and including it.
 * A request whose memo predates heads leaves every row from its length on
 * without one.
 */
export function rowHeads(
  hasher: TranscriptHasher,
  loop: LoopRequests,
  rows: ReadonlyArray<Message>,
  view: HeadView,
): Array<TranscriptHead | null> {
  const base = baseDigest(loop.system, loop.tools);
  const status = view.compacted ? "compacted" : loop.diverged ? "diverged" : "intact";
  return rows.map((row, i) => {
    if (row.role !== "assistant") return null;
    const position = loop.historyLength + i;
    const before = loop.sent.filter((request) => request.length <= position);
    const request = before.at(-1);
    if (request?.digest == null || before.some((r) => r.digest === null)) return null;
    const head = hasher.extend(
      { length: request.length, digest: request.digest },
      rows.slice(0, i + 1),
      request.length - loop.historyLength,
    );
    return { ...head, base, historyStart: view.historyStart, status };
  });
}
