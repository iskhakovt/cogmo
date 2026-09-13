import { describe, expect, it } from "vitest";
import { compileOutputSchema } from "./output-schema.js";

const OBJECT = { type: "object", required: ["title"], properties: { title: { type: "string" } } };

describe("compileOutputSchema", () => {
  it.each([
    ["no $schema (draft-07 default)", OBJECT],
    ["draft-07", { $schema: "http://json-schema.org/draft-07/schema#", ...OBJECT }],
    ["draft 2019-09", { $schema: "https://json-schema.org/draft/2019-09/schema", ...OBJECT }],
    ["draft 2020-12", { $schema: "https://json-schema.org/draft/2020-12/schema", ...OBJECT }],
    ["draft-06", { $schema: "http://json-schema.org/draft-06/schema#", ...OBJECT }],
    ["https draft-07", { $schema: "https://json-schema.org/draft-07/schema#", ...OBJECT }],
    [
      "draft-07 without the fragment",
      { $schema: "http://json-schema.org/draft-07/schema", ...OBJECT },
    ],
    ["https draft-06", { $schema: "https://json-schema.org/draft-06/schema", ...OBJECT }],
    ["http draft 2020-12", { $schema: "http://json-schema.org/draft/2020-12/schema", ...OBJECT }],
    [
      "draft 2019-09 with a fragment",
      { $schema: "https://json-schema.org/draft/2019-09/schema#", ...OBJECT },
    ],
  ])("compiles a schema with %s into a working validator", (_label, schema) => {
    const validate = compileOutputSchema(schema)._unsafeUnwrap();
    expect(validate({ title: "Fix login" })).toBe(true);
    expect(validate({})).toBe(false);
  });

  it("checks a schema against its declared dialect's meta-schema", () => {
    // Draft-07's meta-schema requires `$comment` to be a string; draft-06 has no `$comment`.
    const schema = { type: "object", $comment: 5 };
    expect(
      compileOutputSchema({ $schema: "http://json-schema.org/draft-06/schema#", ...schema }).isOk(),
    ).toBe(true);
    expect(
      compileOutputSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        ...schema,
      })._unsafeUnwrapErr(),
    ).toMatch(/^is not a valid JSON Schema: /);
  });

  it.each(["draft-03", "draft-04"])("names %s as a real but unsupported dialect", (draft) => {
    const result = compileOutputSchema({
      $schema: `http://json-schema.org/${draft}/schema#`,
      ...OBJECT,
    });
    expect(result._unsafeUnwrapErr()).toBe(
      `declares JSON Schema ${draft}, which isn't supported — use draft-06 or later`,
    );
  });

  it.each([
    ["a draft number that doesn't exist", "http://json-schema.org/draft-09/schema#"],
    ["draft-05, which was never published", "http://json-schema.org/draft-05/schema#"],
    ["a dated draft that doesn't exist", "https://json-schema.org/draft/2021-01/schema"],
    ["trailing path segments", "http://json-schema.org/draft-07/schema#/definitions"],
  ])("reports %s as an unknown $schema", (_label, uri) => {
    expect(compileOutputSchema({ $schema: uri, ...OBJECT })._unsafeUnwrapErr()).toBe(
      `declares an unknown $schema ${JSON.stringify(uri)}`,
    );
  });

  it("reports a non-string $schema as unknown", () => {
    expect(compileOutputSchema({ $schema: 7, ...OBJECT })._unsafeUnwrapErr()).toBe(
      "declares an unknown $schema 7",
    );
  });

  it("reports a schema that isn't valid JSON Schema as a sentence after its subject", () => {
    const result = compileOutputSchema({ type: "not-a-type" });
    expect(result._unsafeUnwrapErr()).toMatch(/^is not a valid JSON Schema: /);
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
