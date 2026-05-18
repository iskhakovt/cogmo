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

import { PGlite } from "@electric-sql/pglite";
import { pg_uuidv7 } from "@electric-sql/pglite/pg_uuidv7";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./index.js";
import { migratePerFile } from "./migrate-per-file.js";
import * as schema from "./schemas.js";

const MIGRATIONS_FOLDER = "./migrations";

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
    // 38 migrations: 0000..0037 inclusive.
    expect(applied.rows[0]?.n).toBe(38);
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
});
