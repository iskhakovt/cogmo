/**
 * Migration 0089 adds the nullable `coding_tasks.presubmit_verdict`, with no
 * default and no backfill, and extends `chk_coding_tasks_queued_bare` to hold
 * it null at `queued`. Runs the raw SQL against PGlite over tasks at `queued`
 * and at `verifying` as a build before it wrote them (the column dropped, the
 * CHECK as it stood).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { PASSED_PRESUBMIT_VERDICT } from "../test/coding-fixtures.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";
import { constraintNameOf, findPgErrorByCode } from "./pg-errors.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0089_coding_presubmit_verdict.sql", import.meta.url)),
  "utf8",
);

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const VerdictRowsSchema = z.object({
  rows: z.array(z.object({ status: z.string(), presubmit_verdict: z.unknown() })),
});

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  // The table as 0089 found it.
  await db.execute(sql`ALTER TABLE coding_tasks DROP CONSTRAINT chk_coding_tasks_queued_bare`);
  await db.execute(sql`ALTER TABLE coding_tasks DROP COLUMN IF EXISTS presubmit_verdict`);
  await db.execute(sql`
    ALTER TABLE coding_tasks ADD CONSTRAINT chk_coding_tasks_queued_bare CHECK (status <> 'queued'
      OR (worktree_assignment IS NULL AND session_id IS NULL AND container_id IS NULL AND plan IS NULL
        AND plan_approved_at IS NULL AND pr_metadata IS NULL AND resource_usage IS NULL
        AND claimed_by_run_id IS NULL))
  `);
});

afterAll(async () => {
  await close();
});

/** Apply the file as `migratePerFile` does: one transaction. */
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

async function insertTask(status: "queued" | "verifying"): Promise<string> {
  const repo = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO coding_repos (name, local_path, default_branch, remote_url, allowed_backends,
        verify_command, task_token_budget, task_wall_time_seconds, max_concurrent_tasks)
      VALUES (${`repo-${status}`}, '/r', 'main', 'https://github.com/u/r.git', '{claude}', 'true',
        1000, 60, 1)
      RETURNING id
    `),
  ).rows[0];
  const lifecycle =
    status === "queued" ? sql`NULL, NULL, NULL` : sql`'1. step', now(), 'run-before-0089'`;
  const task = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO coding_tasks (repo_id, goal, trigger_source, backend, allow_privileged_runc,
        status, plan, plan_approved_at, claimed_by_run_id)
      VALUES (${expectDefined(repo, "repo").id}, 'g', 'user', 'claude', false, ${status}, ${lifecycle})
      RETURNING id
    `),
  ).rows[0];
  return expectDefined(task, "task").id;
}

describe("migration 0089", () => {
  it("adds a null verdict to every row, and refuses one on a queued task", async () => {
    const queued = await insertTask("queued");
    const verifying = await insertTask("verifying");

    await apply();

    const rows = VerdictRowsSchema.parse(
      await db.execute(sql`SELECT status, presubmit_verdict FROM coding_tasks ORDER BY status`),
    ).rows;
    expect(rows).toEqual([
      { status: "queued", presubmit_verdict: null },
      { status: "verifying", presubmit_verdict: null },
    ]);
    const verdict = JSON.stringify(PASSED_PRESUBMIT_VERDICT);
    await db.execute(
      sql`UPDATE coding_tasks SET presubmit_verdict = ${verdict}::jsonb WHERE id = ${verifying}`,
    );
    const refused = await db
      .execute(
        sql`UPDATE coding_tasks SET presubmit_verdict = ${verdict}::jsonb WHERE id = ${queued}`,
      )
      .then(
        () => null,
        (e: unknown) => findPgErrorByCode(e, ["23514"]),
      );
    expect(refused && constraintNameOf(refused)).toBe("chk_coding_tasks_queued_bare");
  });
});
