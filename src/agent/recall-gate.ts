/**
 * Auto-recall intention gate — decides whether to skip memory recall.
 *
 * Pure, stateless function. Used in handle-message to gate the auto-recall
 * call based on the profile's auto_recall setting.
 */

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
 * Returns true if auto-recall should be skipped for this message.
 *
 * Conservative by design — only skips messages with zero informational content.
 * A false positive (unnecessary recall) is cheap; a false negative (missed context) is harmful.
 */
export function shouldSkipRecall(mode: AutoRecallMode, message: string): boolean {
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

  const lower = trimmed.toLowerCase();
  if (GREETING_ACK_SET.has(lower)) return true;
  if (CONTINUATION_SET.has(lower)) return true;

  return false;
}
