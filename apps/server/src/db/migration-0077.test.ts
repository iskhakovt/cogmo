/**
 * Migration 0077 stamps `unknown` on every `reaped` container row that has no
 * `reaped_reason`, so that 0078 can tie the column to the status with
 * `chk_containers_reaped_reason` and drop `exit_code`. Runs both migrations'
 * raw SQL against PGlite with the constraint dropped and the column restored
 * first, over rows in every status.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";
import { findPgErrorByCode } from "./pg-errors.js";

async function migrationSql(file: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
}
const BACKFILL_SQL = await migrationSql("0077_containers_reaped_reason_backfill.sql");
const CHECK_SQL = await migrationSql("0078_containers_reaped_reason_check_drop_exit_code.sql");

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const ReasonRowsSchema = z.object({
  rows: z.array(z.object({ id: z.string(), reason: z.string().nullable() })),
});
const ColumnRowsSchema = z.object({ rows: z.array(z.object({ column_name: z.string() })) });

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(
    sql`ALTER TABLE containers DROP CONSTRAINT IF EXISTS chk_containers_reaped_reason`,
  );
  await db.execute(sql`ALTER TABLE containers ADD COLUMN IF NOT EXISTS exit_code integer`);
});

afterAll(async () => {
  await close();
});

/** One transaction per file, as `migratePerFile` runs it: a failing statement rolls the file back. */
async function apply(migration: string): Promise<void> {
  const statements = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.transaction(async (trx) => {
    for (const stmt of statements) {
      await trx.execute(sql.raw(stmt));
    }
  });
}

async function insertInstance(): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`INSERT INTO cogmo_instances (host, pid) VALUES ('h', 1) RETURNING id`),
  );
  return expectDefined(rows[0], "inserted instance").id;
}

async function insertContainer(
  instanceId: string,
  status: string,
  reason: string | null,
): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO containers
        (docker_id, root_task_id, depth, image, runtime, labels, resource_limits,
         status, reaped_reason, ttl_expires_at, instance_id)
      VALUES
        (${`docker-${status}-${reason ?? "none"}`}, '019d0000-0000-7000-8000-000000000001', 0,
         'alpine', 'runc', '{"cogmo.managed":"true"}',
         '{"cpus":1,"memory_bytes":1048576,"pids":16}',
         ${status}, ${reason}, now(), ${instanceId})
      RETURNING id
    `),
  );
  return expectDefined(rows[0], "inserted row").id;
}

async function reasonById(): Promise<Record<string, string | null>> {
  const { rows } = ReasonRowsSchema.parse(
    await db.execute(sql`SELECT id, reaped_reason::text AS reason FROM containers`),
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.reason]));
}

async function containerColumns(): Promise<string[]> {
  const { rows } = ColumnRowsSchema.parse(
    await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'containers'`,
    ),
  );
  return rows.map((r) => r.column_name);
}

async function failureCode(statement: Promise<unknown>): Promise<string | undefined> {
  const error = await statement.then(
    () => null,
    (e: unknown) => e,
  );
  return findPgErrorByCode(error, ["23514"])?.code;
}

describe("migration 0077 — backfill containers.reaped_reason", () => {
  it("stamps unknown on reaped rows with no reason and leaves every other row as it was", async () => {
    const instanceId = await insertInstance();
    const reapedBefore = await insertContainer(instanceId, "reaped", null);
    const reapedWithReason = await insertContainer(instanceId, "reaped", "cascade");
    const running = await insertContainer(instanceId, "running", null);
    const exited = await insertContainer(instanceId, "exited", null);

    await apply(BACKFILL_SQL);

    expect(await reasonById()).toEqual({
      [reapedBefore]: "unknown",
      [reapedWithReason]: "cascade",
      [running]: null,
      [exited]: null,
    });
  });

  it("then 0078 ties the reason to the status, which the unfilled rows would have rejected, and drops exit_code", async () => {
    const instanceId = await insertInstance();
    const reaped = await insertContainer(instanceId, "reaped", null);
    const running = await insertContainer(instanceId, "running", null);
    expect(await containerColumns()).toContain("exit_code");

    expect(await failureCode(apply(CHECK_SQL))).toBe("23514");
    await apply(BACKFILL_SQL);
    await apply(CHECK_SQL);

    expect(await containerColumns()).not.toContain("exit_code");
    expect(await reasonById()).toEqual({ [reaped]: "unknown", [running]: null });
    expect(
      await failureCode(
        db.execute(sql`UPDATE containers SET reaped_reason = NULL WHERE id = ${reaped}`),
      ),
    ).toBe("23514");
    expect(
      await failureCode(
        db.execute(sql`UPDATE containers SET reaped_reason = 'cascade' WHERE id = ${running}`),
      ),
    ).toBe("23514");
    expect(await failureCode(insertContainer(instanceId, "reaped", null))).toBe("23514");
    expect(await failureCode(insertContainer(instanceId, "starting", "ttl_expired"))).toBe("23514");
  });
});
