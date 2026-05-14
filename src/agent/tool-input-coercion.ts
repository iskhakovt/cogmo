/**
 * Coerce JSON-stringified nested objects/arrays back into their parsed form
 * before Zod validation.
 *
 * Some LLM providers occasionally serialize a nested object argument as a
 * JSON string — `{"schedule": "{\"kind\":\"one_off\",...}"}` instead of
 * `{"schedule": {"kind": "one_off", ...}}`. The outer parse succeeds but
 * Zod then rejects the inner field with "expected object, received string"
 * and the loop wastes round-trips on retries that the model can't fix.
 *
 * The recovery is intentionally narrow: at every position where the tool's
 * JSON Schema unambiguously demands an object or array (direct type, or a
 * union whose branches all expect the same kind), if the value is a string
 * we attempt one JSON.parse. If parsing fails or yields the wrong shape the
 * string is left in place so Zod surfaces a genuine type error.
 */

import type { JsonSchema } from "../llm/types.js";

export interface ToolInputCoercionResult {
  /** Possibly-rewritten input. Identical reference when no recovery fired. */
  value: unknown;
  /** Dot-paths of fields where stringified JSON was unwrapped. Empty in the common case. */
  coercedPaths: string[];
}

export function coerceToolInput(input: unknown, schema: JsonSchema): ToolInputCoercionResult {
  const coercedPaths: string[] = [];
  const value = walk(input, schema, "", coercedPaths);
  return { value, coercedPaths };
}

type ExpectedKind = "object" | "array" | "other";

function walk(value: unknown, schema: unknown, path: string, out: string[]): unknown {
  if (!isPlainObject(schema)) return value;

  const expected = expectedKind(schema);

  if (expected === "object" && typeof value === "string") {
    const parsed = tryJsonParse(value);
    if (isPlainObject(parsed)) {
      out.push(path === "" ? "<root>" : path);
      value = parsed;
    }
  } else if (expected === "array" && typeof value === "string") {
    const parsed = tryJsonParse(value);
    if (Array.isArray(parsed)) {
      out.push(path === "" ? "<root>" : path);
      value = parsed;
    }
  }

  if (isPlainObject(value) && isPlainObject(schema.properties)) {
    const properties = schema.properties;
    const rewritten: Record<string, unknown> = { ...value };
    let mutated = false;
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in rewritten)) continue;
      const child = walk(rewritten[key], propSchema, joinPath(path, key), out);
      if (child !== rewritten[key]) {
        rewritten[key] = child;
        mutated = true;
      }
    }
    return mutated ? rewritten : value;
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    let mutated = false;
    const rewritten = value.map((item, i) => {
      const child = walk(item, items, joinPath(path, String(i)), out);
      if (child !== item) mutated = true;
      return child;
    });
    return mutated ? rewritten : value;
  }

  return value;
}

function expectedKind(schema: Record<string, unknown>): ExpectedKind {
  const t = schema.type;
  if (t === "object") return "object";
  if (t === "array") return "array";
  if (Array.isArray(t)) {
    if (t.includes("object")) return "object";
    if (t.includes("array")) return "array";
  }

  // Union-of-objects (or union-of-arrays) is unambiguous; mixed unions are not.
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const kinds: ExpectedKind[] = branches.map((b) =>
      isPlainObject(b) ? expectedKind(b) : "other",
    );
    const first = kinds[0];
    if (first !== undefined && first !== "other" && kinds.every((k) => k === first)) {
      return first;
    }
  }

  return "other";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}
