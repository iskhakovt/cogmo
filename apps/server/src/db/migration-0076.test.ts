/**
 * Migration 0076 adds `containers.reaped_reason`, stamps `unknown` on every
 * `reaped` row, drops `exit_code` and adds `chk_containers_reaped_reason`, in
 * one transaction. Runs the raw SQL against PGlite over rows in every status,
 * with the pushed schema reverted to the pre-migration shape first.
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

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0076_containers_reaped_reason.sql", import.meta.url)),
  "utf8",
);

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const ReasonRowsSchema = z.object({
  rows: z.array(z.object({ id: z.string(), reason: z.string().nullable() })),
});
const ColumnRowsSchema = z.object({ rows: z.array(z.object({ column_name: z.string() })) });
const PgCodeSchema = z.object({ code: z.string() });

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
  await db.execute(sql`ALTER TABLE containers DROP COLUMN IF EXISTS reaped_reason`);
  await db.execute(sql`DROP TYPE IF EXISTS container_reaped_reason`);
  await db.execute(sql`ALTER TABLE containers ADD COLUMN IF NOT EXISTS exit_code integer`);
});

afterAll(async () => {
  await close();
});

/** One transaction, as `migratePerFile` runs a file: a failing statement rolls it back whole. */
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

async function insertInstance(): Promise<string> {
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`INSERT INTO cogmo_instances (host, pid) VALUES ('h', 1) RETURNING id`),
  );
  return expectDefined(rows[0], "inserted instance").id;
}

let dockerIds = 0;

/** `reason` is only insertable once the migration has added the column. */
async function insertContainer(
  instanceId: string,
  status: string,
  reason: string | null,
): Promise<string> {
  dockerIds += 1;
  const reasonColumn = reason === null ? sql`` : sql`, reaped_reason`;
  const reasonValue = reason === null ? sql`` : sql`, ${reason}`;
  const { rows } = IdRowsSchema.parse(
    await db.execute(sql`
      INSERT INTO containers
        (docker_id, root_task_id, depth, image, runtime, labels, resource_limits,
         status, ttl_expires_at, instance_id${reasonColumn})
      VALUES
        (${`docker-${dockerIds}`}, '019d0000-0000-7000-8000-000000000001', 0,
         'alpine', 'runc', '{"cogmo.managed":"true"}',
         '{"cpus":1,"memory_bytes":1048576,"pids":16}',
         ${status}, now(), ${instanceId}${reasonValue})
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

/** The SQLSTATE a statement fails with; `"resolved"` when it does not fail. */
async function failureCode(statement: Promise<unknown>): Promise<string> {
  return statement.then(
    () => "resolved",
    (error: unknown) => {
      const pg = findPgErrorByCode(error, ["23514"]);
      if (pg !== null) return pg.code;
      const parsed = PgCodeSchema.safeParse(error instanceof Error ? error.cause : error);
      return parsed.success ? parsed.data.code : String(error);
    },
  );
}

describe("migration 0076 — containers.reaped_reason", () => {
  it("stamps unknown on reaped rows, leaves the others, and drops exit_code", async () => {
    const instanceId = await insertInstance();
    const reaped = await insertContainer(instanceId, "reaped", null);
    const running = await insertContainer(instanceId, "running", null);
    const exited = await insertContainer(instanceId, "exited", null);
    const starting = await insertContainer(instanceId, "starting", null);
    expect(await containerColumns()).toContain("exit_code");

    await applyMigration();

    expect(await reasonById()).toEqual({
      [reaped]: "unknown",
      [running]: null,
      [exited]: null,
      [starting]: null,
    });
    expect(await containerColumns()).not.toContain("exit_code");
  });

  it("then rejects a reaped row without a reason and a live row with one", async () => {
    const instanceId = await insertInstance();
    const reaped = await insertContainer(instanceId, "reaped", null);
    const running = await insertContainer(instanceId, "running", null);
    await applyMigration();

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
    expect(await failureCode(insertContainer(instanceId, "reaped", "cascade"))).toBe("resolved");
  });
});
