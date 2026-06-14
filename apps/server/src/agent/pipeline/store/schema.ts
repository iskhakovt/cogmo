import { sql } from "drizzle-orm";
import { boolean, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { users } from "../../store/schema.js";
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
 * `queued` (admission control) and `waiting_event` (DB-parked waits) are
 * unused until then. `waiting_gate` IS used in slice 2 — set before the
 * stage runner's `step.waitForEvent` so a parked gate is queryable for
 * `/status` without going through Inngest.
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
 * → Data Model). `wait_key` / `wait_deadline` arrive with slice 3's DB-parked
 * `wait` stages; slice 2 gates park inside Inngest, not the DB.
 */
export const pipelineRuns = pgTable("pipeline_runs", {
  id: pk(),
  definitionId: uuid("definition_id")
    .notNull()
    .references(() => pipelineDefinitions.id),
  // The run's own conversation — gates and progress land here. Informational
  // link, not an FK: a run's history outlives its conversation, and the
  // conversation lives in the agent store with an independent lifecycle (same
  // choice as `coding_tasks.conversation_id`).
  conversationId: uuid("conversation_id").notNull(),
  status: pipelineRunStatus("status").notNull(),
  // Stage id from the pinned definition the run currently sits on.
  currentStage: text("current_stage").notNull(),
  // Loop counter for `current_stage`'s loop scope. Always 0 until slice 3
  // back-edges land; carried now because `pipeline/stage.due` keys off it.
  iteration: integer("iteration").notNull(),
  stageOutputs: jsonbZod("stage_outputs", StageOutputsSchema).notNull(),
  failureReason: text("failure_reason"),
  createdAt: ts(),
});
