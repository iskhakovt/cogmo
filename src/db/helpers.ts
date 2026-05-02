import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Notice } from "postgres";
import type { z } from "zod";
import { logger } from "../logger.js";

/**
 * Shared `onnotice` handler for postgres-js clients. Postgres' informational
 * levels (DEBUG / LOG / INFO / NOTICE) go to `trace` — most are migration-time
 * `relation already exists` skips. WARNING (and any unrecognised severity) is
 * promoted to `warn` so it surfaces at default `LOG_LEVEL=info`. ERROR-class
 * messages don't reach `onnotice` — postgres-js rejects the query Promise.
 */
const NOTICE_INFORMATIONAL = new Set(["DEBUG", "LOG", "INFO", "NOTICE"]);
export function pinoNoticeHandler(notice: Notice): void {
  if (notice.severity && NOTICE_INFORMATIONAL.has(notice.severity)) {
    logger.trace({ pgNotice: notice }, "postgres notice");
  } else {
    logger.warn({ pgNotice: notice }, "postgres notice");
  }
}

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

/**
 * JSONB column with Zod validation enforced at the driver boundary.
 *
 * The schema runs on every read (`fromDriver`) and every write (`toDriver`),
 * so unparseable shapes throw at the store layer instead of leaking into
 * domain code. Drizzle infers the column's TS type as `z.infer<typeof S>`,
 * eliminating the `JsonValue` cast pattern at call sites.
 *
 * `toDriver` returns a JSON string — Drizzle's built-in `jsonb()` does this
 * implicitly, but `customType` doesn't, so the wire format would be a raw
 * Postgres text literal otherwise (`hello` instead of `"hello"`) and the
 * server rejects it as invalid JSON. `fromDriver` receives the already-decoded
 * JS value because both postgres-js and PGlite parse JSONB on the way in.
 */
export function jsonbZod<S extends z.ZodType>(name: string, schema: S) {
  return customType<{ data: z.infer<S>; driverData: string }>({
    dataType() {
      return "jsonb";
    },
    toDriver(value) {
      return JSON.stringify(schema.parse(value));
    },
    fromDriver(value) {
      return schema.parse(value);
    },
  })(name);
}
