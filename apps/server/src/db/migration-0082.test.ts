/**
 * Migration 0082 adds `dispatched` to `skill_run_recovery_point`, the
 * `skill_run_error_kind` enum and the run's audit columns, backfills them,
 * and rewrites the run CHECKs, all in one transaction. Runs the raw SQL
 * against PGlite over rows in every shape a build before it wrote (the table
 * put back with `skillRunsBefore0082`): each survives with its backfill, the
 * store reads it, and once the file commits `dispatched` is usable and the
 * new CHECKs hold.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { finishedVerdictOf } from "../skills/invoke/run-result.js";
import { executedOutcomeOf } from "../skills/invoke/start-run.js";
import { DrizzleSkillStore } from "../skills/store/index.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { skillRunsBefore0082 } from "../test/skill-runs-before-0082.js";
import type { Database, Transactor } from "./index.js";
import { constraintNameOf, findPgErrorByCode } from "./pg-errors.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0082_skill_run_schema.sql", import.meta.url)),
  "utf8",
);

const USAGE = JSON.stringify({ wallClockMs: 7, peakMemoryBytes: null });
const FINISHED_AT = "2026-01-01T00:00:01.500Z";

/** A run row as a build before 0082 wrote it. */
interface LegacyRun {
  recoveryPoint: "started" | "executed" | "finished";
  status: "running" | "success" | "error";
  output: string | null;
  error: string | null;
}

const LEGACY = {
  started: { recoveryPoint: "started", status: "running", output: null, error: null },
  executedOutput: { recoveryPoint: "executed", status: "running", output: '{"n":1}', error: null },
  executedError: { recoveryPoint: "executed", status: "running", output: null, error: "boom" },
  success: { recoveryPoint: "finished", status: "success", output: '{"n":1}', error: null },
  failed: { recoveryPoint: "finished", status: "error", output: null, error: "bad output" },
} satisfies Record<string, LegacyRun>;

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSkillStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await skillRunsBefore0082(db);
});

afterAll(async () => {
  await close();
});

/** Apply the file as `migratePerFile` does: one transaction, so a failure leaves nothing of it. */
async function apply(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.transaction(async (trx) => {
    for (const stmt of statements) {
      await trx.execute(sql.raw(stmt));
    }
  });
}

function insertedId(result: unknown, label: string): string {
  return expectDefined(IdRowsSchema.parse(result).rows[0], label).id;
}

async function insertSkill(): Promise<string> {
  return insertedId(
    await db.execute(sql`
      INSERT INTO skills (name, tier, risk_tier, effects, git_sha, inputs)
      VALUES ('echo', 'wasm', 'auto', '[]'::jsonb, 'sha-1', '{}'::jsonb)
      RETURNING id
    `),
    "skill",
  );
}

async function insertLegacyRun(skillId: string, run: LegacyRun): Promise<string> {
  const started = run.recoveryPoint === "started";
  return insertedId(
    await db.execute(sql`
      INSERT INTO skill_runs (skill_id, trigger, inputs, status, output, error, resource_usage, recovery_point, finished_at)
      VALUES (${skillId}, 'cron', '{}'::jsonb, ${run.status}::skill_run_status, ${run.output}::jsonb, ${run.error},
        ${started ? null : USAGE}::jsonb, ${run.recoveryPoint}::skill_run_recovery_point,
        ${started ? null : FINISHED_AT}::timestamptz)
      RETURNING id
    `),
    run.recoveryPoint,
  );
}

/** How `write` failed: the SQLSTATE and constraint, or null when it resolved. */
async function failureOf(write: Promise<unknown>): Promise<unknown> {
  const error = await write.then(
    () => null,
    (e: unknown) => e,
  );
  if (error === null) return null;
  const pg = findPgErrorByCode(error, ["23514"]);
  return pg === null ? error : { code: pg.code, constraint: constraintNameOf(pg) };
}

describe("migration 0082 — skill run schema", () => {
  it("backfills every shipped shape, which the store then reads", async () => {
    const skillId = await insertSkill();
    const ids = Object.fromEntries(
      await Promise.all(
        Object.entries(LEGACY).map(async ([name, run]) => [
          name,
          await insertLegacyRun(skillId, run),
        ]),
      ),
    );

    await apply();

    const row = async (name: string) =>
      expectDefined(await tx((trx) => store.getRun(trx, expectDefined(ids[name], name))), name);
    const legacy = { shadow: false, gitSha: null, runAsUserId: null, runAsProfileId: null };
    expect(await row("started")).toMatchObject({
      ...legacy,
      recoveryPoint: "started",
      errorKind: null,
      deadlineAt: null,
    });
    expect(await row("executedOutput")).toMatchObject({ ...legacy, errorKind: null });
    // A worker's error an earlier build left at `executed` finishes with the legacy kind.
    expect(executedOutcomeOf(await row("executedError"))).toEqual({
      kind: "error",
      error: { kind: "unknown", message: "boom" },
    });
    expect(finishedVerdictOf(await row("success"))).toEqual({
      status: "success",
      output: { n: 1 },
    });
    expect(finishedVerdictOf(await row("failed"))).toEqual({
      status: "error",
      error: { kind: "unknown", message: "bad output" },
    });
  });

  it("then dispatched is usable, and the new CHECKs hold", async () => {
    const skillId = await insertSkill();
    const started = await insertLegacyRun(skillId, LEGACY.started);
    await apply();

    await tx((trx) =>
      store.transitionToDispatched(trx, {
        id: started,
        deadlineAt: new Date("2026-01-01T00:01:30Z"),
      }),
    );
    expect(await tx((trx) => store.getRun(trx, started))).toMatchObject({
      recoveryPoint: "dispatched",
    });

    // A run as a build after 0082 inserts it, `shadow` written.
    const fresh = insertedId(
      await db.execute(sql`
        INSERT INTO skill_runs (skill_id, trigger, inputs, status, shadow)
        VALUES (${skillId}, 'cron', '{}'::jsonb, 'running', false)
        RETURNING id
      `),
      "fresh",
    );
    expect(
      await failureOf(
        db.execute(sql`UPDATE skill_runs SET deadline_at = now() WHERE id = ${fresh}`),
      ),
    ).toEqual({ code: "23514", constraint: "chk_skill_runs_deadline_at" });
    expect(
      await failureOf(db.execute(sql`UPDATE skill_runs SET git_sha = 'sha-1' WHERE id = ${fresh}`)),
    ).toEqual({ code: "23514", constraint: "chk_skill_runs_audit_together" });
    expect(
      await failureOf(
        db.execute(sql`
          UPDATE skill_runs SET recovery_point = 'executed', finished_at = now(),
            resource_usage = ${USAGE}::jsonb, error = 'boom'
          WHERE id = ${fresh}
        `),
      ),
    ).toEqual({ code: "23514", constraint: "chk_skill_runs_error_kind_with_error" });
    await expect(
      db.execute(sql`INSERT INTO skill_runs (skill_id, trigger, inputs, status)
        VALUES (${skillId}, 'cron', '{}'::jsonb, 'running')`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/"shadow"/) } });
  });
});
