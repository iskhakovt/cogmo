import { describe, expect, it } from "vitest";
import { hasOpenObject, toStructuredOutputSchema } from "./anthropic-output-schema.js";
import type { JsonSchema } from "./types.js";

/** A closed object with one property, `value`, carrying `node`. */
function wrap(node: Record<string, unknown>): JsonSchema {
  return {
    type: "object",
    properties: { value: node },
    required: ["value"],
    additionalProperties: false,
  };
}

function sentValue(node: Record<string, unknown>): unknown {
  const out = toStructuredOutputSchema(wrap(node));
  const properties = out.properties;
  if (typeof properties !== "object" || properties === null || !("value" in properties)) {
    throw new Error("transform dropped the value property");
  }
  return properties.value;
}

describe("toStructuredOutputSchema", () => {
  it.each<[string, Record<string, unknown>]>([
    ["enum of strings", { type: "string", enum: ["style", "domain", "memory"] }],
    ["enum of numbers, bools and null", { enum: [1, 2.5, true, null] }],
    ["const", { type: "string", const: "new" }],
    ["nullable type", { type: ["string", "null"] }],
    ["default", { type: "null", default: null }],
    ["title", { type: "string", title: "Name" }],
    ["supported format", { type: "string", format: "date-time" }],
    ["simple pattern", { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }],
    ["minItems 0", { type: "array", items: { type: "string" }, minItems: 0 }],
    ["minItems 1", { type: "array", items: { type: "string" }, minItems: 1 }],
    ["$ref", { $ref: "#/$defs/Person" }],
  ])("keeps %s", (_label, node) => {
    expect(sentValue(node)).toEqual(node);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      "minLength",
      { type: "string", minLength: 1 },
      { type: "string", description: "{minLength: 1}" },
    ],
    [
      "maxLength",
      { type: "string", maxLength: 80 },
      { type: "string", description: "{maxLength: 80}" },
    ],
    ["minimum", { type: "integer", minimum: 1 }, { type: "integer", description: "{minimum: 1}" }],
    ["maximum", { type: "number", maximum: 9 }, { type: "number", description: "{maximum: 9}" }],
    [
      "exclusiveMinimum",
      { type: "number", exclusiveMinimum: 0 },
      { type: "number", description: "{exclusiveMinimum: 0}" },
    ],
    [
      "exclusiveMaximum",
      { type: "number", exclusiveMaximum: 1 },
      { type: "number", description: "{exclusiveMaximum: 1}" },
    ],
    [
      "multipleOf",
      { type: "number", multipleOf: 5 },
      { type: "number", description: "{multipleOf: 5}" },
    ],
    [
      "minItems above 1",
      { type: "array", items: { type: "string" }, minItems: 2 },
      { type: "array", items: { type: "string" }, description: "{minItems: 2}" },
    ],
    [
      "maxItems",
      { type: "array", items: { type: "string" }, maxItems: 20 },
      { type: "array", items: { type: "string" }, description: "{maxItems: 20}" },
    ],
    [
      "uniqueItems",
      { type: "array", items: { type: "string" }, uniqueItems: true },
      { type: "array", items: { type: "string" }, description: "{uniqueItems: true}" },
    ],
    [
      "an unsupported format",
      { type: "string", format: "regex" },
      { type: "string", description: '{format: "regex"}' },
    ],
    [
      "a pattern with lookahead",
      { type: "string", pattern: "^(?!\\.)[a-z.]+$" },
      { type: "string", description: '{pattern: "^(?!\\\\.)[a-z.]+$"}' },
    ],
    [
      "a pattern with a backreference",
      { type: "string", pattern: "^(a)\\1$" },
      { type: "string", description: '{pattern: "^(a)\\\\1$"}' },
    ],
    [
      "a pattern with a word boundary",
      { type: "string", pattern: "\\bword\\b" },
      { type: "string", description: '{pattern: "\\\\bword\\\\b"}' },
    ],
    [
      "an enum of objects",
      { enum: [{ a: 1 }], type: "object" },
      { type: "object", additionalProperties: false, description: '{enum: [{"a":1}]}' },
    ],
  ])("moves %s into the description", (_label, node, sent) => {
    expect(sentValue(node)).toEqual(sent);
  });

  it("appends stripped keywords to an existing description", () => {
    expect(
      sentValue({ type: "string", description: "The fact", minLength: 1, maxLength: 80 }),
    ).toEqual({ type: "string", description: "The fact\n\n{minLength: 1, maxLength: 80}" });
  });

  it("closes every object, nested ones included", () => {
    const sent = toStructuredOutputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
        maybe: {
          anyOf: [{ type: "object", properties: {} }, { type: "null" }],
        },
        either: { type: ["object", "null"], properties: {} },
        ref: { $ref: "#/$defs/Leaf" },
      },
      required: ["items", "maybe", "either", "ref"],
      $defs: { Leaf: { type: "object", properties: { n: { type: "integer", minimum: 0 } } } },
    });

    expect(sent).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
        maybe: {
          anyOf: [
            { type: "object", properties: {}, additionalProperties: false },
            { type: "null" },
          ],
        },
        either: { type: ["object", "null"], properties: {}, additionalProperties: false },
        ref: { $ref: "#/$defs/Leaf" },
      },
      required: ["items", "maybe", "either", "ref"],
      $defs: {
        Leaf: {
          type: "object",
          properties: { n: { type: "integer", description: "{minimum: 0}" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it("turns oneOf into anyOf and transforms each variant", () => {
    expect(
      sentValue({
        oneOf: [
          {
            type: "object",
            properties: { action: { type: "string", const: "new" } },
            required: ["action"],
            additionalProperties: false,
          },
          { type: "string", minLength: 1 },
        ],
      }),
    ).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { action: { type: "string", const: "new" } },
          required: ["action"],
          additionalProperties: false,
        },
        { type: "string", description: "{minLength: 1}" },
      ],
    });
  });

  it("transforms allOf members and definitions", () => {
    const sent = toStructuredOutputSchema({
      type: "object",
      properties: { both: { allOf: [{ $ref: "#/definitions/A" }, { type: "object" }] } },
      definitions: { A: { type: "string", maxLength: 3 } },
    });

    expect(sent).toEqual({
      type: "object",
      properties: {
        both: {
          allOf: [{ $ref: "#/definitions/A" }, { type: "object", additionalProperties: false }],
        },
      },
      definitions: { A: { type: "string", description: "{maxLength: 3}" } },
      additionalProperties: false,
    });
  });

  it("drops $schema without describing it", () => {
    expect(
      toStructuredOutputSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
      }),
    ).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("leaves the caller's schema untouched", () => {
    const schema = wrap({ type: "string", minLength: 1, oneOf: [{ type: "string" }] });
    const before = structuredClone(schema);

    toStructuredOutputSchema(schema);

    expect(schema).toEqual(before);
  });
});

