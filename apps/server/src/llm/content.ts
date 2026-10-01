/**
 * Pure helpers over the canonical message content shape.
 */

import { canonicalKeyOrder } from "../util/canonical-key-order.js";
import { type ContentBlock, HARNESS_ROW_TAGS, type HarnessTag } from "./types.js";

const harnessRowTags: ReadonlySet<HarnessTag> = new Set(HARNESS_ROW_TAGS);
/** The tags {@link isHarnessPrompt} reports; the truncation notice is not among them. */
const harnessPromptTags: ReadonlySet<HarnessTag> = new Set<HarnessTag>([
  "continuation",
  "volume_nudge",
]);

/**
 * Whether a user row with this content is a turn's own row: one holding no
 * `tool_result` block and no block tagged with a {@link HARNESS_ROW_TAGS}
 * value. Every other user row belongs to the row before it — a tool-result
 * row to its tool call, the continuation prompt to the row it follows.
 * {@link NOT_TURN_ROW_JSONPATH} is the same rule in SQL.
 */
export function isTurnRowContent(content: string | ReadonlyArray<ContentBlock>): boolean {
  if (typeof content === "string") return true;
  return !content.some(
    (b) =>
      b.type === "tool_result" ||
      (b.type === "text" && b.harness !== undefined && harnessRowTags.has(b.harness)),
  );
}

/**
 * A SQL/JSON path matching the content of a row that is not a turn row, the
 * negation of {@link isTurnRowContent}. A string row has no elements, so it
 * never matches.
 */
export const NOT_TURN_ROW_JSONPATH = `$[*] ? (@.type == "tool_result" || ${HARNESS_ROW_TAGS.map(
  (tag) => `@.harness == "${tag}"`,
).join(" || ")})`;

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
 * Whether `block` is a prompt the agent loop wrote to steer the model — the
 * continuation prompt or the volume-cluster nudge. Readers of the conversation
 * (the web history, the Observer) drop these; the truncation notice is part of
 * the reply and stays.
 */
export function isHarnessPrompt(block: ContentBlock): boolean {
  return (
    (block.type === "text" || block.type === "tool_result") &&
    block.harness !== undefined &&
    harnessPromptTags.has(block.harness)
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
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}
