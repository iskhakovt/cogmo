/**
 * Strategy 1 applied on the wire, for endpoints that don't clear on a server
 * of their own: the OpenAI-compatible adapter's, and an Anthropic-compatible
 * third-party endpoint's (see design/context-management.md → Strategy 1).
 * Both adapters send the cleared messages as the request body and count them,
 * so what a count measures is what goes out.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { ContentBlock, CountTokensParams, Message } from "./types.js";

let encoder: Tiktoken | null = null;

/** cl100k_base, the encoding every local estimate uses. */
export function cl100k(): Tiktoken {
  if (!encoder) encoder = getEncoding("cl100k_base");
  return encoder;
}

/** The longest pre-tokenizer piece encoded in one call, in UTF-8 bytes. */
const MAX_PIECE_BYTES = 64;

/**
 * Runs the pre-tokenizer keeps as one piece — letters (CJK text among them)
 * with the character before them that it keeps too, punctuation, whitespace —
 * long enough to pass {@link MAX_PIECE_BYTES} at four bytes a code point.
 * Digits come in threes.
 */
const LONG_RUN = /[^\r\n\p{L}\p{N}]?\p{L}{17,}|[^\s\p{L}\p{N}]{17,}|\s{17,}/gu;

/** The text a running sum encodes between checks, in UTF-16 code units. */
const SLICE_CHARS = 8192;

/** The most pieces of long runs one {@link textTokens} remembers the counts of. */
const PIECE_MEMORY = 4096;

/**
 * Tokens of a text, a slice at a time, lazily: a running sum that stops
 * mid-text has encoded at most one slice past the point it needed.
 */
export type TextTokens = (text: string) => Iterable<number>;

/**
 * {@link TextTokens} in cl100k, remembering each slice's count per text, so
 * two passes over one text encode it once, and the counts of the first
 * {@link PIECE_MEMORY} pieces of long runs, so a run of one character, a rule
 * or an indent that repeats is encoded once.
 *
 * Special-token markers (`<|endoftext|>`) count as the plain text they are:
 * js-tiktoken throws on one by default, and a tool result or a user message
 * can carry one. A long run the pre-tokenizer would keep whole is encoded 64
 * UTF-8 bytes at a time: byte-pair merging is quadratic in a piece, so 16,000
 * letters, spaces or `=` take about ten seconds as one piece and tens of
 * milliseconds split. A seam costs a token where tokens merge across it: at
 * most 0.3% on prose in English, German, Finnish, Chinese and Japanese, on
 * code and on a test log, and 5–12% on text made mostly of long rules or
 * indents.
 */
export function textTokens(enc: Tiktoken): TextTokens {
  const known = new Map<string, number[]>();
  const pieces = new Map<string, number>();
  const pieceTokens = (piece: string): number => {
    const remembered = pieces.get(piece);
    if (remembered !== undefined) return remembered;
    const tokens = enc.encode(piece, [], []).length;
    if (pieces.size < PIECE_MEMORY) pieces.set(piece, tokens);
    return tokens;
  };
  return function* (text) {
    let counts = known.get(text);
    if (counts === undefined) {
      counts = [];
      known.set(text, counts);
    }
    let index = 0;
    for (const slice of slices(text)) {
      let tokens = counts[index];
      if (tokens === undefined) {
        tokens = sliceTokens(enc, pieceTokens, slice);
        counts.push(tokens);
      }
      yield tokens;
      index += 1;
    }
  };
}

/**
 * `text` in slices of at most {@link SLICE_CHARS}, each cut before a space
 * where the window has one, which leaves the pre-tokenizer's pieces as they
 * were, and never inside a surrogate pair. The search for a space reads the
 * window and the character after it, and no further back.
 */
function* slices(text: string): Generator<string> {
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + SLICE_CHARS);
    if (end < text.length) {
      const space = text.slice(start, end + 1).lastIndexOf(" ");
      if (space > 0) end = start + space;
      else if (isLowSurrogate(text.charCodeAt(end))) end -= 1;
    }
    yield text.slice(start, end);
    start = end;
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function sliceTokens(enc: Tiktoken, pieceTokens: (piece: string) => number, slice: string): number {
  const encode = (text: string) => enc.encode(text, [], []).length;
  let tokens = 0;
  let from = 0;
  for (const match of slice.matchAll(LONG_RUN)) {
    tokens += encode(slice.slice(from, match.index));
    let piece = "";
    let pieceBytes = 0;
    for (const point of match[0]) {
      const bytes = Buffer.byteLength(point);
      if (pieceBytes + bytes > MAX_PIECE_BYTES) {
        tokens += pieceTokens(piece);
        piece = "";
        pieceBytes = 0;
      }
      piece += point;
      pieceBytes += bytes;
    }
    tokens += pieceTokens(piece);
    from = match.index + match[0].length;
  }
  return tokens + encode(slice.slice(from));
}

/** What a cleared tool result reads as. The `tool_use` it answers stays intact. */
export const CLEARED_PLACEHOLDER = "[Cleared — call tool again if needed]";

