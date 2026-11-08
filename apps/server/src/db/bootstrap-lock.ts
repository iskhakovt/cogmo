import type { Sql } from "postgres";

/**
 * Advisory lock key serializing schema migration and default seeding across
 * processes. "cogmo" in ASCII, outside the int4 range `hashtext` keys occupy.
 */
export const BOOTSTRAP_LOCK_KEY = 427_070_811_503;

/** Runs `fn` holding the bootstrap lock. */
export type BootstrapLock = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * The bootstrap lock on `sql`, so concurrent `cogmo serve`, `cogmo seed` and
 * `cogmo setup` runs migrate and seed one at a time, and `pnpm db:migrate`
 * (`scripts/migrate.ts`) migrates in turn with them. Every read-then-insert
 * inside `fn` then sees the previous holder's rows.
 *
 * Session-level, on a reserved connection, taken before `fn` opens a
 * transaction (`.agents/rules/store-pattern.md`). `fn` runs on the pool's
 * other connections, so `sql` needs at least two; a smaller pool throws here.
 */
export function bootstrapLock(sql: Sql): BootstrapLock {
  // Typed `number`, but postgres-js keeps `?max=` and `PGMAX` as the string it
  // read and sizes its pool by comparing against it, so a numeric string opens
  // that many connections and any other string opens none.
  const max: unknown = sql.options.max;
  const size = Number(max);
  if (!(size >= 2)) {
    throw new Error(
      `the bootstrap lock needs a connection pool of at least 2, but max=${String(max)} ` +
        `opens ${Number.isNaN(size) ? "none" : size}`,
    );
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const session = await sql.reserve();
    try {
      await session`SELECT pg_advisory_lock(${BOOTSTRAP_LOCK_KEY})`;
      try {
        return await fn();
      } finally {
        await session`SELECT pg_advisory_unlock(${BOOTSTRAP_LOCK_KEY})`;
      }
    } finally {
      session.release();
    }
  };
}
