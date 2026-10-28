/**
 * Migration 0076 rewrites `skill_deploy_status` without `approved`, gives
 * runs that finished before `resource_usage` existed the usage the runner
 * records, and adds the per-state CHECKs on `skill_runs` and `skill_deploys`,
 * all in one transaction. Runs the raw SQL against PGlite over rows in the
 * pre-migration shape (the pushed schema's CHECKs dropped and `approved`
 * restored): every legal combination survives, the repairable row is
 * repaired, each CHECK then rejects a combination the old shape accepted, and
 * a row with no repair rolls the whole file back naming its constraint.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";
import { constraintNameOf, findPgErrorByCode } from "./pg-errors.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(
    new URL("../../migrations/0076_skill_run_and_deploy_state_checks.sql", import.meta.url),
  ),
  "utf8",
);

const CHECKS = [
  ["skill_runs", "chk_skill_runs_status_iff_finished"],
  ["skill_runs", "chk_skill_runs_executed_payload"],
  ["skill_runs", "chk_skill_runs_outcome"],
  ["skill_deploys", "chk_skill_deploys_resolved_at_iff_terminal"],
  ["skill_deploys", "chk_skill_deploys_approved_by_only_live"],
] as const;

/** SQLSTATEs a probe can fail with: CHECK violation, bad enum literal, unique, not-null. */
const PROBE_SQLSTATES = ["23514", "22P02", "23505", "23502"] as const;

const CLASSIFIER_LOG = JSON.stringify({
  classifier_version: "stub-0",
  risk_tier: "auto",
  declared_effects: [],
  detected_effects: [],
  declared_secrets: [],
  declared_dependencies: [],
  validation_errors: [],
});
const USAGE = { wallClockMs: 7, peakMemoryBytes: null };
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const FINISHED_AT = "2026-01-01T00:00:01.500Z";

interface RunShape {
  recoveryPoint: string;
  status: string;
  output: string | null;
  error: string | null;
  resourceUsage: string | null;
  finishedAt: string | null;
}

