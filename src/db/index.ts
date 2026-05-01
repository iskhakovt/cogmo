import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import { logger } from "../logger.js";
import * as schema from "./schemas.js";

// Route postgres-js NOTICEs and Drizzle's per-query trace through pino so
// they respect `LOG_LEVEL` instead of unconditionally hitting stdout via
// the driver's default `console.log`.
//
// - True ERRORs aren't NOTICEs — postgres-js rejects the query Promise
//   for those, so they always surface via thrown exceptions.
// - `logQuery` likewise only fires on successful query traces; failures
//   propagate via rejection and don't reach the logger here.
//
// `onnotice` receives messages of varying severity. Postgres' informational
// levels — DEBUG / LOG / INFO / NOTICE — go to `trace` (chattiest source;
// most are migration-time `relation already exists` skips). WARNING gets
// promoted to `logger.warn` so it shows at the default `info` level.
// Anything we don't recognise (ERROR-class messages don't normally reach
// here — postgres-js rejects the query Promise instead — but if a future
// driver change ever surfaces one, we'd want to know) falls through to
// `warn` rather than silently disappearing into `trace`.
const NOTICE_INFORMATIONAL = new Set(["DEBUG", "LOG", "INFO", "NOTICE"]);
const client = postgres(env.DATABASE_URL, {
  onnotice: (n) => {
    if (n.severity && NOTICE_INFORMATIONAL.has(n.severity)) {
      logger.trace({ pgNotice: n }, "postgres notice");
    } else {
      logger.warn({ pgNotice: n }, "postgres notice");
    }
  },
});

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
