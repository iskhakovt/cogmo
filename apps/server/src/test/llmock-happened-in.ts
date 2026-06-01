/**
 * Date-normalizer for the llmock matcher, kept here (under `src/`, so it's
 * tsc-checked + unit-testable) and imported by the harness in
 * `test/llmock-setup.ts`.
 *
 * Hindsight stamps each extracted fact with a "(happened in <Month> <Year>)"
 * temporal suffix derived from the *current* date before embedding it, so a
 * fixture recorded one month replay-mismatches the next (the month rolls over).
 * Collapsing the month/year to a stable token keeps record/replay matching
 * stable across a calendar boundary, on both the chat and embedding paths.
 *
 * `/g` replaces every occurrence (a chat prompt can batch several facts); it's
 * only ever used via `.replace()`, which doesn't carry `lastIndex` across calls
 * — don't switch a call site to `.test()` / `.exec()` on this shared instance
 * without resetting `lastIndex` first.
 */
export const HAPPENED_IN_RE =
  /\(happened in (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\)/g;

export function normalizeHappenedIn(text: string | undefined): string | undefined {
  return text?.replace(HAPPENED_IN_RE, "(happened in [WHEN])");
}
