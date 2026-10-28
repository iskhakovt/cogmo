/**
 * Migration 0076 moves `pipeline_runs.failure_reason` from free text to the
 * `pipeline_run_failure_reason` enum in one transaction: create the type, add
 * `failure_detail`, copy each recorded text into the detail and rewrite it to
 * the label its writer's message shape maps to, cast the column, add the
 * CHECKs. Runs the raw SQL against PGlite over rows in the pre-migration
 * shape (the pushed schema reverted to a bare `text` column), one row per
 * message shape the writers produced, and over a row the file must reject.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzlePipelineStore } from "../agent/pipeline/store/index.js";
import { validPipelineDefinition } from "../agent/pipeline/test-fixtures.js";
import { seedConversation } from "../test/agent-store-fixtures.js";
import { expectDefined, expectSqlState } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0076_pipeline_run_failure_reason.sql", import.meta.url)),
  "utf8",
);

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const ReasonRowsSchema = z.object({
  rows: z.array(
    z.object({ id: z.string(), reason: z.string().nullable(), detail: z.string().nullable() }),
  ),
});
const TextRowsSchema = z.object({ rows: z.array(z.object({ text: z.string().nullable() })) });
const ColumnRowsSchema = z.object({
  rows: z.array(z.object({ column_name: z.string(), data_type: z.string() })),
});

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const defStore = new DrizzlePipelineStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(
    sql`ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS chk_pipeline_runs_failure_reason_by_status`,
  );
  await db.execute(
    sql`ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS chk_pipeline_runs_parked_gate_unclaimed`,
  );
  await db.execute(sql`ALTER TABLE pipeline_runs ALTER COLUMN failure_reason TYPE text`);
  await db.execute(sql`ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS failure_detail`);
  await db.execute(sql`DROP TYPE IF EXISTS pipeline_run_failure_reason`);
});

afterAll(async () => {
  await close();
});

/** The file as `migratePerFile` runs it: every statement in one transaction. */
async function applyMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.transaction(async (trx) => {
    for (const stmt of statements) {
      await trx.execute(sql.raw(stmt));
    }
  });
}

async function seedDefinition(): Promise<{ definitionId: string; conversationId: string }> {
  const { userId, conversationId } = await seedConversation(tx);
  const def = await tx((trx) =>
    defStore.insertDefinition(trx, {
      userId,
      name: "issue-to-pr",
      sourceText: "source",
      compiled: validPipelineDefinition(),
    }),
  );
  return { definitionId: def.id, conversationId };
}

async function insertRun(
  seeded: { definitionId: string; conversationId: string },
  status: string,
  reason: string | null,
  gateResolution: string | null = null,
): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO pipeline_runs
        (definition_id, conversation_id, status, current_stage, iteration, stage_outputs, failure_reason, gate_resolution)
      VALUES
        (${seeded.definitionId}, ${seeded.conversationId}, ${status}::pipeline_run_status, 'gather-context', 0, '{}'::jsonb, ${reason}, ${gateResolution}::jsonb)
      RETURNING id
    `),
  );
  return expectDefined(rows[0], "inserted row").id;
}

async function reasonsById(): Promise<
  Record<string, { reason: string | null; detail: string | null }>
> {
  const { rows } = ReasonRowsSchema.parse(
    await db.execute(
      sql`SELECT id, failure_reason::text AS reason, failure_detail AS detail FROM pipeline_runs`,
    ),
  );
  return Object.fromEntries(rows.map((r) => [r.id, { reason: r.reason, detail: r.detail }]));
}

async function failureColumns(): Promise<Record<string, string>> {
  const { rows } = ColumnRowsSchema.parse(
    await db.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name IN ('failure_reason', 'failure_detail')
    `),
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
}

/** Every message shape a writer produced, with the label it maps to. */
const WRITTEN_REASONS = [
  ["failed", 'stage "draft" failed (TypeError)', "stage_error"],
  ["failed", 'stage "draft" is not in the pinned definition', "unknown_stage"],
  ["failed", "wait stages are not supported yet", "unsupported_stage"],
  ["failed", "the stage's agent turn could not finish (iteration_cap)", "turn_degraded"],
  ["failed", "the stage's reply was cut off at the model's output limit", "turn_truncated"],
  [
    "failed",
    "the stage's result did not match its declared output: /title is required",
    "artifact_invalid",
  ],
  ["failed", "gate timeout could not be applied (TypeError)", "gate_resolution_error"],
  ["cancelled", 'cancelled by the user at gate "approve"', "cancelled_by_user"],
  ["cancelled", 'gate "approve" timed out', "gate_timeout"],
] as const;

