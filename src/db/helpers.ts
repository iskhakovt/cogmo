import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Extract exactly one row from a query result. Throws if zero or multiple rows.
 *
 * Workaround until Drizzle adds native .single() / .firstOrThrow().
 * See: https://github.com/drizzle-team/drizzle-orm/issues/4363
 */
export function single<T>(rows: T[]): T {
  if (rows.length === 0) {
    throw new Error("Expected exactly 1 row, got 0");
  }
  if (rows.length > 1) {
    throw new Error(`Expected exactly 1 row, got ${rows.length}`);
  }
  return rows[0] as T;
}

/** UUIDv7 primary key — DB-generated, time-ordered. */
export function pk() {
  return uuid("id").primaryKey().default(sql`uuidv7()`);
}

/** created_at TIMESTAMPTZ DEFAULT now() */
export function ts() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}
