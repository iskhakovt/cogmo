import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
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
 * Adapter from a `Database` to a `Transactor`. Used at every store
 * construction site (`new DrizzleAgentStore(transactor(db))`) so the
 * store keeps no reference to the connection itself.
 */
export function transactor(db: Database): Transactor {
  return (cb) => db.transaction(cb);
}
