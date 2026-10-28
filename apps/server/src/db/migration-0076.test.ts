/**
 * Migration 0076 types `coding_tasks.failure_reason` as
 * `coding_task_failure_reason`, adds `failure_detail`, and ties every
 * per-state column to its status with CHECKs. The stored text moves to
 * `failure_detail` and is mapped to the label of the branch that wrote it.
 * Runs the raw migration SQL in one transaction against PGlite over rows
 * written in the pre-migration shape (the column put back to text first, the
 * CHECKs dropped), asserts the mapping and that the store reads every row,
 * and that a row the CHECKs refuse rolls the whole file back.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleCodingStore } from "../agent/coding/store/index.js";
import { expectDefined, expectOk } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";
import { findPgErrorByCode } from "./pg-errors.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0076_coding_task_failure_reason.sql", import.meta.url)),
  "utf8",
);

const CHECKS = [
  "chk_coding_tasks_reason_with_end",
  "chk_coding_tasks_detail_with_reason",
  "chk_coding_tasks_queued_bare",
  "chk_coding_tasks_plan_at_gate",
  "chk_coding_tasks_approval_after_gate",
  "chk_coding_tasks_pr_metadata_after_push",
] as const;

/** A row as the pre-migration writers left it. */
interface LegacyTask {
  status: string;
  failureReason: string | null;
  plan?: string;
  approved?: boolean;
  prMetadata?: boolean;
}

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const FailureRowsSchema = z.object({
  rows: z.array(
    z.object({ id: z.string(), reason: z.string().nullable(), detail: z.string().nullable() }),
  ),
});
const LegacyRowsSchema = z.object({
  rows: z.array(z.object({ id: z.string(), reason: z.string().nullable() })),
});
const ColumnRowsSchema = z.object({
  rows: z.array(z.object({ column_name: z.string(), data_type: z.string() })),
});

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleCodingStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  for (const name of CHECKS) {
    await db.execute(sql.raw(`ALTER TABLE coding_tasks DROP CONSTRAINT IF EXISTS ${name}`));
  }
  await db.execute(sql`ALTER TABLE coding_tasks DROP COLUMN IF EXISTS failure_detail`);
  await db.execute(sql`ALTER TABLE coding_tasks ALTER COLUMN failure_reason SET DATA TYPE text`);
  await db.execute(sql`DROP TYPE IF EXISTS coding_task_failure_reason`);
});

afterAll(async () => {
  await close();
});

async function seedRepo(): Promise<string> {
  const row = await tx((trx) =>
    store
      .insertRepo(trx, {
        name: "cogmo",
        localPath: "/tmp/repo",
        defaultBranch: "main",
        remoteUrl: "https://github.com/user/cogmo.git",
        devcontainer: null,
        allowedBackends: ["claude"],
        verifyCommand: "pnpm test",
        taskTokenBudget: 100_000,
        taskWallTimeSeconds: 600,
        maxConcurrentTasks: 1,
      })
      .then(expectOk),
  );
  return row.id;
}

/** Insert each labelled row through raw SQL, as the text column took it; returns id → label. */
async function insert(
  repoId: string,
  tasks: Readonly<Record<string, LegacyTask>>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const pr = JSON.stringify({
    url: "https://github.com/user/cogmo/pull/1",
    number: 1,
    branchSha: "a".repeat(40),
    openedAt: "2026-08-20T00:00:00.000Z",
  });
  for (const [label, t] of Object.entries(tasks)) {
    const { rows } = IdRowsSchema.parse(
      await db.execute(sql`
        INSERT INTO coding_tasks
          (repo_id, goal, trigger_source, backend, allow_privileged_runc, status,
           failure_reason, plan, plan_approved_at, pr_metadata)
        VALUES (${repoId}, ${label}, 'user', 'claude', false, ${t.status},
          ${t.failureReason}, ${t.plan ?? null},
          ${t.approved ? "2026-08-20T00:01:00Z" : null},
          ${t.prMetadata ? pr : null}::jsonb)
        RETURNING id
      `),
    );
    labels.set(expectDefined(rows[0], label).id, label);
  }
  return labels;
}

/** The migration file as `migratePerFile` runs it: every statement in one transaction. */
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

/** The SQLSTATE and constraint a rejected promise carries; the rejection itself when it is not a Postgres error. */
async function pgFailureOf(
  promise: Promise<unknown>,
): Promise<{ code: string; constraint: string | undefined }> {
  try {
    await promise;
  } catch (err: unknown) {
    const pg = findPgErrorByCode(err, ["23514", "22P02", "23502"]);
    if (pg) return { code: pg.code, constraint: pg.constraint ?? pg.constraint_name };
    throw err;
  }
  throw new Error("expected the promise to reject");
}

