import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../env.js";
import * as schema from "./schemas.js";

export const db = drizzle({
  connection: env.DATABASE_URL,
  schema,
  logger: env.NODE_ENV === "development",
});

/** Driver-agnostic database type — works with postgres-js, PGlite, or any PG driver. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
