import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { withRetry } from "../util/with-retry.js";
import type * as schema from "./schemas.js";

/**
 * Driver-agnostic database type — works with postgres-js, PGlite, or any
 * PG driver. Defined here (separate from the eager `db` instance in
 * `./index.js`) so consumers that need only the type — or the
 * `Transactor` / `transactor()` helper — can import without triggering
 * the connection-and-env side effects of `./index.js`. The minimal
 * entrypoints (`seed`, `setup/*`) read `DATABASE_URL` directly from
 * `process.env` and rely on this contract.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The transaction handle Drizzle hands back inside `db.transaction(cb)`.
 * Inferred from the `Database` type so it tracks driver / schema changes
 * automatically — stores never have to know the concrete `PgTransaction`
 * generic.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Runs a callback inside a transaction. Stores accept a `Transactor`
 * instead of a full `Database` so non-transactional access becomes
 * unrepresentable — the store's field is a function, not a connection,
 * and every read or write has to go through `tx`. Narrows the
 * dependency surface stores can reach for and enforces the project's
 * "all DB operations use transactions" rule at the type level.
 */
export type Transactor = <T>(callback: (tx: Transaction) => Promise<T>) => Promise<T>;

/**
 * Adapter from a `Database` to a `Transactor`. Wraps each call in
 * `db.transaction(cb, { isolationLevel: "repeatable read" })` so every
 * tx gets snapshot isolation by default. `withRetry` handles the rare
 * `40001 serialization_failure` — 3 attempts total with jittered
 * exponential backoff (≈5 ms → 20 ms). Non-40001 errors short-circuit
 * via `AbortError`. Worst-case added latency under ~50 ms, well below
 * Inngest's per-step overhead, so the inner retries are effectively
 * free for genuinely transient snapshot staleness; persistent
 * conflicts (rare at single-user scale) surface to Inngest's
 * step-level retry budget.
 */
export function transactor(db: Database): Transactor {
  return <T>(cb: (tx: Transaction) => Promise<T>): Promise<T> =>
    withRetry(() => db.transaction(cb, { isolationLevel: "repeatable read" }), {
      retries: 2, // 3 attempts total
      minTimeoutMs: 5,
      maxTimeoutMs: 50,
      shouldRetry: isSerializationFailure,
      context: "tx-serialization-retry",
    });
}

/**
 * True for Postgres's `40001 serialization_failure` SQLSTATE — the
 * error a REPEATABLE READ or SERIALIZABLE tx raises when a concurrent
 * commit invalidated its snapshot. Drivers surface the SQLSTATE on
 * `err.code` (postgres-js, pg) but the property isn't typed, so we
 * read it through a narrow runtime check.
 */
function isSerializationFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "40001"
  );
}
