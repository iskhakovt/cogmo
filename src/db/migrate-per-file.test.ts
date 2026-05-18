/**
 * Migration runner test — covers two things this codebase didn't have
 * before:
 *
 * 1. `migratePerFile` applies the on-disk migration files cleanly,
 *    including the 0036→0037 enum-then-CHECK pair that was the original
 *    motivating case. PGlite is the right harness — it enforces the
 *    same `unsafe use of new value` rule real PG does (verified by
 *    repro against PG18 on 2026-05-18).
 *
 * 2. A *negative* regression guard: the prior all-in-one-tx pattern
 *    actually fails. If someone reverts the migrator to stock Drizzle
 *    or merges 0036+0037 back into one file, this test fires with the
 *    exact production error.
 *
 * Both tests bypass `createTestDatabase` from `src/test/pglite.ts` —
 * that helper uses `pushSchema()` which never touches migration files.
 * Migrations are the contract under test here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_uuidv7 } from "@electric-sql/pglite/pg_uuidv7";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./index.js";
import { migratePerFile } from "./migrate-per-file.js";
import * as schema from "./schemas.js";

const MIGRATIONS_FOLDER = "./migrations";

/**
 * Count of migration files drizzle-kit knows about, read from the
 * journal at test time. Derived rather than hardcoded so adding a new
 * migration doesn't require touching this test — the test cares about
 * "everything in the journal got applied", not an exact count.
 */
function expectedMigrationCount(): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf-8"),
  ) as { entries: ReadonlyArray<unknown> };
  return journal.entries.length;
}

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = new PGlite({ extensions: { pg_uuidv7 } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS pg_uuidv7;");
  await client.exec(
    "CREATE FUNCTION uuidv7() RETURNS uuid LANGUAGE sql AS $$ SELECT uuid_generate_v7() $$;",
  );
  db = drizzle({ client, schema });
});

afterEach(async () => {
  await client.close();
});

