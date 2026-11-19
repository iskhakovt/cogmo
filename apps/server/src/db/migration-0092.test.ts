/**
 * Migrations 0091 and 0092 give a coding task its fix passes: 0091 adds
 * `pending_fix` to `coding_task_status` alone, and 0092 adds
 * `presubmit_fix_passes` (0 on every row), its bound, the fix-owed CHECK, and
 * the new status and count in the CHECKs that name them. Applies the
 * committed journal through 0090 with `migratePerFile`, writes rows as a build
 * before them would, then applies the rest, one transaction per file, as a
 * deploy does.
 */

import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { REFUSED_PRESUBMIT_VERDICT } from "../test/coding-fixtures.js";
import type { Database } from "./index.js";
import { migratePerFile } from "./migrate-per-file.js";
import { constraintNameOf, findPgErrorByCode } from "./pg-errors.js";
import * as schema from "./schemas.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ENUM_FILE = "0091_coding_task_status_pending_fix";
const COUNT_FILE = "0092_coding_presubmit_fix_passes";

const JournalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), tag: z.string() }).passthrough()),
});
const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const CountRowsSchema = z.object({
  rows: z.array(z.object({ status: z.string(), presubmit_fix_passes: z.number() })),
});

let client: PGlite;
let db: Database;
let before: string;

/** The migrations folder as a deploy before 0091 had it. */
async function journalThrough0090(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cogmo-migration-0092-"));
  await mkdir(join(dir, "meta"));
  const journal = JournalSchema.parse(
    JSON.parse(await readFile(join(MIGRATIONS, "meta/_journal.json"), "utf8")),
  );
  const entries = journal.entries.filter((entry) => entry.idx <= 90);
  await writeFile(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries) {
    await cp(join(MIGRATIONS, `${tag}.sql`), join(dir, `${tag}.sql`));
  }
  return dir;
}

async function statements(tag: string): Promise<string[]> {
  return (await readFile(join(MIGRATIONS, `${tag}.sql`), "utf8"))
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function insertTask(status: "queued" | "verifying" | "failed"): Promise<string> {
  const repo = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO coding_repos (name, local_path, default_branch, remote_url, allowed_backends,
        verify_command, task_token_budget, task_wall_time_seconds, max_concurrent_tasks)
      VALUES (${`repo-${randomUUID()}`}, '/r', 'main', 'https://github.com/u/r.git', '{claude}',
        'true', 1000, 60, 1)
      RETURNING id
    `),
  ).rows[0];
  const lifecycle = status === "queued" ? sql`NULL, NULL, NULL` : sql`'1. step', now(), 'run-1'`;
  const reason = status === "failed" ? sql`'presubmit_refused'` : sql`NULL`;
  const task = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO coding_tasks (repo_id, goal, trigger_source, backend, allow_privileged_runc,
        status, plan, plan_approved_at, claimed_by_run_id, failure_reason)
      VALUES (${repo?.id}, 'g', 'user', 'claude', false, ${status}, ${lifecycle}, ${reason})
      RETURNING id
    `),
  ).rows[0];
  if (!task) throw new Error("no task inserted");
  return task.id;
}

/** The CHECK a refused write names. */
async function refusedBy(write: Promise<unknown>): Promise<string | null> {
  return write.then(
    () => null,
    (e: unknown) => {
      const pg = findPgErrorByCode(e, ["23514"]);
      if (!pg) throw e;
      return constraintNameOf(pg);
    },
  );
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  before = await journalThrough0090();
  await migratePerFile(db, { migrationsFolder: before });
});

afterEach(async () => {
  await client.close();
  await rm(before, { recursive: true, force: true });
});

describe("migrations 0091 and 0092", { timeout: 30_000 }, () => {
  it("count every existing task's passes from 0, which the CHECKs accept, and tie pending_fix to a refusal", async () => {
    await insertTask("queued");
    await insertTask("verifying");
    await insertTask("failed");

    await migratePerFile(db, { migrationsFolder: MIGRATIONS });

    const rows = CountRowsSchema.parse(
      await db.execute(sql`SELECT status, presubmit_fix_passes FROM coding_tasks ORDER BY status`),
    ).rows;
    expect(rows).toEqual([
      { status: "queued", presubmit_fix_passes: 0 },
      { status: "verifying", presubmit_fix_passes: 0 },
      { status: "failed", presubmit_fix_passes: 0 },
    ]);

    const verifying = await insertTask("verifying");
    const toPendingFix = sql`UPDATE coding_tasks SET status = 'pending_fix', presubmit_fix_passes = 1 WHERE id = ${verifying}`;
    expect(await refusedBy(db.execute(toPendingFix))).toBe("chk_coding_tasks_fix_owed");
    const verdict = JSON.stringify(REFUSED_PRESUBMIT_VERDICT);
    await db.execute(
      sql`UPDATE coding_tasks SET presubmit_verdict = ${verdict}::jsonb WHERE id = ${verifying}`,
    );
    expect(await refusedBy(db.execute(toPendingFix))).toBeNull();
    expect(
      await refusedBy(
        db.execute(sql`UPDATE coding_tasks SET presubmit_fix_passes = 3 WHERE id = ${verifying}`),
      ),
    ).toBe("chk_coding_tasks_fix_passes_bound");
  });

  it("need the enum value committed in its own file: in one transaction the CHECKs that name it fail", async () => {
    const both = [...(await statements(ENUM_FILE)), ...(await statements(COUNT_FILE))];

    const failed = await db
      .transaction(async (trx) => {
        for (const stmt of both) await trx.execute(sql.raw(stmt));
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(failed).toBeInstanceOf(Error);
    const cause = failed instanceof Error ? failed.cause : undefined;
    expect(cause instanceof Error ? cause.message : String(cause)).toMatch(
      /unsafe use of new value/,
    );
  });
});
