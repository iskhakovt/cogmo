import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CorrectionExtractionSchema } from "../agent/evolution/extraction-schema.js";
import {
  hasOpenObject,
  hasRecursiveRef,
  hasTuple,
  restoreLiteralCasing,
  toStructuredOutputSchema,
} from "./anthropic-output-schema.js";
import { toObjectJsonSchema } from "./json-schema.js";
import type { JsonSchema } from "./types.js";

/** A closed object with one property, `value`, carrying `node`. */
function wrap(node: unknown): JsonSchema {
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
    ["a node typed only by enum", wrap({ enum: ["a", "b"] })],
    ["a node typed only by const", wrap({ const: 1 })],
    ["a node typed only by anyOf", wrap({ anyOf: [{ type: "string" }, { type: "null" }] })],
    ["a node typed only by allOf", wrap({ allOf: [{ type: "string" }] })],
    [
      "a node typed only by $ref",
      { ...wrap({ $ref: "#/$defs/S" }), $defs: { S: { type: "string" } } },
    ],
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
    ["an untyped property, as z.unknown() and z.any() emit", wrap({})],
    ["an untyped node with only a description", wrap({ description: "anything" })],
    ["untyped array items", wrap({ type: "array", items: {} })],
    ["an untyped anyOf variant", wrap({ anyOf: [{}, { type: "null" }] })],
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

describe("hasTuple", () => {
  const Pair = z.tuple([z.string(), z.number()]);

  it.each<[string, unknown]>([
    ["a tuple property", toObjectJsonSchema(z.object({ pair: Pair }))],
    [
      "a tuple with rest items",
      toObjectJsonSchema(z.object({ t: z.tuple([z.string()], z.number()) })),
    ],
    ["a tuple in array items", toObjectJsonSchema(z.object({ pairs: z.array(Pair) }))],
    ["a tuple variant", toObjectJsonSchema(z.object({ v: z.union([Pair, z.null()]) }))],
    [
      "a tuple in a definition",
      {
        ...wrap({ $ref: "#/$defs/Pair" }),
        $defs: { Pair: { type: "array", prefixItems: [{ type: "string" }], items: false } },
      },
    ],
    ["draft-07 array-form items", wrap({ type: "array", items: [{ type: "string" }] })],
  ])("is true for %s", (_label, schema) => {
    expect(hasTuple(schema)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["an array", toObjectJsonSchema(z.object({ list: z.array(z.string()) }))],
    ["a schema without arrays", wrap({ type: "string" })],
    [
      "a property named prefixItems",
      wrap({
        type: "object",
        properties: { prefixItems: { type: "string" } },
        additionalProperties: false,
      }),
    ],
  ])("is false for %s", (_label, schema) => {
    expect(hasTuple(schema)).toBe(false);
  });
});

describe("hasRecursiveRef", () => {
  const TreeNode = z.object({
    name: z.string(),
    get children() {
      return z.array(TreeNode);
    },
  });

  const Chain = z.object({
    value: z.string(),
    get next() {
      return Chain.optional();
    },
  });

  const Id = z.string().meta({ id: "Id" });

  it.each<[string, JsonSchema]>([
    ["a schema without $ref", wrap({ type: "string" })],
    [
      "a $ref to a definition without refs",
      { ...wrap({ $ref: "#/$defs/S" }), $defs: { S: { type: "string" } } },
    ],
    [
      "one definition referenced twice",
      {
        type: "object",
        properties: { a: { $ref: "#/$defs/S" }, b: { $ref: "#/$defs/S" } },
        $defs: { S: { type: "string" } },
      },
    ],
    [
      "a chain of definitions",
      {
        ...wrap({ $ref: "#/$defs/A" }),
        $defs: {
          A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
          B: { type: "string" },
        },
      },
    ],
    [
      "a $ref into a property of the same definition",
      {
        ...wrap({ $ref: "#/$defs/A" }),
        $defs: {
          A: {
            type: "object",
            properties: { x: { type: "string" }, y: { $ref: "#/$defs/A/properties/x" } },
          },
        },
      },
    ],
    ["a registered Zod schema used twice", toObjectJsonSchema(z.object({ a: Id, b: Id }))],
    ["a $ref that resolves nowhere", wrap({ $ref: "#/$defs/Missing" })],
    ["an external $ref", wrap({ $ref: "https://example.com/schema.json" })],
  ])("is false for %s", (_label, schema) => {
    expect(hasRecursiveRef(schema)).toBe(false);
  });

  it.each<[string, JsonSchema]>([
    [
      "a Zod schema that nests itself in a definition",
      toObjectJsonSchema(z.object({ root: TreeNode })),
    ],
    ["a Zod schema that nests itself at the root", toObjectJsonSchema(Chain)],
    [
      "a definition that refers to itself",
      {
        ...wrap({ $ref: "#/$defs/A" }),
        $defs: { A: { type: "array", items: { $ref: "#/$defs/A" } } },
      },
    ],
    [
      "definitions that refer to each other",
      {
        ...wrap({ $ref: "#/$defs/A" }),
        $defs: {
          A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
          B: { anyOf: [{ $ref: "#/$defs/A" }, { type: "null" }] },
        },
      },
    ],
    [
      "a definition that refers back to the root",
      {
        ...wrap({ $ref: "#/definitions/Wrapper" }),
        definitions: { Wrapper: { type: "object", properties: { inner: { $ref: "#" } } } },
      },
    ],
    [
      "a property that refers to itself",
      wrap({ type: "object", properties: { self: { $ref: "#/properties/value" } } }),
    ],
    [
      "a definition's property that refers to the definition",
      {
        ...wrap({ $ref: "#/$defs/A/properties/x" }),
        $defs: {
          A: { type: "object", properties: { x: { allOf: [{ $ref: "#/$defs/A" }] } } },
        },
      },
    ],
    [
      "a definition named with an escaped pointer segment",
      {
        ...wrap({ $ref: "#/$defs/a~1b" }),
        $defs: { "a/b": { type: "array", items: { $ref: "#/$defs/a~1b" } } },
      },
    ],
  ])("is true for %s", (_label, schema) => {
    expect(hasRecursiveRef(schema)).toBe(true);
  });
});

describe("restoreLiteralCasing", () => {
  const TOPICS = wrap({
    type: "string",
    enum: ["Conversation Topic 1", "Conversation Topic 2", "Conversation topic 3"],
  });

  it("restores an enum value that differs only in capitalization", () => {
    expect(restoreLiteralCasing(TOPICS, { value: "Conversation Topic 3" })).toEqual({
      value: "Conversation topic 3",
    });
  });

  it("restores a const value", () => {
    expect(restoreLiteralCasing(wrap({ type: "string", const: "new" }), { value: "New" })).toEqual({
      value: "new",
    });
  });

  it("restores a discriminator and the enums of the variant it selects", () => {
    const schema = toObjectJsonSchema(CorrectionExtractionSchema);
    const reply = {
      corrections: [
        {
          rule: "Be brief",
          category: "Style",
          reasoning: "The user asked twice",
          sourceMessage: 2,
          action: "Reinforce",
          matchedExistingRuleId: "rule-1",
        },
        {
          rule: "Answer in French",
          category: "domain",
          reasoning: "The user switched language",
          sourceMessage: 2,
          action: "new",
          matchedExistingRuleId: null,
          channelType: null,
        },
      ],
    };

    const restored = restoreLiteralCasing(schema, reply);

    expect(restored).toEqual({
      corrections: [
        { ...reply.corrections[0], category: "style", action: "reinforce" },
        reply.corrections[1],
      ],
    });
    expect(CorrectionExtractionSchema.safeParse(restored).success).toBe(true);
  });

  it("follows $ref, items and anyOf", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { $ref: "#/$defs/Tag" } },
        maybe: { anyOf: [{ $ref: "#/$defs/Tag" }, { type: "null" }] },
      },
      required: ["tags", "maybe"],
      $defs: { Tag: { type: "string", enum: ["alpha", "beta"] } },
    };

    expect(restoreLiteralCasing(schema, { tags: ["Alpha", "beta"], maybe: "BETA" })).toEqual({
      tags: ["alpha", "beta"],
      maybe: "beta",
    });
  });

  it("returns the value itself when every literal matches", () => {
    const value = { value: "Conversation Topic 1" };

    expect(restoreLiteralCasing(TOPICS, value)).toBe(value);
  });

  it.each<[string, JsonSchema, unknown]>([
    [
      "a value two members match",
      wrap({ type: "string", enum: ["Draft", "draft"] }),
      { value: "DRAFT" },
    ],
    ["a value no member matches", TOPICS, { value: "Conversation Topic 4" }],
    [
      "a value another variant admits",
      wrap({ anyOf: [{ type: "string", enum: ["low", "high"] }, { type: "string" }] }),
      { value: "High" },
    ],
    ["a property the schema doesn't name", TOPICS, { other: "conversation topic 1" }],
    ["a value of another type", wrap({ type: "string", enum: ["1"] }), { value: 1 }],
    ["a value the true schema admits", wrap(true), { value: "Anything" }],
    [
      "a value the true schema admits in a variant",
      wrap({ anyOf: [true, { type: "string", enum: ["low"] }] }),
      { value: "Low" },
    ],
  ])("leaves %s as it is", (_label, schema, value) => {
    expect(restoreLiteralCasing(schema, value)).toBe(value);
  });

  it("leaves a tuple as it is", () => {
    const reply = { list: ["A", "bee"] };

    expect(
      restoreLiteralCasing(
        toObjectJsonSchema(z.object({ list: z.tuple([z.literal("a")], z.enum(["Bee"])) })),
        reply,
      ),
    ).toBe(reply);
  });

  it("restores through every allOf member", () => {
    expect(
      restoreLiteralCasing(wrap({ allOf: [{ type: "string" }, { enum: ["low", "high"] }] }), {
        value: "High",
      }),
    ).toEqual({ value: "high" });
  });

  it("skips a variant the false schema rejects", () => {
    expect(
      restoreLiteralCasing(wrap({ anyOf: [false, { type: "string", enum: ["low"] }] }), {
        value: "Low",
      }),
    ).toEqual({ value: "low" });
  });
});