describe("migration 0076 — pipeline_runs.failure_reason enum", () => {
  it("maps every written reason onto its label and keeps the text as the detail", async () => {
    const seeded = await seedDefinition();
    const ids = await Promise.all(
      WRITTEN_REASONS.map(([status, text]) => insertRun(seeded, status, text)),
    );

    await applyMigration();

    const after = await reasonsById();
    expect(ids.map((id) => after[id])).toEqual(
      WRITTEN_REASONS.map(([, text, label]) => ({ reason: label, detail: text })),
    );
  });

  it("gives a text no writer produced its status's generic reason, and a terminal row without one too", async () => {
    const seeded = await seedDefinition();
    const unknownFailed = await insertRun(seeded, "failed", "something else entirely");
    const unknownCancelled = await insertRun(seeded, "cancelled", "operator stopped it");
    const bareFailed = await insertRun(seeded, "failed", null);
    const bareCancelled = await insertRun(seeded, "cancelled", null);

    await applyMigration();

    expect(await reasonsById()).toEqual({
      [unknownFailed]: { reason: "stage_error", detail: "something else entirely" },
      [unknownCancelled]: { reason: "cancelled_by_user", detail: "operator stopped it" },
      [bareFailed]: { reason: "stage_error", detail: null },
      [bareCancelled]: { reason: "cancelled_by_user", detail: null },
    });
  });

  it("clears a reason from a run that is still moving and leaves the rest null", async () => {
    const seeded = await seedDefinition();
    const movingWithReason = await insertRun(seeded, "running", "stale text");
    const parked = await insertRun(seeded, "waiting_gate", null);
    const completed = await insertRun(seeded, "completed", null);

    await applyMigration();

    expect(await reasonsById()).toEqual({
      [movingWithReason]: { reason: null, detail: null },
      [parked]: { reason: null, detail: null },
      [completed]: { reason: null, detail: null },
    });
  });

  it("then holds both CHECKs the backfill satisfied", async () => {
    const seeded = await seedDefinition();
    const running = await insertRun(seeded, "running", null);
    const failed = await insertRun(seeded, "failed", 'stage "draft" failed (TypeError)');
    await applyMigration();

    const rejected = (statement: Promise<unknown>) =>
      statement.then(
        () => null,
        (error: unknown) => error,
      );
    expectSqlState(
      await rejected(
        db.execute(
          sql`UPDATE pipeline_runs SET failure_reason = 'stage_error' WHERE id = ${running}`,
        ),
      ),
      "23514",
    );
    expectSqlState(
      await rejected(
        db.execute(
          sql`UPDATE pipeline_runs SET failure_reason = 'cancelled_by_user' WHERE id = ${failed}`,
        ),
      ),
      "23514",
    );
    const ownClaim = JSON.stringify({ gateKey: `${running}:gather-context:0`, resolverRunId: "r" });
    expectSqlState(
      await rejected(
        db.execute(
          sql`UPDATE pipeline_runs SET status = 'waiting_gate', gate_resolution = ${ownClaim}::jsonb WHERE id = ${running}`,
        ),
      ),
      "23514",
    );
  });

  it("rolls the whole file back on a row it cannot constrain, and applies once the row is fixed", async () => {
    // Every reason text maps, so the only row the file rejects is one the
    // gate CHECK refuses: parked on a gate while holding that gate's claim.
    const seeded = await seedDefinition();
    const mapped = await insertRun(seeded, "failed", 'gate "approve" timed out');
    const parkedWithOwnClaim = await insertRun(seeded, "waiting_gate", null, "{}");
    await db.execute(sql`
      UPDATE pipeline_runs
      SET gate_resolution = jsonb_build_object('gateKey', id::text || ':gather-context:0', 'resolverRunId', 'r-1')
      WHERE id = ${parkedWithOwnClaim}
    `);

    const failure = await applyMigration().then(
      () => null,
      (error: unknown) => error,
    );

    expectSqlState(failure, "23514");
    expect(await failureColumns()).toEqual({ failure_reason: "text" });
    const { rows: untouched } = TextRowsSchema.parse(
      await db.execute(sql`SELECT failure_reason AS text FROM pipeline_runs WHERE id = ${mapped}`),
    );
    expect(untouched).toEqual([{ text: 'gate "approve" timed out' }]);

    await db.execute(
      sql`UPDATE pipeline_runs SET gate_resolution = NULL WHERE id = ${parkedWithOwnClaim}`,
    );
    await applyMigration();
    expect(await failureColumns()).toEqual({
      failure_reason: "USER-DEFINED",
      failure_detail: "text",
    });
    expect((await reasonsById())[mapped]).toEqual({
      reason: "stage_error",
      detail: 'gate "approve" timed out',
    });
  });
});
