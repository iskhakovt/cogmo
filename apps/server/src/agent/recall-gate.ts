/**
 * Auto-recall intention gate — decides whether to skip memory recall, and
 * what to query with.
 *
 * Pure, stateless functions. Used in handle-message to gate the auto-recall
 * call based on the profile's auto_recall setting.
 */

import type { InboundContent } from "../transport/content.js";

export type AutoRecallMode = "off" | "always" | "heuristic" | "llm";

const GREETING_ACK_SET = new Set([
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank you",
  "bye",
  "goodbye",
  "got it",
  "sure",
  "okay",
  "ok",
  "yes",
  "no",
  "yep",
  "nope",
  "np",
  "ty",
  "thx",
]);

const CONTINUATION_SET = new Set([
  "go ahead",
  "do it",
  "continue",
  "proceed",
  "sounds good",
  "lgtm",
  "perfect",
  "exactly",
  "agreed",
  "correct",
]);

/**
 * The text auto-recall queries with for a turn's rows: their text parts
 * joined by newline, so an image or document contributes only its caption,
 * and forwarded text only its body, never its `<forwarded_message>` element.
 * Empty when the turn carries no text.
 */
export function recallQueryText(rows: ReadonlyArray<{ content: InboundContent }>): string {
  return rows
    .flatMap(({ content }) =>
      typeof content === "string"
        ? [content]
        : content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
    )
    .join("\n");
}

/**
 * Returns true if auto-recall should be skipped for this message.
 *
 * Conservative by design — only skips messages with zero informational content.
 * A false positive (unnecessary recall) is cheap; a false negative (missed context) is harmful.
 * A message with no text skips in every mode: an attachment alone gives recall nothing to embed.
 */
export function shouldSkipRecall(mode: AutoRecallMode, message: string): boolean {
  if (message.trim() === "") return true;
  switch (mode) {
    case "off":
      return true;
    case "always":
      return false;
    case "heuristic":
      return isLowInformationMessage(message);
    case "llm":
      // Stub: fall through to always-recall. Implement when needed.
      return false;
    default:
      // Unknown mode — safe default is to always recall
      return false;
  }
}

function isLowInformationMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 4) return true;

  const normalized = trimmed.toLowerCase().replace(/[.!?,;:…]+$/u, "");
  if (GREETING_ACK_SET.has(normalized)) return true;
  if (CONTINUATION_SET.has(normalized)) return true;

  return false;
}
