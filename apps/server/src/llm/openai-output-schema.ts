/**
 * JSON Schema as OpenAI's strict mode takes it.
 *
 * `response_format` with `strict: true` constrains decoding to a subset of
 * JSON Schema (developers.openai.com, Structured model outputs → Supported
 * schemas): every object closed with `additionalProperties: false` and every
 * property listed in `required`; `anyOf` but not `oneOf`, `allOf`, `not` or
 * the conditionals; a fixed list of string formats; numeric bounds, `pattern`,
 * `minItems` and `maxItems`. A schema outside it is a 400 under strict mode.
 */

import * as R from "remeda";
import type { JsonSchema } from "./types.js";

/** The string formats strict mode supports. */
const STRICT_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

/**
 * Keywords strict mode takes whatever their value. `const`, `default`,
 * `minLength` and `maxLength` go unlisted in the docs; the API accepts them.
 */
const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "type",
  "required",
  "$ref",
  "enum",
  "const",
  "description",
  "default",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);

/**
 * Whether strict mode takes the schema. A schema it can't, such as a
 * pipeline stage's open JSON output schema, an optional property or a
 * discriminated union's `oneOf`, goes with `strict: false`.
 */
export function fitsStrictMode(schema: JsonSchema): boolean {
  return !("anyOf" in schema) && fitsNode(schema);
}

/** A node fits when it is typed, closed if an object, and every keyword fits. */
function fitsNode(node: unknown): boolean {
  if (!R.isPlainObject(node)) return false;
  if (!("type" in node || "anyOf" in node || "$ref" in node)) return false;
  if (isObjectNode(node) && !isClosedWithAllRequired(node)) return false;
  return Object.entries(node).every(([keyword, value]) => keywordFits(keyword, value));
}

function keywordFits(keyword: string, value: unknown): boolean {
  switch (keyword) {
    case "properties":
    case "$defs":
    case "definitions":
      return R.isPlainObject(value) && Object.values(value).every(fitsNode);
    case "items":
      return fitsNode(value);
    case "anyOf":
      return Array.isArray(value) && value.every(fitsNode);
    case "additionalProperties":
      return value === false;
    case "format":
      return typeof value === "string" && STRICT_FORMATS.has(value);
    default:
      return STRICT_KEYWORDS.has(keyword);
  }
}

function isClosedWithAllRequired(node: Readonly<Record<string, unknown>>): boolean {
  if (node.additionalProperties !== false) return false;
  const required = Array.isArray(node.required) ? node.required : [];
  const properties = R.isPlainObject(node.properties) ? Object.keys(node.properties) : [];
  return properties.every((name) => required.includes(name));
}

function isObjectNode(node: Readonly<Record<string, unknown>>): boolean {
  return node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
}
