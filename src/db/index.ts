import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { pinoNoticeHandler } from "./helpers.js";
import * as schema from "./schemas.js";

// Re-export the env-free type + helper trio. Stores import only the
// type, and the minimal-env entrypoints (`seed`, `setup/*`) import
// `transactor` from `./transactor.js` directly so they don't pull in
// the eager connection below.
export type { Database, Transaction, Transactor } from "./transactor.js";
export { transactor } from "./transactor.js";

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
