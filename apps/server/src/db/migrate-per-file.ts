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
 *
 * **No advisory lock.** Stock `migrate()` takes a `pg_advisory_lock` to
 * serialize concurrent migrator runs. This wrapper doesn't, because
 * Cogmo deploys single-instance (one process owns the DB at a time —
 * see CLAUDE.md). If multi-instance deploys ever happen, wrap the loop
 * in `pg_advisory_lock(NUMERIC) / pg_advisory_unlock(NUMERIC)` at the
 * top level — Drizzle's helper hashes "drizzle" into the lock key, the
 * same convention works here.
 *
 * **Hash validation.** Before applying any pending migration, the
 * already-applied rows are compared against the on-disk files' hashes.
 * If an applied file's bytes were edited after the fact (operators
 * shouldn't do this, but accidents happen), the runner throws — same
 * posture as stock `migrate()`. Matches `drizzle-orm/pg-core/dialect.ts`
 * which only verifies via `lastDbMigration.hash !== migration.hash` for
 * the about-to-apply file; the broader check here is strictly safer.
 */

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Database } from "./index.js";

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

interface AppliedRow {
  hash: string;
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

  const applied = await readApplied(db);
  const appliedByMillis = new Map(applied.map((r) => [Number(r.created_at), r.hash]));
  const lastApplied = applied[0] ? Number(applied[0].created_at) : 0;
  const migrations = readMigrationFiles(config);

  for (const migration of migrations) {
    // Hash check on already-applied files: catches accidental in-place
    // edits to historical SQL. Stock `migrate()` only compares the
    // single about-to-apply file; checking the full applied set is
    // strictly safer and equally cheap (Map lookup per file).
    const priorHash = appliedByMillis.get(migration.folderMillis);
    if (priorHash !== undefined) {
      if (priorHash !== migration.hash) {
        throw new Error(
          `migration ${migration.folderMillis} was applied with a different hash ` +
            `than the on-disk file. Already-applied migrations must not be edited. ` +
            `On-disk hash: ${migration.hash.slice(0, 12)}…; recorded: ${priorHash.slice(0, 12)}…`,
        );
      }
      continue;
    }
    // Not in the applied map. If its `folderMillis` is still ≤ the
    // high-water mark, the journal has been backdated — a file was
    // added with a `when` timestamp that pre-dates already-applied
    // migrations but the file itself was never applied. Stock Drizzle
    // would have applied this out of order; we refuse rather than
    // silently skip, because skipping leaves a file that an operator
    // believed would run but never did.
    if (migration.folderMillis <= lastApplied) {
      throw new Error(
        `migration ${migration.folderMillis} is unapplied but its journal "when" is ` +
          `≤ the most recent applied migration (${lastApplied}). The journal was likely ` +
          `backdated after later migrations had already shipped. Fix the journal entry's ` +
          `"when" to be > ${lastApplied}, or delete the file if it shouldn't apply.`,
      );
    }
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
 * Read all applied migrations newest-first. The result shape of
 * `db.execute(SELECT ...)` differs by driver — postgres-js returns an
 * array-like, PGlite returns `{ rows: [...] }` — so unwrap defensively
 * rather than asserting one shape.
 */
async function readApplied(db: Database): Promise<ReadonlyArray<AppliedRow>> {
  const result = await db.execute(sql`
    SELECT hash, created_at FROM ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}
    ORDER BY created_at DESC
  `);
  return Array.isArray(result)
    ? (result as ReadonlyArray<AppliedRow>)
    : ((result as { rows?: ReadonlyArray<AppliedRow> }).rows ?? []);
}
