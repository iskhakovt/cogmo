import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Notice } from "postgres";
import * as R from "remeda";
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
 * A lone surrogate as `JSON.stringify` renders it.
 *
 * Well-formed `JSON.stringify` (ES2019) emits an unpaired UTF-16 code unit as
 * a lowercase `\udXXX` escape and leaves valid pairs as literal characters, so
 * every `\ud8`–`\udf` escape in its output came from a lone surrogate. The
 * reverse doesn't hold: a string whose *text* contains a backslash before
 * `ud800` encodes to `\\ud800` and matches too. That direction is a false
 * positive, which only costs one extra sanitising pass, so the test is sound
 * as a fast negative for the common case.
 */
const ESCAPED_LONE_SURROGATE = /\\ud[89a-f]/i;

/**
 * Well-form every string reachable from a JSON-shaped value, object keys
 * included, replacing lone surrogates with U+FFFD.
 *
 * Only arrays and plain objects are walked. Anything else (a `Date`, a class
 * instance) is handed to `JSON.stringify` untouched so its own `toJSON`
 * governs the encoding.
 *
 * Two keys that differ only in their lone surrogates map onto one replacement
 * and collapse to the last of them — the same rule Postgres applies to
 * duplicate `jsonb` keys, so the stored row is unchanged either way.
 */
function toWellFormedDeep(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed();
  if (Array.isArray(value)) return value.map(toWellFormedDeep);
  if (R.isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.toWellFormed(), toWellFormedDeep(v)]),
    );
  }
  return value;
}

/**
 * Encode a value as JSON text Postgres accepts for a `jsonb` column.
 *
 * A JS string can hold unpaired UTF-16 surrogates; JSON text cannot. Untrusted
 * model output reaches `messages.content` through `tool_use.input`, so a stray
 * lone surrogate is input rather than a bug on our side — and Postgres rejects
 * the escaped form with `22P02 invalid input syntax for type json` ("Unicode
 * low surrogate must follow a high surrogate"). That write happens after the
 * turn's tool side effects have already run, so the rejection is a poison
 * pill: deterministic on every Inngest retry, with the side effects repeating
 * each time. Lone surrogates are unrepresentable in the target encoding
 * whichever way we turn, so substituting U+FFFD — exactly what UTF-8 encoding
 * does to them — is the option that lets the turn land.
 *
 * The common path pays one regex test over the encoded text; the value is only
 * walked and re-encoded when that test hits. Sanitising is logged because it
 * silently changes what the row stores.
 */
export function stringifyWellFormedJson(value: unknown, column: string): string {
  const encoded = JSON.stringify(value);
  if (!ESCAPED_LONE_SURROGATE.test(encoded)) return encoded;
  logger.warn({ column }, "jsonb value contained lone surrogates — replaced with U+FFFD");
  return JSON.stringify(toWellFormedDeep(value));
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
 * server rejects it as invalid JSON. Encoding goes through
 * {@link stringifyWellFormedJson}: this is the one place a JS value becomes
 * Postgres JSON text, so it is where the UTF-16-vs-JSON gap gets closed for
 * every JSONB column at once. `fromDriver` receives the already-decoded JS
 * value because both postgres-js and PGlite parse JSONB on the way in.
 */
export function jsonbZod<S extends z.ZodType>(name: string, schema: S) {
  return customType<{ data: z.infer<S>; driverData: string }>({
    dataType() {
      return "jsonb";
    },
    toDriver(value) {
      return stringifyWellFormedJson(schema.parse(value), name);
    },
    fromDriver(value) {
      return schema.parse(value);
    },
  })(name);
}
