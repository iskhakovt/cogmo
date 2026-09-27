import type { Sql } from "postgres";

/**
 * Advisory lock key serializing schema migration and default seeding across
 * processes. "cogmo" in ASCII, outside the int4 range `hashtext` keys occupy.
 */
export const BOOTSTRAP_LOCK_KEY = 427_070_811_503;

/**
 * Run `fn` holding the bootstrap lock, so concurrent `cogmo serve`, `cogmo seed`
 * and `cogmo setup` runs migrate and seed one at a time. Every read-then-insert
 * inside `fn` then sees the previous holder's rows.
 *
 * The lock is session-level, on a reserved connection, and taken before `fn`
 * opens any transaction. A `pg_advisory_xact_lock` inside a REPEATABLE READ
 * transaction would not serialize an insert-only race: the statement that
 * waits for it also takes the snapshot. `fn` works on the pool's other
 * connections, so `sql` needs at least two.
 */
export async function withBootstrapLock<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
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
}