interface DeployShape {
  status: string;
  resolvedAt: string | null;
  approvedBy: string | null;
}

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const RunRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      recovery_point: z.string(),
      status: z.string(),
      resource_usage: z.string().nullable(),
    }),
  ),
});
const DeployRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      resolved: z.boolean(),
      approved_by: z.string().nullable(),
    }),
  ),
});
const NameRowsSchema = z.object({ rows: z.array(z.object({ name: z.string() })) });

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  for (const [table, constraint] of CHECKS) {
    await db.execute(sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`));
  }
  await db.execute(sql`ALTER TYPE skill_deploy_status ADD VALUE IF NOT EXISTS 'approved'`);
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

/**
 * How `write` failed: the SQLSTATE with the constraint it names, or the raw
 * error when it is not a Postgres failure a probe can produce, or null when
 * it resolved.
 */
async function failureOf(write: Promise<unknown>): Promise<unknown> {
  const error = await write.then(
    () => null,
    (e: unknown) => e,
  );
  if (error === null) return null;
  const pg = findPgErrorByCode(error, PROBE_SQLSTATES);
  return pg === null ? error : { code: pg.code, constraint: constraintNameOf(pg) };
}

function checkViolation(constraint: string) {
  return { code: "23514", constraint };
}
const INVALID_ENUM_LITERAL = { code: "22P02", constraint: "unknown" };

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

async function insertIdentity(): Promise<string> {
  const userId = insertedId(
    await db.execute(sql`INSERT INTO users DEFAULT VALUES RETURNING id`),
    "user",
  );
  const channelId = insertedId(
    await db.execute(sql`
      INSERT INTO channels (type, credentials, identity_mode)
      VALUES ('telegram', '{}'::jsonb, 'mapped') RETURNING id
    `),
    "channel",
  );
  return insertedId(
    await db.execute(sql`
      INSERT INTO user_identities (user_id, channel_id, platform_handle, is_wildcard, auto_created)
      VALUES (${userId}, ${channelId}, 'tg-approver', false, false)
      RETURNING id
    `),
    "identity",
  );
}

/** One-shot runs: `idempotency_key` stays null, so probes never collide on its UNIQUE. */
async function insertRun(skillId: string, run: RunShape): Promise<string> {
  return insertedId(
    await db.execute(sql`
      INSERT INTO skill_runs
        (skill_id, trigger, inputs, status, output, error, resource_usage, recovery_point, created_at, finished_at)
      VALUES (${skillId}, 'manual', '{}'::jsonb, ${run.status}::skill_run_status, ${run.output}::jsonb,
        ${run.error}, ${run.resourceUsage}::jsonb, ${run.recoveryPoint}::skill_run_recovery_point,
        ${CREATED_AT}::timestamptz, ${run.finishedAt}::timestamptz)
      RETURNING id
    `),
    `${run.recoveryPoint}/${run.status}`,
  );
}

async function insertDeploy(skillId: string, deploy: DeployShape): Promise<string> {
  return insertedId(
    await db.execute(sql`
      INSERT INTO skill_deploys (skill_id, git_sha, risk_tier, status, classifier_log, approved_by, resolved_at)
      VALUES (${skillId}, 'sha-1', 'approve', ${deploy.status}::skill_deploy_status, ${CLASSIFIER_LOG}::jsonb,
        ${deploy.approvedBy}, ${deploy.resolvedAt}::timestamptz)
      RETURNING id
    `),
    deploy.status,
  );
}

const started: RunShape = {
  recoveryPoint: "started",
  status: "running",
  output: null,
  error: null,
  resourceUsage: null,
  finishedAt: null,
};
const executedOutput: RunShape = {
  ...started,
  recoveryPoint: "executed",
  output: '{"echo":1}',
  resourceUsage: JSON.stringify(USAGE),
  finishedAt: FINISHED_AT,
};
const executedError: RunShape = { ...executedOutput, output: null, error: "boom" };
const finishedSuccess: RunShape = {
  ...executedOutput,
  recoveryPoint: "finished",
  status: "success",
};
const finishedError: RunShape = { ...executedError, recoveryPoint: "finished", status: "error" };
const finishedBeforeUsage: RunShape = { ...finishedSuccess, resourceUsage: null };
const finishedStillRunning: RunShape = { ...finishedSuccess, status: "running" };

const pending: DeployShape = { status: "pending_approval", resolvedAt: null, approvedBy: null };
const live: DeployShape = { status: "live", resolvedAt: FINISHED_AT, approvedBy: null };
const denied: DeployShape = { ...live, status: "denied" };
const approved: DeployShape = { ...live, status: "approved" };

async function runsById(): Promise<
  Record<string, { phase: string; status: string; usage: unknown }>
> {
  const { rows } = RunRowsSchema.parse(
    await db.execute(sql`
      SELECT id, recovery_point::text AS recovery_point, status::text AS status,
        resource_usage::text AS resource_usage
      FROM skill_runs
    `),
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        phase: r.recovery_point,
        status: r.status,
        usage: r.resource_usage === null ? null : JSON.parse(r.resource_usage),
      },
    ]),
  );
}

async function deploysById(): Promise<
  Record<string, { status: string; resolved: boolean; approvedBy: string | null }>
> {
  const { rows } = DeployRowsSchema.parse(
    await db.execute(sql`
      SELECT id, status::text AS status, resolved_at IS NOT NULL AS resolved, approved_by::text AS approved_by
      FROM skill_deploys
    `),
  );
  return Object.fromEntries(
    rows.map((r) => [r.id, { status: r.status, resolved: r.resolved, approvedBy: r.approved_by }]),
  );
}

async function deployStatusLabels(): Promise<string[]> {
  const { rows } = NameRowsSchema.parse(
    await db.execute(sql`
      SELECT e.enumlabel AS name FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'skill_deploy_status' ORDER BY e.enumsortorder
    `),
  );
  return rows.map((r) => r.name);
}

/** The per-state CHECKs present on the two tables. */
async function installedChecks(): Promise<string[]> {
  const { rows } = NameRowsSchema.parse(
    await db.execute(sql`
      SELECT conname AS name FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN ('skill_runs'::regclass, 'skill_deploys'::regclass)
      ORDER BY conname
    `),
  );
  return rows.map((r) => r.name);
}

describe("migration 0076 — skill run and deploy per-state CHECKs", () => {
  it("repairs runs that finished without resource_usage and keeps every legal row", async () => {
    const skillId = await insertSkill();
    const approver = await insertIdentity();
    const startedId = await insertRun(skillId, started);
    const executedOutputId = await insertRun(skillId, executedOutput);
    const executedErrorId = await insertRun(skillId, executedError);
    const finishedSuccessId = await insertRun(skillId, finishedSuccess);
    const finishedErrorId = await insertRun(skillId, finishedError);
    const noOutputId = await insertRun(skillId, { ...finishedSuccess, output: null });
    const beforeUsageId = await insertRun(skillId, finishedBeforeUsage);
    const pendingId = await insertDeploy(skillId, pending);
    const liveId = await insertDeploy(skillId, live);
    const approvedId = await insertDeploy(skillId, { ...live, approvedBy: approver });
    const deniedId = await insertDeploy(skillId, denied);
    const rolledBackId = await insertDeploy(skillId, { ...live, status: "rolled_back" });
    expect(await deployStatusLabels()).toContain("approved");

    await apply();

    expect(await runsById()).toEqual({
      [startedId]: { phase: "started", status: "running", usage: null },
      [executedOutputId]: { phase: "executed", status: "running", usage: USAGE },
      [executedErrorId]: { phase: "executed", status: "running", usage: USAGE },
      [finishedSuccessId]: { phase: "finished", status: "success", usage: USAGE },
      [finishedErrorId]: { phase: "finished", status: "error", usage: USAGE },
      [noOutputId]: { phase: "finished", status: "success", usage: USAGE },
      [beforeUsageId]: {
        phase: "finished",
        status: "success",
        usage: { wallClockMs: 1500, peakMemoryBytes: null },
      },
    });
    expect(await deploysById()).toEqual({
      [pendingId]: { status: "pending_approval", resolved: false, approvedBy: null },
      [liveId]: { status: "live", resolved: true, approvedBy: null },
      [approvedId]: { status: "live", resolved: true, approvedBy: approver },
      [deniedId]: { status: "denied", resolved: true, approvedBy: null },
      [rolledBackId]: { status: "rolled_back", resolved: true, approvedBy: null },
    });
    expect(await deployStatusLabels()).toEqual([
      "pending_approval",
      "denied",
      "live",
      "rolled_back",
    ]);
    expect(await installedChecks()).toEqual(CHECKS.map(([, name]) => name).sort());
  });

  it("then each CHECK rejects a combination the old shape accepted", async () => {
    const skillId = await insertSkill();
    const approver = await insertIdentity();
    const startedWithPayload: RunShape = { ...started, finishedAt: FINISHED_AT };
    const executedWithVerdict: RunShape = { ...executedOutput, status: "success" };
    const errorWithoutReason: RunShape = { ...finishedError, error: null };
    const liveUnresolved: DeployShape = { ...live, resolvedAt: null };
    const deniedWithApprover: DeployShape = { ...denied, approvedBy: approver };
    for (const run of [startedWithPayload, executedWithVerdict, errorWithoutReason]) {
      await insertRun(skillId, run);
    }
    for (const deploy of [liveUnresolved, deniedWithApprover, approved]) {
      await insertDeploy(skillId, deploy);
    }
    await db.execute(sql`DELETE FROM skill_runs`);
    await db.execute(sql`DELETE FROM skill_deploys`);

    await apply();

    expect(await failureOf(insertRun(skillId, startedWithPayload))).toEqual(
      checkViolation("chk_skill_runs_executed_payload"),
    );
    expect(await failureOf(insertRun(skillId, executedWithVerdict))).toEqual(
      checkViolation("chk_skill_runs_status_iff_finished"),
    );
    expect(await failureOf(insertRun(skillId, errorWithoutReason))).toEqual(
      checkViolation("chk_skill_runs_outcome"),
    );
    expect(await failureOf(insertDeploy(skillId, liveUnresolved))).toEqual(
      checkViolation("chk_skill_deploys_resolved_at_iff_terminal"),
    );
    expect(await failureOf(insertDeploy(skillId, deniedWithApprover))).toEqual(
      checkViolation("chk_skill_deploys_approved_by_only_live"),
    );
    expect(await failureOf(insertDeploy(skillId, approved))).toEqual(INVALID_ENUM_LITERAL);
  });

  it("rolls the whole file back on a row with no repair, so the next boot retries it", async () => {
    const skillId = await insertSkill();
    const beforeUsageId = await insertRun(skillId, finishedBeforeUsage);
    const stillRunningId = await insertRun(skillId, finishedStillRunning);

    expect(await failureOf(apply())).toEqual(checkViolation("chk_skill_runs_status_iff_finished"));

    expect(await installedChecks()).toEqual([]);
    expect(await deployStatusLabels()).toContain("approved");
    expect((await runsById())[beforeUsageId]?.usage).toBeNull();

    await db.execute(sql`DELETE FROM skill_runs WHERE id = ${stillRunningId}`);
    await apply();
    expect((await runsById())[beforeUsageId]?.usage).toEqual({
      wallClockMs: 1500,
      peakMemoryBytes: null,
    });
  });

  it("rolls back when a row still holds approved", async () => {
    const skillId = await insertSkill();
    await insertDeploy(skillId, approved);

    expect(await failureOf(apply())).toEqual(INVALID_ENUM_LITERAL);

    expect(await installedChecks()).toEqual([]);
    expect(await deployStatusLabels()).toContain("approved");
  });
});
