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

  // For a union of objects (discriminated or not), the union node itself has
  // no `properties` — they live on each branch. Pick the matching branch by
  // discriminator so descent recovers doubly-stringified fields inside it.
  const effectiveSchema =
    isPlainObject(value) && (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))
      ? (selectMatchingBranch(value, schema) ?? schema)
      : schema;

  if (isPlainObject(value)) {
    const properties = isPlainObject(effectiveSchema.properties)
      ? effectiveSchema.properties
      : undefined;
    const additional = isPlainObject(effectiveSchema.additionalProperties)
      ? effectiveSchema.additionalProperties
      : undefined;

    if (properties !== undefined || additional !== undefined) {
      let rewritten: Record<string, unknown> | undefined;
      for (const [key, childValue] of Object.entries(value)) {
        const childSchema = properties?.[key] ?? additional;
        if (childSchema === undefined) continue;
        const result = walk(childValue, childSchema, joinPath(path, key), out);
        if (result !== childValue) {
          if (rewritten === undefined) rewritten = { ...value };
          rewritten[key] = result;
        }
      }
      return rewritten ?? value;
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    let rewritten: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const child = walk(item, items, joinPath(path, String(i)), out);
      if (child !== item) {
        if (rewritten === undefined) rewritten = [...value];
        rewritten[i] = child;
      }
    }
    return rewritten ?? value;
  }

  return value;
}

/**
 * Pick the single matching branch from an `anyOf`/`oneOf` of object schemas
 * by checking that every `const`-valued property in the branch's `properties`
 * agrees with the corresponding field in the value. This is how discriminated
 * unions encode their tag (e.g. `kind: { const: "one_off" }`).
 *
 * Returns undefined when zero or multiple branches match — descent stays at
 * the union node and the value passes through. We never guess between
 * structurally compatible branches that lack a discriminator.
 */
function selectMatchingBranch(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;

    let match: Record<string, unknown> | undefined;
    for (const branch of branches) {
      if (!isPlainObject(branch)) continue;
      if (!branchDiscriminatorMatches(value, branch)) continue;
      if (match !== undefined) return undefined;
      match = branch;
    }
    if (match !== undefined) return match;
  }
  return undefined;
}

function branchDiscriminatorMatches(
  value: Record<string, unknown>,
  branch: Record<string, unknown>,
): boolean {
  const props = branch.properties;
  if (!isPlainObject(props)) return false;
  let sawConst = false;
  for (const [propKey, propSchema] of Object.entries(props)) {
    if (!isPlainObject(propSchema)) continue;
    if (!("const" in propSchema)) continue;
    sawConst = true;
    if (value[propKey] !== propSchema.const) return false;
  }
  return sawConst;
}

function expectedKind(schema: Record<string, unknown>): ExpectedKind {
  const t = schema.type;
  if (t === "object") return "object";
  if (t === "array") return "array";
  if (Array.isArray(t)) {
    // JSON Schema allows `type: ["string", "null"]` etc. for nullable values.
    // Only coerce when one non-null entry remains — `["object", "null"]` →
    // "object", but a mixed set like `["string", "object"]` keeps the string
    // legitimate and must not be coerced.
    const nonNull = t.filter((v) => v !== "null");
    if (nonNull.length === 1) {
      if (nonNull[0] === "object") return "object";
      if (nonNull[0] === "array") return "array";
    }
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
