import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definitionsOf, isObjectNode, toObjectJsonSchema } from "./json-schema.js";

describe("definitionsOf", () => {
  it("returns $defs and definitions, and nothing else", () => {
    const $defs = { A: { type: "string" } };
    const definitions = { B: { type: "number" } };

    expect(
      definitionsOf({ type: "object", properties: {}, $defs, definitions, title: "x" }),
    ).toEqual({ $defs, definitions });
  });

  it("returns nothing for a schema without definitions", () => {
    expect(definitionsOf({ type: "object", $defs: undefined })).toEqual({});
  });
});

describe("isObjectNode", () => {
  it.each<[unknown, boolean]>([
    ["object", true],
    [["object", "null"], true],
    ["array", false],
    [["string", "null"], false],
    [undefined, false],
  ])("reads type %j as %s", (type, expected) => {
    expect(isObjectNode({ type })).toBe(expected);
  });
});

describe("toObjectJsonSchema", () => {
  it("returns the narrowed JsonSchema for an object schema", () => {
    const out = toObjectJsonSchema(z.object({ name: z.string(), age: z.number().optional() }));
    expect(out.type).toBe("object");
    expect(out.properties).toMatchObject({
      name: { type: "string" },
      age: { type: "number" },
    });
    expect(out.required).toEqual(["name"]);
  });

  it("throws when the input is not an object schema", () => {
    expect(() => toObjectJsonSchema(z.string())).toThrow(/Expected object JSON schema/);
    expect(() => toObjectJsonSchema(z.array(z.number()))).toThrow(
      /Expected object JSON schema.*array/,
    );
  });
});
