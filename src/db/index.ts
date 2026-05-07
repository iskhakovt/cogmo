import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { pinoNoticeHandler } from "./helpers.js";
import * as schema from "./schemas.js";

// Route postgres-js NOTICEs and Drizzle's per-query trace through pino so
// they respect `LOG_LEVEL` instead of unconditionally hitting stdout via
// the driver's default `console.log`. ERROR-class messages don't go
// through either hook — postgres-js rejects the query Promise instead.
const client = postgres(env.DATABASE_URL, { onnotice: pinoNoticeHandler });

export const db = drizzle({
  client,
  schema,
  logger: {
    logQuery(query, params) {
      logger.trace({ query, params }, "drizzle query");
    },
  },
});

/** Driver-agnostic database type — works with postgres-js, PGlite, or any PG driver. */
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
