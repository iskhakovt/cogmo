import { describe, expect, it } from "vitest";
import { compileOutputSchema } from "./output-schema.js";

const OBJECT = { type: "object", required: ["title"], properties: { title: { type: "string" } } };

describe("compileOutputSchema", () => {
  it.each([
    ["no $schema (draft-07 default)", OBJECT],
    ["draft-07", { $schema: "http://json-schema.org/draft-07/schema#", ...OBJECT }],
    ["draft 2019-09", { $schema: "https://json-schema.org/draft/2019-09/schema", ...OBJECT }],
    ["draft 2020-12", { $schema: "https://json-schema.org/draft/2020-12/schema", ...OBJECT }],
  ])("compiles a schema with %s into a working validator", (_label, schema) => {
    const validate = compileOutputSchema(schema)._unsafeUnwrap();
    expect(validate({ title: "Fix login" })).toBe(true);
    expect(validate({})).toBe(false);
  });

  it("reports a schema that isn't valid JSON Schema", () => {
    const result = compileOutputSchema({ type: "not-a-type" });
    expect(result._unsafeUnwrapErr()).toContain("not a valid JSON Schema");
  });

  it("reports a $ref that resolves nowhere", () => {
    const result = compileOutputSchema({
      type: "object",
      properties: { owner: { $ref: "#/$defs/missing" } },
    });
    expect(result._unsafeUnwrapErr()).toContain("can't be compiled");
  });

  it("reports an unknown $schema instead of throwing", () => {
    const result = compileOutputSchema({ $schema: "https://example.com/my-dialect", ...OBJECT });
    expect(result._unsafeUnwrapErr()).toContain("https://example.com/my-dialect");
  });

  it("compiles the same $id twice — each call is independent", () => {
    const schema = { $id: "issue-summary", ...OBJECT };
    expect(compileOutputSchema(schema).isOk()).toBe(true);
    expect(compileOutputSchema(schema).isOk()).toBe(true);
  });

  it("collects every validation error, not just the first", () => {
    const validate = compileOutputSchema({
      type: "object",
      required: ["title", "hours"],
      properties: { title: { type: "string" }, hours: { type: "number" } },
    })._unsafeUnwrap();
    validate({});
    expect(validate.errors).toHaveLength(2);
  });
});
