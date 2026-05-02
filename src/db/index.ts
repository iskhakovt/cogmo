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
