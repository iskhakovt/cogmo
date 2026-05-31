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

  it('coerces when type is a nullable-tagged tuple like ["object", "null"]', () => {
    // Hand-rolled JSON Schema using the `type: [...]` form for nullables —
    // walker must treat the single non-null entry as the unambiguous kind.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        outer: { type: ["object", "null"], properties: { inner: { type: "string" } } },
      },
    };
    const { value, coercedPaths } = coerceToolInput({ outer: '{"inner":"x"}' }, schema);
    expect(value).toEqual({ outer: { inner: "x" } });
    expect(coercedPaths).toEqual(["outer"]);
  });

  it("does not coerce when type is a mixed tuple that also allows strings", () => {
    // `["string", "object"]` means the schema legitimately accepts a string —
    // coercion would corrupt the caller's intent.
    const schema: JsonSchema = {
      type: "object",
      properties: { payload: { type: ["string", "object"] } },
    };
    const input = { payload: '{"x":1}' };
    const { value, coercedPaths } = coerceToolInput(input, schema);
    expect(value).toEqual(input);
    expect(coercedPaths).toEqual([]);
  });

  it("returns the same reference when nothing changes (cheap fast path)", () => {
    const schema = jsonSchema(z.object({ outer: z.object({ inner: z.string() }) }));
    const input = { outer: { inner: "ok" } };
    const { value } = coerceToolInput(input, schema);
    expect(value).toBe(input);
  });

  it("descends into the matching DU branch to recover doubly-stringified inner fields", () => {
    // The model double-encoded both the outer `schedule` field and its
    // nested `config` field. After the outer string is recovered we still
    // sit on the union node (no `properties` of its own) — descent has to
    // pick the matching branch by discriminator to recover `config`.
    const aBranch = z.object({
      kind: z.literal("a"),
      config: z.object({ flag: z.boolean() }),
    });
    const bBranch = z.object({ kind: z.literal("b"), name: z.string() });
    const schema = jsonSchema(
      z.object({ schedule: z.discriminatedUnion("kind", [aBranch, bBranch]) }),
    );

    const { value, coercedPaths } = coerceToolInput(
      { schedule: '{"kind":"a","config":"{\\"flag\\":true}"}' },
      schema,
    );

    expect(value).toEqual({ schedule: { kind: "a", config: { flag: true } } });
    expect(coercedPaths.sort()).toEqual(["schedule", "schedule.config"]);
  });

  it("does not descend into a union when no branch's discriminator matches", () => {
    // The discriminator value isn't one of the legal branches — Zod will
    // reject this anyway, but the walker must not pick a branch and start
    // coercing children under the wrong shape.
    const aBranch = z.object({
      kind: z.literal("a"),
      config: z.object({ flag: z.boolean() }),
    });
    const bBranch = z.object({ kind: z.literal("b"), name: z.string() });
    const schema = jsonSchema(
      z.object({ schedule: z.discriminatedUnion("kind", [aBranch, bBranch]) }),
    );

    const input = { schedule: { kind: "c", config: '{"flag":true}' } };
    const { value, coercedPaths } = coerceToolInput(input, schema);
    expect(value).toEqual(input);
    expect(coercedPaths).toEqual([]);
  });

  it("walks values under additionalProperties for z.record(z.string(), z.object(...))", () => {
    // z.record emits `additionalProperties: { type: "object", ... }` —
    // entries whose values come back as stringified JSON should still get
    // recovered.
    const schema = jsonSchema(
      z.object({ headers: z.record(z.string(), z.object({ v: z.string() })) }),
    );

    const { value, coercedPaths } = coerceToolInput(
      { headers: { auth: '{"v":"bearer"}', trace: { v: "abc" } } },
      schema,
    );

    expect(value).toEqual({
      headers: { auth: { v: "bearer" }, trace: { v: "abc" } },
    });
    expect(coercedPaths).toEqual(["headers.auth"]);
  });

  it("prefers named properties over additionalProperties when both apply", () => {
    // Hand-rolled schema mixing both — named properties win; only unknown
    // keys fall through to additionalProperties.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { known: { type: "string" } },
          additionalProperties: { type: "object", properties: { x: { type: "string" } } },
        },
      },
    };
    const { value, coercedPaths } = coerceToolInput(
      { outer: { known: "leave-me", extra: '{"x":"hi"}' } },
      schema,
    );
    expect(value).toEqual({ outer: { known: "leave-me", extra: { x: "hi" } } });
    expect(coercedPaths).toEqual(["outer.extra"]);
  });
});
