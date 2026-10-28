/**
 * Migrations 0076–0078 move `pipeline_runs.failure_reason` from free text to
 * the `pipeline_run_failure_reason` enum: 0076 creates the type and adds
 * `failure_detail`, 0077 copies each text into the detail and rewrites it to
 * the label its writer's message shape maps to, 0078 casts the column and
 * adds the CHECKs. Runs the three files' raw SQL against PGlite over rows in
 * the pre-migration shape (the pushed schema reverted to a bare `text`
 * column), one row per message shape the writers produced.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzlePipelineStore } from "../agent/pipeline/store/index.js";
import { validPipelineDefinition } from "../agent/pipeline/test-fixtures.js";
import { seedConversation } from "../test/agent-store-fixtures.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";
import { findPgErrorByCode } from "./pg-errors.js";

async function migrationSql(file: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}
const ADD_TYPE_SQL = await migrationSql("0076_pipeline_run_failure_reason_enum.sql");
const BACKFILL_SQL = await migrationSql("0077_pipeline_run_failure_reason_backfill.sql");
const CAST_AND_CHECK_SQL = await migrationSql("0078_pipeline_run_failure_reason_checks.sql");

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const ReasonRowsSchema = z.object({
  rows: z.array(
    z.object({ id: z.string(), reason: z.string().nullable(), detail: z.string().nullable() }),
  ),
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

async function apply(migration: string): Promise<void> {
  const statements = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

async function applyAll(): Promise<void> {
  await apply(ADD_TYPE_SQL);
  await apply(BACKFILL_SQL);
  await apply(CAST_AND_CHECK_SQL);
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
): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO pipeline_runs
        (definition_id, conversation_id, status, current_stage, iteration, stage_outputs, failure_reason)
      VALUES
        (${seeded.definitionId}, ${seeded.conversationId}, ${status}::pipeline_run_status, 'gather-context', 0, '{}'::jsonb, ${reason})
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

describe("migrations 0076–0078 — pipeline_runs.failure_reason enum", () => {
  it("maps every written reason onto its label and keeps the text as the detail", async () => {
    const seeded = await seedDefinition();
    const ids = await Promise.all(
      WRITTEN_REASONS.map(([status, text]) => insertRun(seeded, status, text)),
    );

    await applyAll();

    const after = await reasonsById();
    for (const [index, [, text, label]] of WRITTEN_REASONS.entries()) {
      expect(after[expectDefined(ids[index], "run id")]).toEqual({ reason: label, detail: text });
    }
  });

  it("gives a text no writer produced its status's generic reason, and a terminal row without one too", async () => {
    const seeded = await seedDefinition();
    const unknownFailed = await insertRun(seeded, "failed", "something else entirely");
    const unknownCancelled = await insertRun(seeded, "cancelled", "operator stopped it");
    const bareFailed = await insertRun(seeded, "failed", null);
    const bareCancelled = await insertRun(seeded, "cancelled", null);

    await applyAll();

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

    await applyAll();

    expect(await reasonsById()).toEqual({
      [movingWithReason]: { reason: null, detail: null },
      [parked]: { reason: null, detail: null },
      [completed]: { reason: null, detail: null },
    });
  });

  it("then holds the CHECK the backfill satisfied", async () => {
    const seeded = await seedDefinition();
    const running = await insertRun(seeded, "running", null);
    await applyAll();

    const reasonWhileMoving = await db
      .execute(sql`UPDATE pipeline_runs SET failure_reason = 'stage_error' WHERE id = ${running}`)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(findPgErrorByCode(reasonWhileMoving, ["23514"])).toMatchObject({ code: "23514" });
  });
});
