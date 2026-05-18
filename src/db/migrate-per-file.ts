/**
 * Per-file Drizzle migration runner — one transaction per migration file.
 *
 * Drop-in replacement for `migrate()` from `drizzle-orm/postgres-js/migrator`.
 * Same `drizzle.__drizzle_migrations` tracking table, same journal layout —
 * a DB whose migrations were applied with stock `migrate()` continues
 * seamlessly.
 *
 * Why the wrapper: stock `migrate()` wraps every pending migration in a
 * single outer transaction (`drizzle-orm/pg-core/dialect.js`, line 60 area).
 * Postgres rejects an `ALTER TYPE ... ADD VALUE` followed by any use of
 * the new value inside the same transaction — including in a later
 * migration file — with `unsafe use of new value`. On a fresh boot this
 * is masked because the enum was created in the same outer tx (the
 * "created in this tx" carve-out applies), but a production upgrade
 * where the prior enum value was committed in an earlier deploy fails
 * loudly. The right shape is one tx per file: the value commits before
 * the next file opens, so the CHECK/DEFAULT/SET that consumes it
 * succeeds. Matches Alembic's `transaction_per_migration` posture and
 * the [Drizzle community workaround for #3249](https://github.com/drizzle-team/drizzle-orm/issues/3249).
 *
 * Trade-off: a single migration file is still atomic, but cross-file
 * atomicity is gone — a failure in file N leaves files <N committed.
 * Drizzle's stock migrate() makes cross-file atomicity available; we
 * give that up so the enum-extension pattern works. In practice cross-
 * file atomicity rarely matters: the prior `migrate()` semantics still
 * left partial state on any failure that triggered a process exit
 * before the outer commit, and Cogmo's deployments are single-instance
 * with no parallel migrator races.
 */

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Database } from "./index.js";

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

interface AppliedRow {
  created_at: string | number | bigint;
}

/**
 * Apply pending migrations one transaction per file. Reads the journal
 * the same way `drizzle-orm/migrator`'s `readMigrationFiles` does, so
 * the on-disk layout is unchanged.
 */
export async function migratePerFile(
  db: Database,
  config: { migrationsFolder: string },
): Promise<void> {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(MIGRATIONS_SCHEMA)}`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const lastApplied = await readLastApplied(db);
  const migrations = readMigrationFiles(config);

  for (const migration of migrations) {
    if (migration.folderMillis <= lastApplied) continue;
    await db.transaction(async (tx) => {
      for (const stmt of migration.sql) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await tx.execute(sql.raw(trimmed));
      }
      await tx.execute(sql`
        INSERT INTO ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}
          (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})
      `);
    });
  }
}

/**
 * Read the most recent applied migration's `created_at`. The result
 * shape of `db.execute(SELECT ...)` differs by driver — postgres-js
 * returns an array-like, PGlite returns `{ rows: [...] }` — so unwrap
 * defensively rather than asserting one shape.
 */
async function readLastApplied(db: Database): Promise<number> {
  const result = await db.execute(sql`
    SELECT created_at FROM ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}
    ORDER BY created_at DESC LIMIT 1
  `);
  const rows: ReadonlyArray<AppliedRow> = Array.isArray(result)
    ? (result as ReadonlyArray<AppliedRow>)
    : ((result as { rows?: ReadonlyArray<AppliedRow> }).rows ?? []);
  const first = rows[0];
  return first ? Number(first.created_at) : 0;
}
