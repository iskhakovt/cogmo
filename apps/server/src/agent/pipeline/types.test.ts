import { describe, expect, it } from "vitest";
import { validPipelineDefinition } from "./test-fixtures.js";
import {
  MAX_DURATION_MS,
  PipelineDefinitionSchema,
  parseDurationMs,
  TimeoutActionSchema,
} from "./types.js";

describe("parseDurationMs", () => {
  it.each([
    ["30m", 30 * 60_000],
    ["3h", 3 * 3_600_000],
    ["3d", 3 * 86_400_000],
    ["2w", 2 * 604_800_000],
    ["1.5h", 1.5 * 3_600_000],
  ])("parses %s", (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(["3M", "3mo", "1y", "30", "d3", "3 d", "PT3M", ""])("throws on %s", (input) => {
    expect(() => parseDurationMs(input)).toThrow(/duration grammar/);
  });

  it("366d is the ceiling boundary", () => {
    expect(parseDurationMs("366d")).toBe(MAX_DURATION_MS);
  });
});

describe("PipelineDefinitionSchema", () => {
  it("accepts a full valid definition", () => {
    expect(() => PipelineDefinitionSchema.parse(validPipelineDefinition())).not.toThrow();
  });

  it("rejects non-slug stage ids", () => {
    const def = validPipelineDefinition();
    const stage = def.stages[0];
    if (!stage) throw new Error("fixture has no stages");
    stage.id = "Has Spaces";
    expect(() => PipelineDefinitionSchema.parse(def)).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    const def = { ...validPipelineDefinition(), surprise: true };
    expect(() => PipelineDefinitionSchema.parse(def)).toThrow();
  });

  it("rejects months in durations", () => {
    const def = validPipelineDefinition();
    const gateStage = def.stages.find((s) => s.kind === "gate");
    if (!gateStage?.gate) throw new Error("fixture has no gate stage");
    gateStage.gate.timeout = "3M";
    expect(() => PipelineDefinitionSchema.parse(def)).toThrow();
  });

  it("rejects remind without a terminal fall-through", () => {
    // parse() takes unknown — the invalid literal needs no cast.
    expect(() => TimeoutActionSchema.parse({ kind: "remind", maxReminders: 3 })).toThrow();
    expect(() =>
      TimeoutActionSchema.parse({ kind: "remind", maxReminders: 3, finalAction: "abort" }),
    ).not.toThrow();
  });

  it("rejects an empty stage list", () => {
    const def = { ...validPipelineDefinition(), stages: [] };
    expect(() => PipelineDefinitionSchema.parse(def)).toThrow();
  });
});
