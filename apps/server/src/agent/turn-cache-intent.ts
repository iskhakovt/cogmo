/**
 * The cache intent for one agent turn's transcript, keyed by its conversation.
 *
 * Chat turns retain for an hour: the system prompt and the transcript are
 * stable across turns, so the next turn reads this one's cache, and a reply
 * gap of five minutes to an hour outlives a 5-minute entry.
 *
 * Pipeline stage turns retain for five minutes. A stage narrows `tools` and
 * `# Tools` to its allowlist, so the chat turns of its run conversation don't
 * share its prefix, and the reply-gap reads a 1-hour entry is bought for
 * don't happen. Stage turns take the chat intent once they send the
 * conversation's tool definitions (design/prompt-caching.md → One Prefix per
 * Conversation, → Retention).
 */

import type { CacheIntent } from "../llm/types.js";

export function turnCacheIntent(conversationId: string, turn: "chat" | "stage"): CacheIntent {
  return { key: conversationId, retention: turn === "chat" ? "long" : "short" };
}
