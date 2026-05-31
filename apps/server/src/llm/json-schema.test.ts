import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toObjectJsonSchema } from "./json-schema.js";

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
