import { describe, expect, it } from "vitest";
import { StageArtifactSchema, StageOutputsSchema } from "./run-types.js";

describe("StageArtifactSchema", () => {
  it("accepts a text artifact", () => {
    expect(StageArtifactSchema.parse({ kind: "text", text: "hello" })).toEqual({
      kind: "text",
      text: "hello",
    });
  });

  it("accepts a json artifact with an arbitrary object value", () => {
    const json = { kind: "json", value: { approved: true, rounds: 2 } };
    expect(StageArtifactSchema.parse(json)).toEqual(json);
  });

  it("rejects an unknown kind", () => {
    expect(() => StageArtifactSchema.parse({ kind: "plan" })).toThrow();
  });

  it("rejects extra keys (strict)", () => {
    expect(() => StageArtifactSchema.parse({ kind: "text", text: "x", extra: 1 })).toThrow();
  });

  it("rejects a json value that is not an object", () => {
    expect(() => StageArtifactSchema.parse({ kind: "json", value: "nope" })).toThrow();
  });
});

describe("StageOutputsSchema", () => {
  it("maps stage ids to artifacts", () => {
    const outputs = {
      "gather-context": { kind: "text", text: "scope" },
      "plan-gate": { kind: "json", value: { approved: true } },
    };
    expect(StageOutputsSchema.parse(outputs)).toEqual(outputs);
  });

  it("accepts the empty map a run starts with", () => {
    expect(StageOutputsSchema.parse({})).toEqual({});
  });

  it("rejects a malformed artifact under a key", () => {
    expect(() => StageOutputsSchema.parse({ s1: { kind: "text" } })).toThrow();
  });
});