/** Each row's reason and detail after the migration, by label. */
async function failuresBy(
  labels: ReadonlyMap<string, string>,
): Promise<Record<string, { reason: string | null; detail: string | null }>> {
  const { rows } = FailureRowsSchema.parse(
    await db.execute(
      sql`SELECT id, failure_reason::text AS reason, failure_detail AS detail FROM coding_tasks`,
    ),
  );
  return Object.fromEntries(
    rows.map((r) => [
      expectDefined(labels.get(r.id), r.id),
      { reason: r.reason, detail: r.detail },
    ]),
  );
}

/** Each row's pre-migration text, by label. */
async function legacyReasonsBy(
  labels: ReadonlyMap<string, string>,
): Promise<Record<string, string | null>> {
  const { rows } = LegacyRowsSchema.parse(
    await db.execute(sql`SELECT id, failure_reason AS reason FROM coding_tasks`),
  );
  return Object.fromEntries(rows.map((r) => [expectDefined(labels.get(r.id), r.id), r.reason]));
}

async function failureReasonColumn(): Promise<Record<string, string>> {
  const { rows } = ColumnRowsSchema.parse(
    await db.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'coding_tasks' AND column_name IN ('failure_reason', 'failure_detail')
    `),
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
}

const CLI = "claude exit code 2";
const PUSH_AUTH = "execute push failed (auth_failed):\n\nremote: Invalid username or password.";
const PUSH_CONFLICT = "push rejected — branch conflict on cogmo/<idShort>:\n\n! [rejected]";
const VERIFY = "verify failed (exit 1)\n\nFAIL src/x.test.ts";
const VERIFY_TIMEOUT = "verify failed (exit 124)\n\n[verify timed out after 600s]";
const PR_422 = "PR open failed (validation): A pull request already exists for cogmo/abc.";
const DRAFT_PR_AUTH = "draft PR open failed (auth): Bad credentials";
const DRAFT_PR_422 = "draft PR open failed (validation): A pull request already exists";
const DRAFT_PR = "draft PR open failed: Server Error";
const IDENTITY = "GitHub identity 'default' is not configured. Run the setup wizard.";
const RECONCILE =
  "inngest run terminated abnormally (run_id 01X, function_id coding-task-execute): gone";
const START = "inngest.send failed: fetch failed";
const CATCH = "git checkout -B cogmo/abc timed out after 60s";
const TOKEN =
  'Claude Code subscription auth missing — secret "claude_code_oauth_token" is not set.';

describe("migration 0076 — coding task failure reason", () => {
  it("moves the stored text to failure_detail and maps it to the writer's reason", async () => {
    const repoId = await seedRepo();
    const labels = await insert(repoId, {
      cli: { status: "failed", failureReason: CLI },
      "push auth": { status: "failed", failureReason: PUSH_AUTH },
      "push conflict": { status: "failed", failureReason: PUSH_CONFLICT },
      verify: { status: "failed", failureReason: VERIFY },
      "verify timeout": { status: "failed", failureReason: VERIFY_TIMEOUT },
      "pr 422": { status: "failed", failureReason: PR_422 },
      "draft pr auth": { status: "failed", failureReason: DRAFT_PR_AUTH },
      "draft pr 422": { status: "failed", failureReason: DRAFT_PR_422 },
      "draft pr": { status: "failed", failureReason: DRAFT_PR },
      identity: { status: "failed", failureReason: IDENTITY },
      token: { status: "failed", failureReason: TOKEN },
      reconcile: { status: "failed", failureReason: RECONCILE },
      start: { status: "failed", failureReason: START },
      catch: { status: "failed", failureReason: CATCH },
      "cancelled, unmatched text": { status: "cancelled", failureReason: "stopped by hand" },
      "failed, no text": { status: "failed", failureReason: null },
      "failed, empty text": { status: "failed", failureReason: "" },
      cancelled: { status: "cancelled", failureReason: "user cancelled the plan" },
      revised: { status: "cancelled", failureReason: "user requested revisions" },
    });

    await applyMigration();

    expect(await failuresBy(labels)).toEqual({
      cli: { reason: "cli_exit_error", detail: CLI },
      "push auth": { reason: "auth_failed", detail: PUSH_AUTH },
      "push conflict": { reason: "branch_conflict", detail: PUSH_CONFLICT },
      verify: { reason: "verify_failed", detail: VERIFY },
      "verify timeout": { reason: "verify_timed_out", detail: VERIFY_TIMEOUT },
      "pr 422": { reason: "pr_validation_failed", detail: PR_422 },
      "draft pr auth": { reason: "pr_auth_failed", detail: DRAFT_PR_AUTH },
      "draft pr 422": { reason: "pr_validation_failed", detail: DRAFT_PR_422 },
      "draft pr": { reason: "pr_open_failed", detail: DRAFT_PR },
      identity: { reason: "credentials_unavailable", detail: IDENTITY },
      token: { reason: "credentials_unavailable", detail: TOKEN },
      reconcile: { reason: "run_terminated", detail: RECONCILE },
      start: { reason: "start_emit_failed", detail: START },
      catch: { reason: "unexpected_error", detail: CATCH },
      "cancelled, unmatched text": { reason: "unknown", detail: "stopped by hand" },
      "failed, no text": { reason: "unknown", detail: null },
      "failed, empty text": { reason: "unknown", detail: null },
      cancelled: { reason: "user_cancelled", detail: null },
      revised: { reason: "user_requested_revisions", detail: null },
    });
  });

  it("clears a Cancel's text an unconditional status write carried past the Cancel", async () => {
    // Before `transition-pushed` and its siblings, a Cancel during the suite
    // was overwritten by `set-status-pushed` and the reason stayed.
    const repoId = await seedRepo();
    const labels = await insert(repoId, {
      "pushed after cancel": {
        status: "pushed",
        failureReason: "user cancelled the plan",
        plan: "p",
        approved: true,
      },
      "pr open after cancel": {
        status: "pr_open",
        failureReason: "user requested revisions",
        plan: "p",
        approved: true,
        prMetadata: true,
      },
      "pending verify after cancel": {
        status: "pending_verify",
        failureReason: "user cancelled the plan",
        plan: "p",
        approved: true,
      },
    });

    await applyMigration();

    expect(await failuresBy(labels)).toEqual({
      "pushed after cancel": { reason: null, detail: null },
      "pr open after cancel": { reason: null, detail: null },
      "pending verify after cancel": { reason: null, detail: null },
    });
    const rows = await tx((trx) => store.getTasksByIds(trx, [...labels.keys()]));
    expect(rows.map((r) => r.status).sort()).toEqual(["pending_verify", "pr_open", "pushed"]);
  });

  it("accepts every row the orchestrators wrote, at every status, and the store reads them back", async () => {
    const repoId = await seedRepo();
    const labels = await insert(repoId, {
      queued: { status: "queued", failureReason: null },
      planning: { status: "planning", failureReason: null },
      awaiting: { status: "awaiting_approval", failureReason: null, plan: "p" },
      executing: { status: "executing", failureReason: null, plan: "p", approved: true },
      pending: { status: "pending_verify", failureReason: null, plan: "p", approved: true },
      verifying: { status: "verifying", failureReason: null, plan: "p", approved: true },
      pushed: { status: "pushed", failureReason: null, plan: "p", approved: true },
      "pushed, pr": {
        status: "pushed",
        failureReason: null,
        plan: "p",
        approved: true,
        prMetadata: true,
      },
      "pr open": {
        status: "pr_open",
        failureReason: null,
        plan: "p",
        approved: true,
        prMetadata: true,
      },
      "failed early": { status: "failed", failureReason: CLI },
      "cancelled late": {
        status: "cancelled",
        failureReason: "user cancelled the plan",
        plan: "p",
        approved: true,
        prMetadata: true,
      },
      "cancelled, no text": { status: "cancelled", failureReason: null },
    });

    await applyMigration();

    expect(await failureReasonColumn()).toEqual({
      failure_reason: "USER-DEFINED",
      failure_detail: "text",
    });
    const rows = await tx((trx) => store.getTasksByIds(trx, [...labels.keys()]));
    expect(rows).toHaveLength(labels.size);
    const byLabel = Object.fromEntries(
      rows.map((r) => [labels.get(r.id), [r.status, r.failureReason, r.failureDetail]]),
    );
    expect(byLabel["pr open"]).toEqual(["pr_open", null, null]);
    expect(byLabel["failed early"]).toEqual(["failed", "cli_exit_error", CLI]);
    expect(byLabel["cancelled late"]).toEqual(["cancelled", "user_cancelled", null]);
    expect(byLabel["cancelled, no text"]).toEqual(["cancelled", "unknown", null]);
  });

  it("rolls the whole file back on a row the CHECKs refuse, leaving the next boot to retry", async () => {
    const repoId = await seedRepo();
    const labels = await insert(repoId, {
      fine: { status: "failed", failureReason: CLI },
      // `pr_open` without PR metadata: a shape no build's writers produce.
      impossible: { status: "pr_open", failureReason: null, plan: "p", approved: true },
    });

    expect(await pgFailureOf(applyMigration())).toEqual({
      code: "23514",
      constraint: "chk_coding_tasks_pr_metadata_after_push",
    });

    // Nothing of the file landed: the column is still text, the detail column
    // absent, the backfill undone.
    expect(await failureReasonColumn()).toEqual({ failure_reason: "text" });
    expect(await legacyReasonsBy(labels)).toEqual({ fine: CLI, impossible: null });
  });
});
