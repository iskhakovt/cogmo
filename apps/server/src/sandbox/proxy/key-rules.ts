/**
 * Reads a request body the way the daemon's Go `encoding/json` decoder
 * would, so the policy checks exactly the fields the daemon will act on.
 *
 * Go matches an object key to a struct field case-insensitively, with
 * Unicode simple folding (`ſ` matches `s`). So every object that holds
 * struct fields obeys the key rules: no non-ASCII key, no `__proto__`,
 * `constructor` or `prototype`, and no two keys that differ only in case.
 * What is left folds to at most one field, by ASCII lower-casing.
 *
 * The Zod schema is the allowlist. Each key is mapped to the schema's
 * canonical field name; a key the schema does not list is dropped when its
 * value is zero and `denied` otherwise. The keys of a data-keyed map
 * (`z.record`) are data and are kept as sent, except `__proto__`, which no
 * plain object can carry as data. The folded value is then parsed by the
 * schema, so a value of the wrong shape is `malformed`.
 */

import { err, ok, Result } from "neverthrow";
import * as R from "remeda";
import { z } from "zod";
import { denied, malformed, type ProxyRejection } from "./rejection.js";

const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Lists whose empty value is not "unset": the daemon reads `[]` as "clear the
 * runtime's defaults", so `MaskedPaths: []` unmasks every path (what
 * `--security-opt systempaths=unconfined` sends). Compared case-folded.
 */
const EMPTY_LIST_SETS: ReadonlySet<string> = new Set(["maskedpaths", "readonlypaths"]);

/** Parse `raw` as a JSON object, fold its keys onto `schema`, and parse it. */
export function parseBody<S extends z.ZodType>(
  raw: Buffer,
  schema: S,
): Result<z.output<S>, ProxyRejection> {
  return parseJson(raw)
    .andThen((value) =>
      isJsonObject(value) ? ok(value) : err(malformed("request body must be a JSON object")),
    )
    .andThen((value) => fold(value, schema, ""))
    .andThen((folded): Result<z.output<S>, ProxyRejection> => {
      const parsed = schema.safeParse(folded);
      return parsed.success ? ok(parsed.data) : err(malformed(describeIssues(parsed.error)));
    });
}

/**
 * Zero as the daemon reads a field nobody set: `null`, `false`, `0`, `""`,
 * an empty list (except under `EMPTY_LIST_SETS`), or an object whose values
 * are all zero. The Docker CLI sends `Devices` and the `Blkio*` device lists
 * as `[]`.
 */
function isZero(key: string, value: unknown): boolean {
  if (value === null || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0 && !EMPTY_LIST_SETS.has(key.toLowerCase());
  return isJsonObject(value) && Object.entries(value).every(([k, v]) => isZero(k, v));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: Buffer): Result<unknown, ProxyRejection> {
  try {
    return ok(JSON.parse(raw.toString("utf8")));
  } catch (cause) {
    return err(malformed(`invalid JSON in request body: ${String(cause)}`));
  }
}

function fold(
  value: unknown,
  schema: z.core.$ZodType,
  path: string,
): Result<unknown, ProxyRejection> {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject && isJsonObject(value)) {
    return foldStruct(value, inner.shape, path);
  }
  if (inner instanceof z.ZodRecord && isJsonObject(value)) {
    return foldMap(value, inner.valueType, path);
  }
  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    return Result.combine(value.map((item, i) => fold(item, inner.element, `${path}[${i}]`)));
  }
  return ok(value);
}

function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodNullable
    ? unwrap(schema.unwrap())
    : schema;
}

function foldStruct(
  value: Readonly<Record<string, unknown>>,
  shape: Readonly<Record<string, z.core.$ZodType>>,
  path: string,
): Result<Record<string, unknown>, ProxyRejection> {
  const keys = Object.keys(value);
  const canonical = new Map(Object.keys(shape).map((name) => [name.toLowerCase(), name]));
  return checkKeys(keys, path)
    .andThen(() =>
      Result.combine(
        keys.map((key): Result<Array<[string, unknown]>, ProxyRejection> => {
          const name = canonical.get(key.toLowerCase());
          const field = name === undefined ? undefined : shape[name];
          if (name === undefined || field === undefined) {
            return isZero(key, value[key]) ? ok([]) : err(denied(join(path, key)));
          }
          return fold(value[key], field, join(path, name)).map((v) => [[name, v]]);
        }),
      ),
    )
    .map((groups) => Object.fromEntries(groups.flat()));
}

function foldMap(
  value: Readonly<Record<string, unknown>>,
  valueSchema: z.core.$ZodType,
  path: string,
): Result<Record<string, unknown>, ProxyRejection> {
  return Result.combine(
    Object.entries(value).map(([key, item]) =>
      key === "__proto__"
        ? err(malformed(`${path} has a __proto__ key`))
        : fold(item, valueSchema, `${path}[${key}]`).map((v) => [key, v] as const),
    ),
  ).map((entries) => Object.fromEntries(entries));
}

function checkKeys(keys: ReadonlyArray<string>, path: string): Result<void, ProxyRejection> {
  const where = path === "" ? "the request body" : path;
  const bad = keys.find((key) => /\P{ASCII}/u.test(key) || RESERVED_KEYS.has(key.toLowerCase()));
  if (bad !== undefined) return err(malformed(`${where} has a key the proxy refuses: ${bad}`));
  const folded = R.groupBy(keys, (key) => key.toLowerCase());
  const clash = Object.values(folded).find((group) => group.length > 1);
  if (clash !== undefined) {
    return err(malformed(`${where} has keys that differ only in case: ${clash.join(", ")}`));
  }
  return ok(undefined);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
