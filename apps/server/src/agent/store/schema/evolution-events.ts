import { desc } from "drizzle-orm";
import { index, pgEnum, pgTable, uuid } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { EvolutionEventPayloadSchema } from "../../evolution/event-schema.js";
import { conversations } from "./conversations.js";
import { users } from "./users.js";

/**
 * `evolution_events.triggered_by` — discriminates the autonomous idle fire
 * from a `/reflect`-driven manual run. Used by `/learned` to surface the
 * source in the digest and detail views.
 */
export const evolutionTrigger = pgEnum("evolution_trigger", ["idle", "manual"]);
export type EvolutionTriggerValue = (typeof evolutionTrigger.enumValues)[number];

/**
 * Append-only audit log — one row per processed Observer fire. Source of
 * truth for the `/learned` digest and the `/reflect` reply. `skipped` fires
 * (conversation not found, profile not found, too_short) earn no row — there
 * is nothing to surface for those.
 *
 * `user_id` is denormalised from `conversations.user_id`. The `/learned`
 * digest scans by user; conversations is large, and the conversation→user
 * mapping is immutable, so the denormalisation can't drift. `payload` carries
 * the structured ObserverResult and is validated on read+write by
 * `EvolutionEventPayloadSchema`.
 *
 * No `outcome` / `superseded_at` columns yet — undo and per-rule revert are
 * deliberately deferred (see `design/evolution.md` → Audit Log & Manual
 * Trigger). When they land, follow the DGM pattern: append a reverse-event
 * row, never mutate the original.
 */
export const evolutionEvents = pgTable(
  "evolution_events",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    triggeredBy: evolutionTrigger("triggered_by").notNull(),
    payload: jsonbZod("payload", EvolutionEventPayloadSchema).notNull(),
    createdAt: ts(),
  },
  (t) => [
    // Digest path: `/learned` lists newest-first per user.
    index("idx_evolution_events_user").on(t.userId, desc(t.createdAt)),
  ],
);
