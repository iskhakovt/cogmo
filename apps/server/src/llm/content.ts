/**
 * Pure helpers over the canonical message content shape.
 */

import { canonicalKeyOrder } from "../util/canonical-key-order.js";
import type { ContentBlock } from "./types.js";

/**
 * A copy of `content` with every `tool_use` block's `input` in canonical key
 * order. Other blocks are passed through as they are.
 *
 * The agent loop appends each iteration's content through this, so a tool
 * call carries the same bytes in the requests that follow it within the turn
 * as it does after `messages.content` reloads it on later turns.
 */
export function canonicalizeToolInputs(content: ReadonlyArray<ContentBlock>): ContentBlock[] {
  return content.map((b) =>
    b.type === "tool_use" ? { ...b, input: canonicalKeyOrder(b.input) } : b,
  );
}

/**
 * The prose of a message's content: a string as-is, or every `text` block
 * concatenated verbatim with no separator, so each block's own whitespace is
 * what separates it from the next. Thinking, tool calls, tool results and
 * images contribute nothing.
 */
export function extractText(content: string | ReadonlyArray<ContentBlock>): string {
  if (typeof content === "string") return content;
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}
