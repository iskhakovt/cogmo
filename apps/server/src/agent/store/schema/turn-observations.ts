import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { conversations } from "./conversations.js";

/**
 * What wrote a turn's rows, read once from the cursor's
 * `inbound_messages.source` when the turn is discovered: a `user` inbound, or
 * none, is a `chat` turn.
 */
export const turnKind = pgEnum("turn_kind", ["chat", "scheduled", "pipeline"]);
export type TurnKindValue = (typeof turnKind.enumValues)[number];

/** Which extraction a `turn_observations` row tracks; one row per turn and phase. */
export const observationPhase = pgEnum("observation_phase", ["corrections"]);
export type ObservationPhaseValue = (typeof observationPhase.enumValues)[number];

/**
 * Where a turn's phase is (design/observation.md → Slice 1a). `pending` waits
 * for an extraction; `applied`, `failed` and `skipped` are terminal.
 */
export const observationStatus = pgEnum("observation_status", [
  "pending",
  "applied",
  "failed",
  "skipped",
]);
export type ObservationStatusValue = (typeof observationStatus.enumValues)[number];

/**
 * Why a row is `skipped`: a scheduled or pipeline turn's prompt is not the
 * user's speech; a turn with no user text has nothing a correction can quote;
 * `backfilled` and `aged_out` are written only by the migration that created
 * the table, for turns the transcript-era Observer read and for turns older
 * than 30 days.
 */
export const observationSkipReason = pgEnum("observation_skip_reason", [
  "not_user_speech",
  "empty",
  "backfilled",
  "aged_out",
]);
export type ObservationSkipReasonValue = (typeof observationSkipReason.enumValues)[number];

/**
 * The last failure counted against a row's extraction: one the turn caused,
 * or `exhausted`, a step that failed after its retries with something thrown
 * outside the extraction (loading or applying the turn), counted so a turn
 * that keeps throwing is given up.
 */
export const observationFailureKind = pgEnum("observation_failure_kind", [
  "context_overflow",
  "refusal",
  "output_cut_off",
  "parse",
  "exhausted",
]);
export type ObservationFailureKindValue = (typeof observationFailureKind.enumValues)[number];

/**
 * One row per turn and phase: the Observer's durable cursor through a
 * conversation. A turn is `(conversation_id, turn_cursor)`, its rows' shared
 * `messages.last_inbound_message_id`; discovery inserts the row once the turn
 * is answered, and every write the extraction makes commits with the row's
 * transition out of `pending`. See design/observation.md → Slice 1a.
 */
export const turnObservations = pgTable(
  "turn_observations",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    // Not a foreign key: `messages.last_inbound_message_id` never referenced
    // `inbound_messages` either.
    turnCursor: uuid("turn_cursor").notNull(),
    turnKind: turnKind("turn_kind").notNull(),
    phase: observationPhase("phase").notNull(),
    status: observationStatus("status").notNull(),
    // Set exactly when `status = 'skipped'`.
    skipReason: observationSkipReason("skip_reason"),
    // Turn-caused failed attempts.
    attempts: integer("attempts").notNull(),
    // The last turn-caused failure; set exactly when `attempts > 0`.
    failureKind: observationFailureKind("failure_kind"),
    // Its message; set exactly when `failure_kind` is.
    failureMessage: text("failure_message"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdAt: ts(),
  },
  (t) => [
    unique("uq_turn_observations_turn_phase").on(t.conversationId, t.turnCursor, t.phase),
    // The plan's read: a conversation's pending turns of a phase.
    index("idx_turn_observations_pending")
      .on(t.conversationId, t.phase)
      .where(sql`status = 'pending'`),
    check(
      "chk_turn_observations_state",
      sql`((${t.status} = 'skipped') = (${t.skipReason} IS NOT NULL))
        AND ((${t.attempts} > 0) = (${t.failureKind} IS NOT NULL))
        AND ((${t.failureKind} IS NULL) = (${t.failureMessage} IS NULL))
        AND (${t.status} <> 'failed' OR ${t.attempts} > 0)
        AND (${t.skipReason} <> 'not_user_speech' OR ${t.turnKind} <> 'chat')`,
    ),
  ],
);
