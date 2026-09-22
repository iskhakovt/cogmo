/**
 * Pure helpers over the canonical message content shape.
 */

import type { ContentBlock } from "./types.js";

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