describe("hasOpenObject", () => {
  it.each<[string, unknown]>([
    ["an object closed with additionalProperties: false", wrap({ type: "string" })],
    ["an object with no additionalProperties", { type: "object", properties: {} }],
    ["a scalar", { type: "string" }],
    ["the false schema", false],
  ])("is false for %s", (_label, schema) => {
    expect(hasOpenObject(schema)).toBe(false);
  });

  it.each<[string, unknown]>([
    ["additionalProperties: {}", { type: "object", additionalProperties: {} }],
    ["additionalProperties: true", { type: "object", additionalProperties: true }],
    ["a typed additionalProperties", { type: "object", additionalProperties: { type: "string" } }],
    ["a record property", wrap({ type: "object", additionalProperties: {} })],
    [
      "a record in array items",
      wrap({ type: "array", items: { type: "object", additionalProperties: {} } }),
    ],
    [
      "a record in an anyOf variant",
      wrap({ anyOf: [{ type: "object", additionalProperties: {} }, { type: "null" }] }),
    ],
    [
      "a record in a oneOf variant",
      wrap({ oneOf: [{ type: "object", additionalProperties: {} }] }),
    ],
    [
      "a record in $defs",
      {
        type: "object",
        properties: { r: { $ref: "#/$defs/R" } },
        $defs: { R: { type: "object", additionalProperties: {} } },
      },
    ],
    ["the true schema", true],
  ])("is true for %s", (_label, schema) => {
    expect(hasOpenObject(schema)).toBe(true);
  });

  it("reads property names as names, not as schemas", () => {
    expect(
      hasOpenObject(
        wrap({
          type: "object",
          properties: { additionalProperties: { type: "string" } },
          additionalProperties: false,
        }),
      ),
    ).toBe(false);
  });
});
