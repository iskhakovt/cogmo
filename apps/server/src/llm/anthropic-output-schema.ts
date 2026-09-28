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

/** Keywords that hold definitions for `$ref` to name. */
const DEFINITIONS: ReadonlySet<string> = new Set(["$defs", "definitions"]);

/** Keywords whose value is a subschema or a list of them. */
const SUBSCHEMA_LISTS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf", "items"]);

/**
 * Whether any node of a JSON Schema is open: an object with
 * `additionalProperties` set to anything but `false`, as `z.record` emits,
 * or an untyped node (`{}`, from `z.unknown()` or `z.any()`), which admits
 * any value. An object that leaves `additionalProperties` unset counts as
 * closed, since {@link toStructuredOutputSchema} closes it.
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
 * Whether a schema refers to itself: a local `$ref` whose target, followed
 * through the refs inside it, leads back to itself. Zod emits one for a
 * schema nested in itself: `$ref: "#"` at the root, a `$defs` entry below
 * it. The grammar takes neither. A cycle through definitions is a 400; a
 * root that refers to itself is accepted, but the reply can't contain the
 * nested value. A ref that resolves nowhere counts as no cycle.
 */
export function hasRecursiveRef(schema: JsonSchema): boolean {
  const explored = new Set<string>();
  const leadsBack = (pointer: string, path: ReadonlySet<string>): boolean => {
    if (path.has(pointer)) return true;
    if (explored.has(pointer)) return false;
    const target = resolvePointer(schema, pointer);
    if (target === undefined) return false;
    const onPath = new Set(path).add(pointer);
    if (localRefs(target).some((ref) => leadsBack(ref, onPath))) return true;
    explored.add(pointer);
    return false;
  };
  return leadsBack("#", new Set());
}

/**
 * The local refs a node's grammar would expand: those in its own subschemas,
 * but not in the definitions it holds, which count only where referenced.
 */
function localRefs(node: unknown): ReadonlyArray<string> {
  if (!R.isPlainObject(node)) return [];
  const own = typeof node.$ref === "string" && node.$ref.startsWith("#") ? [node.$ref] : [];
  return [
    ...own,
    ...Object.entries(node).flatMap(([keyword, value]) =>
      DEFINITIONS.has(keyword) ? [] : subschemasOf(keyword, value).flatMap(localRefs),
    ),
  ];
}

/**
 * The value with its string `enum` and `const` values in the schema's
 * capitalization. Structured outputs don't guarantee it: a reply can differ
 * from a member in capitalization alone, and Anthropic's advice is to
 * compare case-insensitively (platform docs, Structured outputs → Invalid
 * outputs). A string that matches no member exactly and one member
 * case-insensitively takes that member. In an `anyOf` or `oneOf`, a variant
 * that admits the value as it is wins over one that restores it. A tuple
 * restores each position against its `prefixItems` entry. Returns `value`
 * itself when nothing changes. The schema must not be recursive
 * ({@link hasRecursiveRef}).
 */
export function restoreLiteralCasing(schema: JsonSchema, value: unknown): unknown {
  return restore(schema, value, schema).value;
}

/** A value after {@link restore}, with whether its node admits it. */
interface Restored {
  value: unknown;
  /** Whether the node's types, literals and required properties admit the value. */
  fits: boolean;
  changed: boolean;
}

type RestoreStep = (value: unknown) => Restored;

/** `value` restored against every keyword of `node`: all must admit it. */
function restore(node: unknown, value: unknown, root: JsonSchema): Restored {
  if (!R.isPlainObject(node)) return { value, fits: node !== false, changed: false };
  return chain(
    [
      (current) => restoreRef(node.$ref, current, root),
      (current) => ({ value: current, fits: admitsType(node.type, current), changed: false }),
      (current) => restoreLiteral("const" in node ? [node.const] : undefined, current),
      (current) => restoreLiteral(Array.isArray(node.enum) ? node.enum : undefined, current),
      (current) => restoreProperties(node, current, root),
      (current) => restoreItems(node, current, root),
      (current) => restoreVariant([node.anyOf, node.oneOf].flatMap(asList), current, root),
      ...asList(node.allOf).map(
        (member): RestoreStep =>
          (current) =>
            restore(member, current, root),
      ),
    ],
    value,
  );
}

