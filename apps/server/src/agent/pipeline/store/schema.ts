import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { conversations, users } from "../../store/schema.js";
import { GateResolutionSchema, StageOutputsSchema } from "../run-types.js";
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
 * up front, so admission control (`queued`) and DB-parked waits
 * (`waiting_event`) need no `ALTER TYPE ADD VALUE`; neither is set yet. `waiting_gate` is the parked state of a gate
 * checkpoint: the stage runner sets it and returns, and the run leaves it
 * only through `pipeline-gate-resolver` — no Inngest function stays in
 * flight across the wait except the small timeout waiter.
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
 * Why a run ended (design/pipelines.md → Run lifecycle). A `failed` run
 * carries one of the first group, a `cancelled` run one of the second;
 * `chk_pipeline_runs_failure_reason_by_status` holds the pairing, and
 * `failure_detail` carries the variable part (an error class, a validation
 * message) when the reason has one.
 */
export const PIPELINE_RUN_FAILED_REASONS = [
  "stage_error",
  "unknown_stage",
  "unsupported_stage",
  "turn_degraded",
  "turn_truncated",
  "artifact_invalid",
  "gate_resolution_error",
] as const;

export const PIPELINE_RUN_CANCELLED_REASONS = ["cancelled_by_user", "gate_timeout"] as const;

export const pipelineRunFailureReason = pgEnum("pipeline_run_failure_reason", [
  ...PIPELINE_RUN_FAILED_REASONS,
  ...PIPELINE_RUN_CANCELLED_REASONS,
]);

/**
 * One pipeline run — the source of truth for an in-flight execution. The
 * pinned `definition_id` carries the stages (in its `compiled` blob) and the
 * owning `user_id`, so no `user_id` is denormalized here (design/pipelines.md
 * → Data Model). `wait_key` / `wait_deadline` arrive with DB-parked `wait`
 * stages; a gate's deadline lives in its waiter's `step.sleep`, so gates
 * need neither column.
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
    // Loop counter for `current_stage`'s loop scope. Always 0 while loops are
    // unsupported; part of the `pipeline/stage.due` cursor.
    iteration: integer("iteration").notNull(),
    stageOutputs: jsonbZod("stage_outputs", StageOutputsSchema).notNull(),
    // Set with the terminal flip to `failed` / `cancelled`, null in every
    // other status (`chk_pipeline_runs_failure_reason_by_status`).
    failureReason: pipelineRunFailureReason("failure_reason"),
    failureDetail: text("failure_detail"),
    // Which resolution claimed the run's most recent gate. Nullable: a run
    // that hasn't resolved a gate yet has no claim. The claim outlives the
    // gate — it stays while the run moves on, and through a later park — but
    // a run parked on a gate never holds the claim on that gate
    // (`chk_pipeline_runs_parked_gate_unclaimed`).
    gateResolution: jsonbZod("gate_resolution", GateResolutionSchema),
    // Caller-supplied key for `start_pipeline`'s durable tool step — the
    // `ToolCallContext.idempotencyKey` of the call that opened the run.
    // Nullable: a run opened without a retrying context carries none, and
    // Postgres treats nulls as distinct under a plain UNIQUE.
    idempotencyKey: text("idempotency_key"),
    createdAt: ts(),
  },
  (t) => [
    unique("uniq_pipeline_runs_idempotency_key").on(t.idempotencyKey),
    check(
      "chk_pipeline_runs_failure_reason_by_status",
      sql`CASE ${t.status} WHEN 'failed' THEN ${t.failureReason} IS NOT NULL AND ${t.failureReason} IN (${enumLiterals(PIPELINE_RUN_FAILED_REASONS)}) WHEN 'cancelled' THEN ${t.failureReason} IS NOT NULL AND ${t.failureReason} IN (${enumLiterals(PIPELINE_RUN_CANCELLED_REASONS)}) ELSE ${t.failureReason} IS NULL AND ${t.failureDetail} IS NULL END`,
    ),
    check(
      "chk_pipeline_runs_parked_gate_unclaimed",
      sql`${t.status} <> 'waiting_gate' OR ${t.gateResolution} IS NULL OR (${t.gateResolution} ->> 'gateKey') <> (${t.id}::text || ':' || ${t.currentStage} || ':' || ${t.iteration}::text)`,
    ),
  ],
);

/** The enum labels as a SQL literal list — our own constants, so raw is safe. */
function enumLiterals(values: ReadonlyArray<string>) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}
