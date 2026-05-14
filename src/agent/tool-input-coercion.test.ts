import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonSchema } from "../llm/types.js";
import { coerceToolInput } from "./tool-input-coercion.js";

function jsonSchema<T>(schema: z.ZodType<T>): JsonSchema {
  return z.toJSONSchema(schema) as unknown as JsonSchema;
}

describe("coerceToolInput", () => {
  it("returns input unchanged when every field is well-formed", () => {
    const schema = jsonSchema(z.object({ name: z.string(), count: z.number() }));
    const input = { name: "x", count: 1 };
    const { value, coercedPaths } = coerceToolInput(input, schema);
    expect(value).toBe(input);
    expect(coercedPaths).toEqual([]);
  });

  it("unwraps a stringified nested object", () => {
    const schema = jsonSchema(
      z.object({
        outer: z.object({ inner: z.string() }),
      }),
    );
    const { value, coercedPaths } = coerceToolInput({ outer: '{"inner":"hello"}' }, schema);
    expect(value).toEqual({ outer: { inner: "hello" } });
    expect(coercedPaths).toEqual(["outer"]);
  });

  it("unwraps a stringified branch of a discriminated union (schedule_task shape)", () => {
    const recurring = z.object({ kind: z.literal("recurring"), cron: z.string() }).strict();
    const oneOff = z.object({ kind: z.literal("one_off"), runAt: z.string() }).strict();
    const schema = jsonSchema(
      z.object({
        schedule: z.discriminatedUnion("kind", [recurring, oneOff]),
        prompt: z.string(),
      }),
    );

    const { value, coercedPaths } = coerceToolInput(
      {
        schedule: '{"kind":"one_off","runAt":"2026-05-15T08:00:00+01:00"}',
        prompt: "wake me",
      },
      schema,
    );

    expect(value).toEqual({
      schedule: { kind: "one_off", runAt: "2026-05-15T08:00:00+01:00" },
      prompt: "wake me",
    });
    expect(coercedPaths).toEqual(["schedule"]);
  });

  it("unwraps a stringified array when schema expects an array", () => {
    const schema = jsonSchema(z.object({ tags: z.array(z.string()) }));
    const { value, coercedPaths } = coerceToolInput({ tags: '["a","b","c"]' }, schema);
    expect(value).toEqual({ tags: ["a", "b", "c"] });
    expect(coercedPaths).toEqual(["tags"]);
  });

  it("recurses into nested object properties", () => {
    const schema = jsonSchema(
      z.object({
        params: z.object({
          config: z.object({ flag: z.boolean() }),
        }),
      }),
    );
    const { value, coercedPaths } = coerceToolInput(
      { params: { config: '{"flag":true}' } },
      schema,
    );
    expect(value).toEqual({ params: { config: { flag: true } } });
    expect(coercedPaths).toEqual(["params.config"]);
  });

  it("leaves the string in place when the schema accepts a string (union with string)", () => {
    const schema = jsonSchema(
      z.object({ payload: z.union([z.string(), z.object({ x: z.number() })]) }),
    );
    // Looks like a JSON object but the schema legitimately allows strings —
    // coercing would corrupt the caller's intent.
    const input = { payload: '{"x":1}' };
    const { value, coercedPaths } = coerceToolInput(input, schema);
    expect(value).toEqual(input);
    expect(coercedPaths).toEqual([]);
  });

  it("leaves the string in place when JSON.parse fails", () => {
    const schema = jsonSchema(z.object({ outer: z.object({ x: z.string() }) }));
    const input = { outer: "not-json{" };
    const { value, coercedPaths } = coerceToolInput(input, schema);
    expect(value).toEqual(input);
    expect(coercedPaths).toEqual([]);
  });

  it("leaves the string in place when JSON.parse yields the wrong shape", () => {
    const schema = jsonSchema(z.object({ outer: z.object({ x: z.string() }) }));
    // Parses to a number, not an object.
    const input = { outer: "42" };
    const { value, coercedPaths } = coerceToolInput(input, schema);
    expect(value).toEqual(input);
    expect(coercedPaths).toEqual([]);
  });

  it("does not touch primitive fields", () => {
    const schema = jsonSchema(z.object({ count: z.number(), label: z.string() }));
    // A stringified number is still a string and the schema expects number —
    // coercion is opt-in to object/array recovery only, not type loosening.
    const input = { count: "5", label: "x" };
    const { value, coercedPaths } = coerceToolInput(input, schema);
    expect(value).toEqual(input);
    expect(coercedPaths).toEqual([]);
  });

  it("reports multiple coercion paths in one call", () => {
    const schema = jsonSchema(
      z.object({
        a: z.object({ x: z.string() }),
        b: z.array(z.number()),
      }),
    );
    const { value, coercedPaths } = coerceToolInput({ a: '{"x":"hi"}', b: "[1,2,3]" }, schema);
    expect(value).toEqual({ a: { x: "hi" }, b: [1, 2, 3] });
    expect(coercedPaths.sort()).toEqual(["a", "b"]);
  });

  it("walks into array items when their schema demands an object", () => {
    const schema = jsonSchema(z.object({ items: z.array(z.object({ id: z.string() })) }));
    const { value, coercedPaths } = coerceToolInput(
      { items: ['{"id":"one"}', { id: "two" }] },
      schema,
    );
    expect(value).toEqual({ items: [{ id: "one" }, { id: "two" }] });
    expect(coercedPaths).toEqual(["items.0"]);
  });

  it("returns the same reference when nothing changes (cheap fast path)", () => {
    const schema = jsonSchema(z.object({ outer: z.object({ inner: z.string() }) }));
    const input = { outer: { inner: "ok" } };
    const { value } = coerceToolInput(input, schema);
    expect(value).toBe(input);
  });
});
