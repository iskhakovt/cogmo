/**
 * The cache intent for one agent turn's transcript. Shared by `handle-message`
 * and the pipeline stage turn, which alternate in a run conversation and so
 * must cache it the same way.
 *
 * Long retention: the system prompt and the transcript are stable across
 * turns, so the next turn reads this one's cache, and a reply gap of five
 * minutes to an hour outlives a 5-minute entry (see
 * design/prompt-caching.md → Retention).
 */

import type { CacheIntent } from "../llm/types.js";

export function turnCacheIntent(conversationId: string): CacheIntent {
  return { key: conversationId, retention: "long" };
}
