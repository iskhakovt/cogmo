import { sql } from "drizzle-orm";
import { boolean, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { conversations, users } from "../../store/schema.js";
import { StageOutputsSchema } from "../run-types.js";
import { PipelineDefinitionSchema } from "../types.js";

/**
 * Versioned user-defined pipeline definitions (design/pipelines.md → Data
 * Model). Rows are immutable in every column except `active` — activation
 * is a status transition, like `coding_tasks.status`. The user's free text
 * is the editable source; editing recompiles into a new version row.
 */
export const pipelineDefinitions = pgTable(
  "pipeline_definitions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    sourceText: text("source_text").notNull(),
    compiled: jsonbZod("compiled", PipelineDefinitionSchema).notNull(),
    active: boolean("active").notNull(),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex("uq_pipeline_definitions_version").on(t.userId, t.name, t.version),
    // At most one active version per (user, name) — activation flips the
    // old version off and the new one on in a single tx, deactivate-then-
    // activate so this index holds throughout.
    uniqueIndex("uq_pipeline_definitions_active").on(t.userId, t.name).where(sql`active = true`),
  ],
);

/**
 * Run status (design/pipelines.md → Data Model). The full set is declared
 * up front so slice 3 doesn't pay an `ALTER TYPE ADD VALUE` migration:
 * `queued` (admission control) and `waiting_event` (external-event waits)
 * are unused until then. `waiting_gate` IS used — the stage runner posts
 * the gate prompt, flips the run to it, and ends; the user's approval
 * arrives as a fresh event, so no function stays in flight and the parked
 * gate is queryable without going through Inngest.
 */
export const pipelineRunStatus = pgEnum("pipeline_run_status", [
  "queued",
  "running",
  "waiting_gate",
  "waiting_event",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * One pipeline run — the source of truth for an in-flight execution. The
 * pinned `definition_id` carries the stages (in its `compiled` blob) and the
 * owning `user_id`, so no `user_id` is denormalized here (design/pipelines.md
 * → Data Model). `wait_key` / `wait_deadline` arrive with slice 3's
 * external-event `wait` stages; a gate parks on `status = 'waiting_gate'`
 * alone, since the resume event names the run.
 */
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: pk(),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => pipelineDefinitions.id),
    // The run's own conversation — gates and progress land here. A run always
    // owns one (NOT NULL), created at run start; same agent-store module, so a
    // real FK gives referential integrity for free.
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    status: pipelineRunStatus("status").notNull(),
    // Stage id from the pinned definition the run currently sits on.
    currentStage: text("current_stage").notNull(),
    // Which pass the run is on through `current_stage`. Monotonic: forward
    // moves carry it, backward moves (a gate's revise today, loop back-edges
    // in slice 3) increment it. Part of the run's cursor, so every event the
    // engine acts on names it.
    iteration: integer("iteration").notNull(),
    stageOutputs: jsonbZod("stage_outputs", StageOutputsSchema).notNull(),
    failureReason: text("failure_reason"),
    createdAt: ts(),
  },
  (t) => [
    // One live run per conversation. The run supervises that conversation's
    // turns (stage instructions arrive as synthetic inbounds, and
    // `handle-message` scopes the turn's tools to the current stage), so a
    // second concurrent run would give one conversation two cursors and two
    // competing tool allowlists. Partial on the non-terminal statuses, so a
    // finished run never blocks the next one.
    uniqueIndex("uq_pipeline_runs_active_conversation")
      .on(t.conversationId)
      .where(sql`status NOT IN ('completed', 'failed', 'cancelled')`),
  ],
);
