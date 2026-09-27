/**
 * A turn's cache intent, keyed by its conversation: 1-hour for chat turns,
 * 5-minute for stage turns until they share the chat prefix
 * (design/prompt-caching.md → Retention).
 */

import type { CacheIntent } from "../llm/types.js";

export function turnCacheIntent(conversationId: string, turn: "chat" | "stage"): CacheIntent {
  return { key: conversationId, retention: turn === "chat" ? "long" : "short" };
}
