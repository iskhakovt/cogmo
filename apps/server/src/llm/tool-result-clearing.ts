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

/**
 * Tokens in `text`, special-token markers (`<|endoftext|>`) counted as the
 * plain text they are: js-tiktoken throws on one by default, and a tool
 * result or a user message can carry one.
 */
export function encodedLength(enc: Tiktoken, text: string): number {
  return enc.encode(text, [], []).length;
}

/** What a cleared tool result reads as. The `tool_use` it answers stays intact. */
export const CLEARED_PLACEHOLDER = "[Cleared — call tool again if needed]";

/**
 * The request's messages with its Strategy 1 intent applied, by the rule
 * Anthropic's `clear_tool_uses_20250919` applies on its server: once the
 * prompt, by `promptTokens`, exceeds the trigger, every tool result but the
 * last `keep` reads as a placeholder, provided they hold at least
 * `clearAtLeastTokens`. The caller's messages stay as they are.
 */
export function withClearedToolResults(
  params: CountTokensParams,
  promptTokens: (messages: Message[]) => number,
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
  if (promptTokens(params.messages) <= clearing.triggerTokens) return params.messages;

  const enc = cl100k();
  const results = params.messages.flatMap((msg, msgIdx) =>
    typeof msg.content === "string"
      ? []
      : msg.content.flatMap((block, blockIdx) =>
          block.type === "tool_result" ? [{ msgIdx, blockIdx, content: block.content }] : [],
        ),
  );
  const cleared = results.slice(0, Math.max(0, results.length - clearing.keep));
  const clearedTokens = R.sumBy(cleared, (r) => encodedLength(enc, r.content));
  if (cleared.length === 0 || clearedTokens < clearing.clearAtLeastTokens) return params.messages;

  const positions = new Set(cleared.map((r) => `${r.msgIdx}:${r.blockIdx}`));
  return params.messages.map((msg, msgIdx) =>
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
 * A cl100k estimate of a request's prompt over its canonical blocks: the
 * trigger an Anthropic-compatible third-party endpoint's clearing compares
 * with, since the adapter has no local Claude tokenizer and a count per
 * request would be a round trip. Only the trigger rests on it; the count
 * compaction reads is the endpoint's own.
 */
export function canonicalPromptTokens(
  params: Pick<CountTokensParams, "system" | "messages" | "tools">,
): number {
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
  return (
    encodedLength(enc, params.system) +
    R.sumBy(params.messages, messageTokens) +
    R.sumBy(params.tools ?? [], (tool) => encodedLength(enc, JSON.stringify(tool)))
  );
}
