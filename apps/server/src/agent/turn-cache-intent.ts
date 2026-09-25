/**
 * The cache intent for one agent turn's transcript. Shared by `handle-message`
 * and the pipeline stage turn, which alternate in a run conversation and so
 * must cache it the same way.
 *
 * Short retention: the system prompt changes between turns, so the cache is
 * read within a turn and rarely by the next one (see
 * design/prompt-caching.md → Retention).
 */

import type { CacheIntent } from "../llm/types.js";

export function turnCacheIntent(conversationId: string): CacheIntent {
  return { key: conversationId, retention: "short" };
}
