/**
 * JSON Schema as Anthropic's structured outputs take it.
 *
 * The grammar supports a subset of JSON Schema (platform docs, Structured
 * outputs → JSON Schema limitations): the basic types, `enum` over
 * primitives, `const`, `anyOf`, `allOf`, `$ref` with `$defs` or
 * `definitions`, `default`, `required`, `additionalProperties: false`, a
 * fixed list of string formats, `pattern` without backreferences, lookaround
 * or word boundaries, and `minItems` of 0 or 1. Numeric bounds, length bounds
 * and every other array constraint are unsupported, as is an object not
 * closed with `additionalProperties: false`; sending one is a 400.
 */

import * as R from "remeda";
import type { JsonSchema } from "./types.js";

/** The string formats the grammar supports. */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Regex features the grammar lacks: backreferences, lookaround, word boundaries. */
const UNSUPPORTED_REGEX = /\\[1-9bB]|\(\?<?[=!]/;

/** Keywords that decide what a node admits. A node with none admits any value. */
const TYPING_KEYWORDS = ["type", "anyOf", "oneOf", "allOf", "$ref", "enum", "const"] as const;

/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAPS: ReadonlySet<string> = new Set(["properties", "$defs", "definitions"]);

/** Keywords whose value is a subschema or a list of them. */
const SUBSCHEMA_LISTS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf", "items"]);

/**
 * Whether any node of a JSON Schema admits an object with keys beyond its
 * `properties`: `additionalProperties` set to anything but `false`, as
 * `z.record` emits, or an untyped node (`{}`, from `z.unknown()` or
 * `z.any()`), which admits any value.
 */
export function hasOpenObject(node: unknown): boolean {
  if (typeof node === "boolean") return node;
  if (!R.isPlainObject(node)) return false;
  if (!TYPING_KEYWORDS.some((keyword) => keyword in node)) return true;
  if ("additionalProperties" in node && node.additionalProperties !== false) return true;
  return Object.entries(node).some(([keyword, value]) =>
    subschemasOf(keyword, value).some(hasOpenObject),
  );
}

/**
 * The schema as the grammar takes it. Every object is closed with
 * `additionalProperties: false`, so a schema with an open object has to go
 * elsewhere (see {@link hasOpenObject}). `oneOf` becomes `anyOf`, which admits
 * the same values when the variants are disjoint, as a discriminated union's
 * are. `$schema` names the dialect, not a constraint, and is dropped. Every
 * other keyword the grammar lacks moves into its node's description, where
 * the model still reads it; the caller validates the reply against the full
 * schema.
 */
export function toStructuredOutputSchema(schema: JsonSchema): Record<string, unknown> {
  return transformNode(schema);
}

function transformNode(node: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { $schema: _dialect, additionalProperties: _closed, description, ...rest } = node;
  const [kept, unsupported] = R.partition(Object.entries(rest), ([keyword, value]) =>
    grammarSupports(keyword, value),
  );
  const notes = [
    ...(typeof description === "string" ? [description] : []),
    ...(unsupported.length > 0 ? [describeKeywords(unsupported)] : []),
  ];
  return {
    ...Object.fromEntries(
      kept.map(([keyword, value]) => [
        keyword === "oneOf" ? "anyOf" : keyword,
        transformChildren(keyword, value),
      ]),
    ),
    ...(isObjectNode(node) && { additionalProperties: false }),
    ...(notes.length > 0 && { description: notes.join("\n\n") }),
  };
}

function grammarSupports(keyword: string, value: unknown): boolean {
  switch (keyword) {
    case "type":
    case "const":
    case "anyOf":
    case "oneOf":
    case "allOf":
    case "$ref":
    case "$defs":
    case "definitions":
    case "properties":
    case "required":
    case "items":
    case "title":
    case "default":
      return true;
    case "enum":
      return Array.isArray(value) && value.every((v) => v === null || typeof v !== "object");
    case "format":
      return typeof value === "string" && SUPPORTED_FORMATS.has(value);
    case "pattern":
      return typeof value === "string" && !UNSUPPORTED_REGEX.test(value);
    case "minItems":
      return value === 0 || value === 1;
    default:
      return false;
  }
}

function transformChildren(keyword: string, value: unknown): unknown {
  if (SUBSCHEMA_MAPS.has(keyword) && R.isPlainObject(value)) {
    return R.mapValues(value, transformSubschema);
  }
  if (SUBSCHEMA_LISTS.has(keyword)) {
    return Array.isArray(value) ? value.map(transformSubschema) : transformSubschema(value);
  }
  return value;
}

/** A boolean schema has no keywords to strip. */
function transformSubschema(value: unknown): unknown {
  return R.isPlainObject(value) ? transformNode(value) : value;
}

function subschemasOf(keyword: string, value: unknown): ReadonlyArray<unknown> {
  if (SUBSCHEMA_MAPS.has(keyword) && R.isPlainObject(value)) return Object.values(value);
  if (SUBSCHEMA_LISTS.has(keyword)) return Array.isArray(value) ? value : [value];
  return [];
}

function isObjectNode(node: Readonly<Record<string, unknown>>): boolean {
  return node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
}

/** The form the SDK's transform writes: `{minLength: 1, maxLength: 80}`. */
function describeKeywords(entries: ReadonlyArray<[string, unknown]>): string {
  return `{${entries.map(([keyword, value]) => `${keyword}: ${JSON.stringify(value)}`).join(", ")}}`;
}
