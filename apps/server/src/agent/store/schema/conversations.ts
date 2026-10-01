import { desc, sql } from "drizzle-orm";
import { boolean, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { profiles, voiceMode } from "./profiles.js";
import { users } from "./users.js";

/**
 * Zod schema for `conversations.cooldown_state`. The column's column
 * comment carries the lifecycle and atomicity contract; see also
 * `design/agent-resilience.md` → Auto-repair.
 */
export const CooldownStateSchema = z.object({
  lastErroredAt: z.string().datetime({ offset: true }),
  cooldownSeconds: z.number().int().positive(),
  consecutiveFailures: z.number().int().positive(),
});
export type CooldownState = z.infer<typeof CooldownStateSchema>;

export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    isPrivate: boolean("is_private").notNull(),
    /**
     * Conversation-level circuit-breaker state. Set by
     * `recover-conversation` after `handle-message` exhausts retries;
     * cleared on the first successful turn past the cooldown threshold,
     * by `/repair`, or by `/model` / `/profile` switches.
     * `handle-message`'s entry guard reads this column and returns a
     * terse in-cooldown reply (without invoking the LLM) while
     * `now() < lastErroredAt + cooldownSeconds`.
     *
     * Atomic by construction — either `NULL` (CLOSED state) or all
     * three blob fields populated (OPEN state). `consecutiveFailures`
     * is stored rather than derived because `cooldownSeconds` collapses
     * to a constant past the 1h cap and the failure counter is the
     * most useful chronic-failure telemetry signal. See
     * `design/agent-resilience.md` → Auto-repair.
     */
    cooldownState: jsonbZod("cooldown_state", CooldownStateSchema),
    /**
     * Per-conversation voice mode override. NULL = follow profile default.
     * The conversation override is what `/voice` mutates; clearing it
     * (`/voice clear`) restores profile-level behaviour.
     */
    voiceMode: voiceMode("voice_mode"),
    createdAt: ts(),
  },
  (t) => [
    index("idx_conversations_profile_id").on(t.profileId),
    // Covers `findMostRecentConversationForUserProfile`'s filter on
    // (user_id, profile_id) restricted to private conversations,
    // ordered by id DESC. UUIDv7 makes `id DESC` a proxy for
    // created_at DESC, so the index can serve the order as well.
    index("idx_conversations_user_profile_private_id")
      .on(t.userId, t.profileId, desc(t.id))
      .where(sql`is_private = true`),
  ],
);

export const aliases = pgTable(
  "aliases",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id)
      .unique(),
    alias: text("alias").notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_aliases_user_alias").on(t.userId, t.alias)],
);
