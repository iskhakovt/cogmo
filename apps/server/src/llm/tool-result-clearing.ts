/**
 * Strategy 1 applied on the wire, for endpoints that don't clear on a server
 * of their own: the OpenAI-compatible adapter's, and an Anthropic-compatible
 * third-party endpoint's (see design/context-management.md → Strategy 1).
 * Both adapters send the cleared messages as the request body and count them,
 * so what a count measures is what goes out.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";
import * as R from "remeda";
import type { ContentBlock, CountTokensParams, Message } from "./types.js";

let encoder: Tiktoken | null = null;

/** cl100k_base, the encoding every local estimate uses. */
export function cl100k(): Tiktoken {
  if (!encoder) encoder = getEncoding("cl100k_base");
  return encoder;
}

/** The longest pre-tokenizer piece encoded in one call, in code points. */
const MAX_PIECE = 64;

/**
 * Runs the pre-tokenizer keeps as one piece when they're long: letters (CJK
 * text among them), punctuation, whitespace. Digits come in threes.
 */
const LONG_RUN = /\p{L}{65,}|[^\s\p{L}\p{N}]{65,}|\s{65,}/gu;

/**
 * Tokens in `text`, special-token markers (`<|endoftext|>`) counted as the
 * plain text they are: js-tiktoken throws on one by default, and a tool
 * result or a user message can carry one.
 *
 * A long run the pre-tokenizer would keep whole is encoded 64 code points at
 * a time. Byte-pair merging is quadratic in a piece: 16,000 letters, spaces
 * or `=` take about ten seconds as one piece and tens of milliseconds split.
 * Each seam can cost a token, well under 1% on such a run; prose has no such
 * runs and counts as one encode does.
 */
export function encodedLength(enc: Tiktoken, text: string): number {
  const encode = (piece: string) => enc.encode(piece, [], []).length;
  let tokens = 0;
  let from = 0;
  for (const match of text.matchAll(LONG_RUN)) {
    tokens += encode(text.slice(from, match.index));
    const points = Array.from(match[0]);
    for (let i = 0; i < points.length; i += MAX_PIECE) {
      tokens += encode(points.slice(i, i + MAX_PIECE).join(""));
    }
    from = match.index + match[0].length;
  }
  return tokens + encode(text.slice(from));
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
 * `promptParts` yields the prompt's tokens a part at a time, lazily: the rule
 * asks only whether sums pass two thresholds, so each sum stops once it does,
 * and the decision encodes at most about the trigger plus `clearAtLeastTokens`
 * — 70% of the budget — whatever the prompt's size.
 */
export function withClearedToolResults(
  params: CountTokensParams,
  promptParts: (messages: Message[]) => Iterable<number>,
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
  if (!sumPasses(promptParts(params.messages), (sum) => sum > clearing.triggerTokens)) {
    return params.messages;
  }

  const enc = cl100k();
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
    for (const r of cleared) yield encodedLength(enc, r.content);
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
 * A cl100k estimate of a request's prompt over its canonical blocks, a part
 * at a time: the system prompt, each message, each tool definition. It is
 * what an Anthropic-compatible third-party endpoint's clearing compares with
 * its trigger, since the adapter has no local Claude tokenizer and a count
 * per request would be a round trip. Only the trigger rests on it; the count
 * compaction reads is the endpoint's own.
 */
export function* canonicalPromptParts(
  params: Pick<CountTokensParams, "system" | "messages" | "tools">,
): Generator<number> {
  const enc = cl100k();
  const blockTokens = (block: ContentBlock): number => {
    switch (block.type) {
      case "text":
        return encodedLength(enc, block.text);
      case "thinking":
        return encodedLength(enc, block.thinking);
      case "tool_use":
        return encodedLength(enc, block.name) + encodedLength(enc, JSON.stringify(block.input));
      case "tool_result":
        return encodedLength(enc, block.content);
      case "image":
      case "document":
        return ATTACHMENT_TOKENS;
    }
  };
  const messageTokens = (msg: Message): number =>
    MESSAGE_FRAMING_TOKENS +
    (typeof msg.content === "string"
      ? encodedLength(enc, msg.content)
      : R.sumBy(msg.content, blockTokens));
  yield encodedLength(enc, params.system);
  for (const msg of params.messages) yield messageTokens(msg);
  for (const tool of params.tools ?? []) yield encodedLength(enc, JSON.stringify(tool));
}
