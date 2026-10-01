import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { profiles } from "./profiles.js";
import { users } from "./users.js";

/**
 * Who staged a `pending_memories` row: the agent's `memory_retain`
 * (`live_retain`), the untagged-memory backfill (`migration`), or a skill's
 * `ctx.memory.remember` (`skill`). The drain copies it into Hindsight's
 * `metadata.source`.
 */
export const pendingMemorySource = pgEnum("pending_memory_source", [
  "live_retain",
  "migration",
  "skill",
]);

/**
 * Memory writes awaiting Observer classification before retention to
 * Hindsight. User-scoped (not conversation-scoped) so /reset doesn't
 * destroy pending rows; drain on any subsequent conversation/idle.
 *
 * `profile_id` snapshots the profile that staged the row so the drain
 * can stamp the correct `profile_class:<class>` tag at retain time —
 * without it, a row staged by profile A but drained by an idle on a
 * profile B conversation would be tagged with B's class and leak across
 * the speaker-isolation boundary. Nullable because migration-sourced
 * rows (`source: "migration"`) and any pre-existing live retains have
 * no staging-time profile lineage. `ON DELETE SET NULL` so deleting a
 * profile doesn't cascade-destroy the user's pending writes — the row
 * just loses its class lineage and drains untagged on that dimension.
 *
 * `skill_name` names the skill that staged a `skill` row, and is null on
 * every other source; the drain writes it to Hindsight's `metadata.skill`.
 * A snapshot, not a FK: the row outlives the skill.
 */
export const pendingMemories = pgTable(
  "pending_memories",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    profileId: uuid("profile_id").references(() => profiles.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    context: text("context"),
    source: pendingMemorySource("source").notNull(),
    skillName: text("skill_name"),
    createdAt: ts(),
  },
  (t) => [
    index("idx_pending_memories_user").on(t.userId, t.createdAt),
    check(
      "chk_pending_memories_skill_name",
      sql`(${t.source} = 'skill') = (${t.skillName} IS NOT NULL)`,
    ),
  ],
);