/**
 * The request's messages with its Strategy 1 intent applied, by the rule
 * Anthropic's `clear_tool_uses_20250919` applies on its server: once the
 * prompt exceeds the trigger, every tool result but the last `keep` reads as
 * a placeholder, provided they hold at least `clearAtLeastTokens`. The
 * caller's messages stay as they are.
 *
 * `promptParts` yields the prompt's tokens a slice at a time through
 * `tokens`, lazily: the rule asks only whether two sums pass their
 * thresholds, so each pass stops within a slice of doing so. The decision
 * encodes at most about the trigger plus `clearAtLeastTokens`, 70% of the
 * budget, plus a slice a pass, whatever the prompt's size. A result both
 * passes read is encoded once, through `tokens`' memory.
 */
export function withClearedToolResults(
  params: CountTokensParams,
  promptParts: (messages: Message[], tokens: TextTokens) => Iterable<number>,
  tokens: TextTokens,
): Message[] {
  const clearing = params.clearToolResults;
  if (!clearing) return params.messages;
  // Every cl100k token covers at least one UTF-8 byte, so a request whose
  // JSON fits under the trigger in bytes is under it in tokens, and needs no
  // encoding pass.
  const bytes = Buffer.byteLength(
    JSON.stringify([params.system, params.messages, params.tools ?? []]),
  );
  if (bytes <= clearing.triggerTokens) return params.messages;
  if (!sumPasses(promptParts(params.messages, tokens), (sum) => sum > clearing.triggerTokens)) {
    return params.messages;
  }

  const results = params.messages.flatMap((msg, msgIdx) =>
    typeof msg.content === "string"
      ? []
      : msg.content.flatMap((block, blockIdx) =>
          block.type === "tool_result" ? [{ msgIdx, blockIdx, content: block.content }] : [],
        ),
  );
  const cleared = results.slice(0, Math.max(0, results.length - clearing.keep));
  if (cleared.length === 0) return params.messages;
  const clearedTokens = (function* () {
    for (const r of cleared) yield* tokens(r.content);
  })();
  if (!sumPasses(clearedTokens, (sum) => sum >= clearing.clearAtLeastTokens)) {
    return params.messages;
  }
  return withPlaceholders(params.messages, cleared);
}

/** Whether a running sum of `parts` meets `test`, reading only as many parts as that takes. */
function sumPasses(parts: Iterable<number>, test: (sum: number) => boolean): boolean {
  let sum = 0;
  if (test(sum)) return true;
  for (const part of parts) {
    sum += part;
    if (test(sum)) return true;
  }
  return false;
}

function withPlaceholders(
  messages: Message[],
  cleared: ReadonlyArray<{ msgIdx: number; blockIdx: number }>,
): Message[] {
  const positions = new Set(cleared.map((r) => `${r.msgIdx}:${r.blockIdx}`));
  return messages.map((msg, msgIdx) =>
    typeof msg.content === "string"
      ? msg
      : {
          ...msg,
          content: msg.content.map((block, blockIdx) =>
            block.type === "tool_result" && positions.has(`${msgIdx}:${blockIdx}`)
              ? { ...block, content: CLEARED_PLACEHOLDER }
              : block,
          ),
        },
  );
}

/** Per-message framing, per the OpenAI-compatible count's. */
const MESSAGE_FRAMING_TOKENS = 4;

/** An image or document, at the OpenAI-compatible count's flat image figure. */
const ATTACHMENT_TOKENS = 85;

/**
 * A cl100k estimate of a request's prompt over its canonical blocks, a slice
 * at a time: the system prompt, each message's framing and blocks, each tool
 * definition. It is what an Anthropic-compatible third-party endpoint's
 * clearing compares with its trigger, since the adapter has no local Claude
 * tokenizer and a count per request would be a round trip. Only the trigger
 * rests on it; the count compaction reads is the endpoint's own.
 */
export function* canonicalPromptParts(
  params: Pick<CountTokensParams, "system" | "messages" | "tools">,
  tokens: TextTokens,
): Generator<number> {
  yield* tokens(params.system);
  for (const msg of params.messages) {
    yield MESSAGE_FRAMING_TOKENS;
    if (typeof msg.content === "string") {
      yield* tokens(msg.content);
      continue;
    }
    for (const block of msg.content) yield* blockParts(block, tokens);
  }
  for (const tool of params.tools ?? []) yield* tokens(JSON.stringify(tool));
}

function* blockParts(block: ContentBlock, tokens: TextTokens): Generator<number> {
  switch (block.type) {
    case "text":
      yield* tokens(block.text);
      return;
    case "thinking":
      yield* tokens(block.thinking);
      return;
    case "tool_use":
      yield* tokens(block.name);
      yield* tokens(JSON.stringify(block.input));
      return;
    case "tool_result":
      yield* tokens(block.content);
      return;
    case "image":
    case "document":
      yield ATTACHMENT_TOKENS;
      return;
  }
}
