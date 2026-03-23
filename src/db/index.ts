import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

export const db = drizzle({
  connection: env.DATABASE_URL,
  schema,
  logger: env.NODE_ENV === "development",
});

export type Database = typeof db;
