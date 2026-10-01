import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { profiles } from "./profiles.js";
import { users } from "./users.js";

/**
 * `scheduled_tasks.kind` — recurrence discriminator. `recurring` rows carry a
 * non-null `cron` and re-advance `next_run_at` on every fire. `one_off` rows
 * carry `cron IS NULL` and flip `enabled = false` after firing (no second
 * fire). One-offs ≤1y typically skip the table entirely via
 * `inngest.send({ ts })`; this kind is for >1y delays or one-shots the agent
 * wants to inspect/cancel before they fire. See design/scheduling.md.
 */
export const scheduleKind = pgEnum("schedule_kind", ["recurring", "one_off"]);
export type ScheduleKindValue = (typeof scheduleKind.enumValues)[number];

/**
 * `scheduled_tasks.source` — authorship of the row. `agent` = an LLM tool
 * call (`schedule_task`); `wizard` = setup wizard's recurring-tasks step;
 * `manual` = direct psql / admin CLI insert. Used for audit, rate limits
 * per source, and UI grouping in `/schedules`.
 */
export const scheduleSource = pgEnum("schedule_source", ["agent", "wizard", "manual"]);
export type ScheduleSourceValue = (typeof scheduleSource.enumValues)[number];

/**
 * User/agent-defined scheduled tasks. Source of truth for the
 * `schedule_task` / `list_tasks` / `remove_task` agent tools, the setup
 * wizard's recurring-tasks step (morning briefing and friends), and any
 * ingestion polling. The 1-min ticker (`scheduled-task-ticker` Inngest
 * function) reads this table with `FOR UPDATE SKIP LOCKED`, fans out one
 * `agent/scheduled-task.fire` event per due row with idempotency key
 * `${id}:${next_run_at.toISOString()}`, and advances `next_run_at` in the
 * same tx. See design/scheduling.md → Agent Self-Scheduling.
 *
 * `cron` is nullable: required for `kind='recurring'`, must be NULL for
 * `kind='one_off'`. The CHECK below pins this at the DB layer using
 * per-value implications (same shape as `image_providers.base_url`) so a
 * future third kind doesn't have to rewrite the constraint.
 *
 * `timezone` is an IANA tz string (e.g. `Europe/London`) — validated at the
 * tool boundary via `croner` + `Intl.DateTimeFormat`. The schedule fires
 * anchored to that tz, so DST transitions don't drift. `next_run_at` is
 * stored in UTC like every other timestamptz.
 *
 * `catchup_missed` flips the post-outage behaviour: `false` (default at the
 * tool layer) fires once with the most recent `next_run_at` regardless of
 * how many ticks were missed; `true` backfills every missed occurrence.
 * The fire handler reads the scheduled-for timestamp out of the event so
 * the model is self-aware about lateness either way.
 */
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id), // RESTRICT — deleting a profile fails if schedules still reference it
    kind: scheduleKind("kind").notNull(),
    cron: text("cron"), // NULL for kind='one_off', NOT NULL for kind='recurring' (CHECK enforced)
    timezone: text("timezone").notNull(), // IANA tz, validated at tool boundary
    prompt: text("prompt").notNull(), // replayed as user-role message into the agent loop on fire
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }), // null = never fired
    enabled: boolean("enabled").notNull(),
    catchupMissed: boolean("catchup_missed").notNull(),
    source: scheduleSource("source").notNull(),
    // Caller-supplied deterministic-per-request token. `schedule_task` runs
    // inside a durable step, so a crash between this row committing and
    // Inngest recording the step result re-runs the body — and a duplicate
    // schedule fires forever, unlike most tool duplicates. Null for callers
    // with no retry semantics (wizard, CLI, tests); Postgres's
    // NULL-not-equal unique semantics let those coexist.
    idempotencyKey: text("idempotency_key"),
    createdAt: ts(),
  },
  (t) => [
    unique("uniq_scheduled_tasks_idempotency_key").on(t.idempotencyKey),
    // Hot path: ticker `WHERE enabled AND next_run_at <= now() ORDER BY next_run_at`.
    index("idx_scheduled_tasks_due").on(t.enabled, t.nextRunAt),
    // List path: `/schedules` and `list_tasks` filter by user.
    index("idx_scheduled_tasks_user").on(t.userId, t.createdAt),
    check(
      "chk_scheduled_tasks_cron",
      // Per-value implications: each clause says "if kind = X then cron
      // satisfies Y." Adding a third kind is unconstrained until its own
      // clause is added — same convention as `image_providers.base_url`.
      sql`(${t.kind} <> 'recurring' OR ${t.cron} IS NOT NULL) AND (${t.kind} <> 'one_off' OR ${t.cron} IS NULL)`,
    ),
  ],
);