/** `value` through each step in turn, fitting only if every step admits it. */
function chain(steps: ReadonlyArray<RestoreStep>, value: unknown): Restored {
  return steps.reduce<Restored>((acc, step) => {
    const next = step(acc.value);
    return {
      value: next.value,
      fits: acc.fits && next.fits,
      changed: acc.changed || next.changed,
    };
  }, kept(value));
}

function restoreRef(ref: unknown, value: unknown, root: JsonSchema): Restored {
  const target = typeof ref === "string" ? resolvePointer(root, ref) : undefined;
  return target === undefined ? kept(value) : restore(target, value, root);
}

function restoreLiteral(members: ReadonlyArray<unknown> | undefined, value: unknown): Restored {
  if (members === undefined || members.some((member) => R.isDeepEqual(member, value))) {
    return kept(value);
  }
  const matches =
    typeof value === "string"
      ? members.filter(
          (member) => typeof member === "string" && member.toLowerCase() === value.toLowerCase(),
        )
      : [];
  return matches.length === 1
    ? { value: matches[0], fits: true, changed: true }
    : { value, fits: false, changed: false };
}

function restoreProperties(
  node: Readonly<Record<string, unknown>>,
  value: unknown,
  root: JsonSchema,
): Restored {
  if (!R.isPlainObject(value)) return kept(value);
  const properties = R.isPlainObject(node.properties) ? node.properties : {};
  const entries = Object.entries(value).map(
    ([key, member]) =>
      [
        key,
        Object.hasOwn(properties, key) ? restore(properties[key], member, root) : kept(member),
      ] as const,
  );
  const required = asList(node.required);
  const changed = entries.some(([, restored]) => restored.changed);
  return {
    value: changed ? Object.fromEntries(entries.map(([key, r]) => [key, r.value])) : value,
    fits:
      entries.every(([, restored]) => restored.fits) &&
      required.every((key) => typeof key === "string" && Object.hasOwn(value, key)),
    changed,
  };
}

/** Each element against its `prefixItems` entry, and `items` past those. */
function restoreItems(
  node: Readonly<Record<string, unknown>>,
  value: unknown,
  root: JsonSchema,
): Restored {
  if (!Array.isArray(value)) return kept(value);
  const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : [];
  const restored = value.map((item, position) => {
    const schema = position < prefix.length ? prefix[position] : node.items;
    return schema === undefined ? kept(item) : restore(schema, item, root);
  });
  const changed = restored.some((r) => r.changed);
  return {
    value: changed ? restored.map((r) => r.value) : value,
    fits: restored.every((r) => r.fits),
    changed,
  };
}

function restoreVariant(
  variants: ReadonlyArray<unknown>,
  value: unknown,
  root: JsonSchema,
): Restored {
  if (variants.length === 0) return kept(value);
  const restored = variants.map((variant) => restore(variant, value, root));
  return (
    restored.find((r) => r.fits && !r.changed) ??
    restored.find((r) => r.fits) ?? { value, fits: false, changed: false }
  );
}

/** Predicates for the JSON Schema type names. */
const TYPE_TESTS: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  ["null", (value: unknown) => value === null],
  ["boolean", (value: unknown) => typeof value === "boolean"],
  ["string", (value: unknown) => typeof value === "string"],
  ["number", (value: unknown) => typeof value === "number"],
  ["integer", (value: unknown) => Number.isInteger(value)],
  ["array", (value: unknown) => Array.isArray(value)],
  ["object", (value: unknown) => R.isPlainObject(value)],
]);

/** Whether `type`, one name or a list, admits the value. An unknown name admits anything. */
function admitsType(type: unknown, value: unknown): boolean {
  if (type === undefined) return true;
  return asList(type).some(
    (name) => typeof name !== "string" || (TYPE_TESTS.get(name)?.(value) ?? true),
  );
}

function kept(value: unknown): Restored {
  return { value, fits: true, changed: false };
}

function asList(value: unknown): ReadonlyArray<unknown> {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The node a local JSON Pointer ref (`#`, `#/$defs/Name`) names, if any. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "#") return root;
  if (!pointer.startsWith("#/")) return undefined;
  return pointer
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, segment) => {
      if (Array.isArray(node)) return node[Number(segment)];
      return R.isPlainObject(node) && Object.hasOwn(node, segment) ? node[segment] : undefined;
    }, root);
}

/**
 * The schema as the grammar takes it. Every object is closed with
 * `additionalProperties: false`, so a schema with an open node has to go
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