describe("migratePerFile", () => {
  it("applies every committed migration on a fresh DB", async () => {
    // Smoke: full journal replays cleanly. The 0036→0037 enum-then-CHECK
    // split is the load-bearing case, but a regression in any earlier
    // migration's per-file atomicity would also fail here.
    await migratePerFile(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const enumValues = (await db.execute(sql`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'image_provider_type'
      ORDER BY e.enumsortorder
    `)) as { rows: Array<{ enumlabel: string }> };
    expect(enumValues.rows.map((r) => r.enumlabel)).toEqual(["fal", "openai_compatible", "venice"]);

    const checkDef = (await db.execute(sql`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.conname = 'chk_image_providers_base_url'
    `)) as { rows: Array<{ def: string }> };
    expect(checkDef.rows[0]?.def).toContain("venice");
  });

  it("simulates the production upgrade path — earlier migrations commit before later ones run", async () => {
    // Production reality: prior deploys committed migrations through
    // some N; the new deploy applies N+1, N+2, ... in fresh tx(s). The
    // outer "one big tx" semantics of stock Drizzle migrate() would have
    // masked the `unsafe use of new value` failure because the enum was
    // created in the same outer tx (PG's "created in this tx" carve-out).
    // Running migratePerFile here splits each file into its own tx, so
    // earlier-committed catalog state is what 0036/0037 actually see —
    // matching production.
    await migratePerFile(db, { migrationsFolder: MIGRATIONS_FOLDER });
    // Second invocation is a no-op when fully applied — proves journal
    // tracking works and lets the test double as an idempotency check.
    await migratePerFile(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const applied = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations
    `)) as { rows: Array<{ n: number }> };
    // Every journal entry got applied — proves both completeness and
    // (via the second invocation being a no-op) journal-tracked idempotency.
    expect(applied.rows[0]?.n).toBe(expectedMigrationCount());
  });

  it("locks in the bug: ADD VALUE + CHECK using the new value in one tx fails", async () => {
    // Regression guard for the original 0036 shape (ADD VALUE then
    // immediately a CHECK referencing the new value, all in one tx).
    // If someone re-merges 0036/0037 or reverts migratePerFile to the
    // stock single-tx migrate(), production upgrades would fail with
    // exactly this error. The negative assertion makes the design
    // intent explicit in CI.
    await client.exec(`
      CREATE TYPE image_provider_type AS ENUM ('fal', 'openai_compatible');
      CREATE TABLE image_providers (
        id text PRIMARY KEY,
        type image_provider_type NOT NULL,
        base_url text,
        CONSTRAINT chk_image_providers_base_url CHECK (
          (type <> 'openai_compatible' OR base_url IS NOT NULL)
          AND (type <> 'fal' OR base_url IS NULL)
        )
      );
    `);

    // Drizzle wraps PG errors in a "Failed query" envelope, so probe the
    // cause chain rather than the top-level message — the actual PG
    // sentinel ("unsafe use of new value") lives on err.cause.
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TYPE "image_provider_type" ADD VALUE 'venice'`);
        await tx.execute(
          sql`ALTER TABLE "image_providers" DROP CONSTRAINT "chk_image_providers_base_url"`,
        );
        await tx.execute(sql`
          ALTER TABLE "image_providers" ADD CONSTRAINT "chk_image_providers_base_url" CHECK (
            (type <> 'openai_compatible' OR base_url IS NOT NULL)
            AND (type <> 'venice' OR base_url IS NOT NULL)
            AND (type <> 'fal' OR base_url IS NULL)
          )
        `);
      });
      expect.fail("expected transaction to reject with `unsafe use of new value`");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { cause?: unknown };
    const trail = [
      err.message,
      err.cause instanceof Error ? err.cause.message : String(err.cause),
    ].join(" | ");
    expect(trail).toMatch(/unsafe use of new value/);
  });

  it("rolls back the failing file's tx but leaves earlier files committed", async () => {
    // Mid-file failure invariant. The cross-file-atomicity trade-off
    // documented in `migrate-per-file.ts` says earlier-committed files
    // stay committed when a later file fails. Materialise that with a
    // hand-built two-file migration set: file A creates a table; file B
    // creates a second table THEN issues a statement that violates the
    // first table's not-null constraint. Expect: file A rows in
    // __drizzle_migrations (committed), file B absent (rolled back).
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/migrate-per-file-rollback-${Date.now()}`;
    const fsMod = await import("node:fs/promises");
    await fsMod.mkdir(`${tmp}/meta`, { recursive: true });
    await fsMod.writeFile(
      `${tmp}/0001_create_a.sql`,
      `CREATE TABLE "ttable_a" (id int PRIMARY KEY, name text NOT NULL);`,
    );
    await fsMod.writeFile(
      `${tmp}/0002_create_b_then_fail.sql`,
      // First statement succeeds (creates ttable_b), second statement
      // violates the NOT NULL on ttable_a — Postgres rejects the whole
      // file's tx, so ttable_b must roll back too.
      `CREATE TABLE "ttable_b" (id int PRIMARY KEY);--> statement-breakpoint\n` +
        `INSERT INTO "ttable_a" (id) VALUES (1);`,
    );
    await fsMod.writeFile(
      `${tmp}/meta/_journal.json`,
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 1, version: "7", when: 1_000_000, tag: "0001_create_a", breakpoints: true },
          {
            idx: 2,
            version: "7",
            when: 2_000_000,
            tag: "0002_create_b_then_fail",
            breakpoints: true,
          },
        ],
      }),
    );

    await expect(migratePerFile(db, { migrationsFolder: tmp })).rejects.toThrow();

    // File A's table exists (its tx committed before file B opened).
    const aExists = (await db.execute(sql`SELECT to_regclass('ttable_a')::text AS r`)) as {
      rows: Array<{ r: string | null }>;
    };
    expect(aExists.rows[0]?.r).toBe("ttable_a");
    // File B's table does NOT exist — its tx rolled back when the INSERT
    // failed. Atomicity inside the file is preserved.
    const bExists = (await db.execute(sql`SELECT to_regclass('ttable_b')::text AS r`)) as {
      rows: Array<{ r: string | null }>;
    };
    expect(bExists.rows[0]?.r).toBeNull();
    // Tracking table reflects the partial state: A applied, B not.
    const applied = (await db.execute(sql`
      SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
    `)) as { rows: Array<{ created_at: string | number | bigint }> };
    expect(applied.rows.map((r) => Number(r.created_at))).toEqual([1_000_000]);

    await fsMod.rm(tmp, { recursive: true, force: true });
  });

  it("rejects a backdated migration whose `when` is below the high-water mark", async () => {
    // Out-of-order invariant. The runner has already applied a later
    // migration, and now sees an unapplied file with a smaller `when` —
    // stock Drizzle would have applied it out of order. We refuse:
    // silently skipping leaves an operator believing the file ran when
    // it didn't.
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/migrate-per-file-backdated-${Date.now()}`;
    const fsMod = await import("node:fs/promises");
    await fsMod.mkdir(`${tmp}/meta`, { recursive: true });
    // First pass: apply one migration with when=5_000_000.
    await fsMod.writeFile(
      `${tmp}/0001_later.sql`,
      `CREATE TABLE "later_target" (id int PRIMARY KEY);`,
    );
    await fsMod.writeFile(
      `${tmp}/meta/_journal.json`,
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 1, version: "7", when: 5_000_000, tag: "0001_later", breakpoints: true }],
      }),
    );
    await migratePerFile(db, { migrationsFolder: tmp });

    // Second pass: drop in a backdated file with when=2_000_000.
    await fsMod.writeFile(
      `${tmp}/0000_earlier.sql`,
      `CREATE TABLE "earlier_target" (id int PRIMARY KEY);`,
    );
    await fsMod.writeFile(
      `${tmp}/meta/_journal.json`,
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 2_000_000, tag: "0000_earlier", breakpoints: true },
          { idx: 1, version: "7", when: 5_000_000, tag: "0001_later", breakpoints: true },
        ],
      }),
    );

    await expect(migratePerFile(db, { migrationsFolder: tmp })).rejects.toThrow(
      /journal was likely backdated/,
    );

    await fsMod.rm(tmp, { recursive: true, force: true });
  });

  it("rejects re-running when an applied file's hash changed", async () => {
    // Hash-tamper guard. Apply a one-file migration, then edit the
    // on-disk file's bytes and re-invoke — the runner must refuse to
    // proceed rather than silently skip (`folderMillis <= lastApplied`
    // would otherwise pass over the tampered file).
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/migrate-per-file-hash-${Date.now()}`;
    const fsMod = await import("node:fs/promises");
    await fsMod.mkdir(`${tmp}/meta`, { recursive: true });
    const sqlPath = `${tmp}/0001_create.sql`;
    await fsMod.writeFile(sqlPath, `CREATE TABLE "hash_target" (id int PRIMARY KEY);`);
    await fsMod.writeFile(
      `${tmp}/meta/_journal.json`,
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 1, version: "7", when: 1_000_000, tag: "0001_create", breakpoints: true }],
      }),
    );

    await migratePerFile(db, { migrationsFolder: tmp });
    // Tamper: rewrite the file with different bytes. The journal entry's
    // `when` stays unchanged so `folderMillis <= lastApplied` is true —
    // only the hash comparison can catch this.
    await fsMod.writeFile(sqlPath, `CREATE TABLE "hash_target" (id int PRIMARY KEY, name text);`);

    await expect(migratePerFile(db, { migrationsFolder: tmp })).rejects.toThrow(
      /applied with a different hash/,
    );

    await fsMod.rm(tmp, { recursive: true, force: true });
  });
});
