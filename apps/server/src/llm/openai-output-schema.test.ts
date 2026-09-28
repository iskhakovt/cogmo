import { describe, expect, it } from "vitest";
import { ConsolidationSchema } from "../agent/evolution/consolidate-rules.js";
import { CorrectionExtractionSchema } from "../agent/evolution/extraction-schema.js";
import {
  buildClassifiedMemorySchema,
  buildMemoryExtractionSchema,
} from "../agent/evolution/memory-extraction-schema.js";
import { PipelineDefinitionSchema } from "../agent/pipeline/types.js";
import { toObjectJsonSchema } from "./json-schema.js";
import { fitsStrictMode } from "./openai-output-schema.js";
import type { JsonSchema } from "./types.js";

/** A closed object with one required property, `value`, carrying `node`. */
function wrap(node: unknown): JsonSchema {
  return {
    type: "object",
    properties: { value: node },
    required: ["value"],
    additionalProperties: false,
  };
}

describe("fitsStrictMode", () => {
  it.each<[string, JsonSchema]>([
    ["the rule-consolidation schema", toObjectJsonSchema(ConsolidationSchema)],
    ["the memory-classification schema", toObjectJsonSchema(buildClassifiedMemorySchema([]))],
    ["a nullable property", wrap({ type: ["string", "null"] })],
    ["an anyOf property", wrap({ anyOf: [{ type: "string" }, { type: "null" }] })],
    [
      "string, number and array bounds",
      wrap({
        type: "object",
        properties: {
          s: { type: "string", minLength: 1, maxLength: 9, pattern: "^[a-z]+$" },
          n: { type: "integer", minimum: 0, maximum: 9, multipleOf: 3 },
          x: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
          a: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        },
        required: ["s", "n", "x", "a"],
        additionalProperties: false,
      }),
    ],
    ["a supported format", wrap({ type: "string", format: "date-time" })],
    [
      "enum, const, description and default",
      wrap({ type: "string", enum: ["a"], const: "a", description: "d", default: "a" }),
    ],
    [
      "a $ref to a closed definition",
      {
        ...wrap({ $ref: "#/$defs/Point" }),
        $defs: {
          Point: {
            type: "object",
            properties: { x: { type: "number" } },
            required: ["x"],
            additionalProperties: false,
          },
        },
      },
    ],
  ])("is true for %s", (_label, schema) => {
    expect(fitsStrictMode(schema)).toBe(true);
  });

  it.each<[string, JsonSchema]>([
    ["the pipeline-definition schema", toObjectJsonSchema(PipelineDefinitionSchema)],
    ["the correction-extraction schema", toObjectJsonSchema(CorrectionExtractionSchema)],
    ["the memory-extraction schema", toObjectJsonSchema(buildMemoryExtractionSchema([]))],
    [
      "an object without additionalProperties",
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    ],
    ["an open object", wrap({ type: "object", additionalProperties: {} })],
    [
      "an optional property",
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    ],
    ["a oneOf", wrap({ oneOf: [{ type: "string" }, { type: "null" }] })],
    ["an allOf", wrap({ allOf: [{ type: "string" }] })],
    ["a not", wrap({ type: "string", not: { const: "x" } })],
    ["an untyped node", wrap({})],
    ["a node typed only by enum", wrap({ enum: ["a", "b"] })],
    ["the true schema", wrap(true)],
    ["an unsupported format", wrap({ type: "string", format: "uri" })],
    ["an unlisted keyword", wrap({ type: "array", items: { type: "string" }, uniqueItems: true })],
    [
      "an open object in a definition",
      {
        ...wrap({ $ref: "#/$defs/Bag" }),
        $defs: { Bag: { type: "object", additionalProperties: { type: "string" } } },
      },
    ],
    [
      "an optional property in array items",
      wrap({
        type: "array",
        items: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
      }),
    ],
    ["an untyped anyOf variant", wrap({ anyOf: [{}, { type: "null" }] })],
    ["a root anyOf", { ...wrap({ type: "string" }), anyOf: [{ type: "object" }] }],
  ])("is false for %s", (_label, schema) => {
    expect(fitsStrictMode(schema)).toBe(false);
  });

  it("reads property names as names, not as keywords", () => {
    expect(
      fitsStrictMode({
        type: "object",
        properties: { oneOf: { type: "string" }, format: { type: "string" } },
        required: ["oneOf", "format"],
        additionalProperties: false,
      }),
    ).toBe(true);
  });
});
