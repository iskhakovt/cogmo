import { describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { FIXTURE_TOOLS, validPipelineDefinition } from "./test-fixtures.js";
import type { PipelineDefinition, Stage } from "./types.js";
import { type ValidationContext, validateDefinition } from "./validate.js";

const CTX: ValidationContext = { availableTools: FIXTURE_TOOLS, knownEventSources: [] };

function stage(def: PipelineDefinition, index: number): Stage {
  return expectDefined(def.stages[index], `stage[${index}]`);
}

describe("validateDefinition", () => {
  it("passes the canonical fixture", () => {
    expect(validateDefinition(validPipelineDefinition(), CTX)).toEqual([]);
  });

  it("flags duplicate stage ids", () => {
    const def = validPipelineDefinition();
    stage(def, 2).id = stage(def, 0).id;
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.message.includes("duplicate stage id"))).toBe(true);
  });

  it("flags a gate stage without gate config", () => {
    const def = validPipelineDefinition();
    stage(def, 1).gate = undefined;
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.path === "stages[1].gate")).toBe(true);
  });

  it("flags gate config on an agentic stage", () => {
    const def = validPipelineDefinition();
    stage(def, 0).gate = { timeout: "1d", onTimeout: { kind: "abort" } };
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.path === "stages[0].gate")).toBe(true);
  });

  it("flags missing instructions on agentic and gate stages", () => {
    const def = validPipelineDefinition();
    stage(def, 0).instructions = undefined;
    stage(def, 1).instructions = undefined;
    const issues = validateDefinition(def, CTX);
    expect(issues.filter((i) => i.message.includes("needs instructions"))).toHaveLength(2);
  });

  it("flags tools and output on non-agentic stages", () => {
    const def = validPipelineDefinition();
    stage(def, 1).tools = ["memory_recall"];
    stage(def, 1).output = { kind: "text" };
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.path === "stages[1].tools")).toBe(true);
    expect(issues.some((i) => i.path === "stages[1].output")).toBe(true);
  });

  it("flags a tool glob matching nothing, listing the available tools", () => {
    const def = validPipelineDefinition();
    stage(def, 0).tools = ["nonexistent_*"];
    const issues = validateDefinition(def, CTX);
    const issue = expectDefined(
      issues.find((i) => i.path === "stages[0].tools"),
      "glob issue",
    );
    expect(issue.message).toContain("nonexistent_*");
    expect(issue.message).toContain("delegate_coding");
  });

  it("accepts a glob matching at least one tool", () => {
    const def = validPipelineDefinition();
    stage(def, 0).tools = ["memory_*"];
    expect(validateDefinition(def, CTX)).toEqual([]);
  });

  it("flags an invalid JSON Schema on a json output", () => {
    const def = validPipelineDefinition();
    stage(def, 0).output = { kind: "json", schema: { type: "not-a-type" } };
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.path === "stages[0].output.schema")).toBe(true);
  });

  it("accepts a valid JSON Schema on a json output", () => {
    const def = validPipelineDefinition();
    stage(def, 0).output = {
      kind: "json",
      schema: { type: "object", properties: { summary: { type: "string" } } },
    };
    expect(validateDefinition(def, CTX)).toEqual([]);
  });

  it("flags wait stages while no event sources exist", () => {
    const def = validPipelineDefinition();
    def.stages.push({
      id: "wait-review",
      kind: "wait",
      wait: {
        event: "github/pr.review_submitted",
        timeout: "14d",
        onTimeout: { kind: "abort" },
      },
    });
    const issues = validateDefinition(def, CTX);
    const issue = expectDefined(
      issues.find((i) => i.path === "stages[3].wait.event"),
      "wait issue",
    );
    expect(issue.message).toContain("no external event sources are registered yet");
  });

  it("accepts wait stages once the source is known", () => {
    const def = validPipelineDefinition();
    def.stages.push({
      id: "wait-review",
      kind: "wait",
      wait: {
        event: "github/pr.review_submitted",
        timeout: "14d",
        onTimeout: { kind: "abort" },
      },
    });
    const ctx = { ...CTX, knownEventSources: ["github/pr.review_submitted"] };
    expect(validateDefinition(def, ctx)).toEqual([]);
  });

  it("flags event triggers while no event sources exist", () => {
    const def = validPipelineDefinition();
    def.trigger = { kind: "event", source: "linear/issue.created" };
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.path === "trigger.source")).toBe(true);
  });

  it("flags an invalid cron trigger", () => {
    const def = validPipelineDefinition();
    def.trigger = { kind: "cron", schedule: "not a cron", timezone: "Europe/London" };
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.path === "trigger.schedule")).toBe(true);
  });

  it("accepts a valid cron trigger", () => {
    const def = validPipelineDefinition();
    def.trigger = { kind: "cron", schedule: "0 9 * * 1-5", timezone: "Europe/London" };
    expect(validateDefinition(def, CTX)).toEqual([]);
  });

  it("flags a back-edge pointing forward or to itself", () => {
    const def = validPipelineDefinition();
    const last = stage(def, 2);
    last.loop = { backTo: "implement", until: "done", maxIterations: 3 };
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.message.includes("only point backwards"))).toBe(true);
  });

  it("flags a back-edge to an unknown stage", () => {
    const def = validPipelineDefinition();
    stage(def, 2).loop = { backTo: "ghost", until: "done", maxIterations: 3 };
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.message.includes("not a stage id"))).toBe(true);
  });

  it("flags overlapping loop scopes", () => {
    const def = validPipelineDefinition();
    // implement loops back to plan-gate (fixture). Add a second loop from a
    // new stage back to gather-context — its scope [0..3] contains [1..2].
    def.stages.push({
      id: "wrap-up",
      kind: "agentic",
      instructions: "Summarize.",
      loop: { backTo: "gather-context", until: "everything is wrapped up", maxIterations: 2 },
    });
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.message.includes("must be disjoint"))).toBe(true);
  });

  it("accepts disjoint loop scopes", () => {
    const def = validPipelineDefinition();
    // Fixture loop spans [1..2]; add stages 3,4 with a loop spanning [3..4].
    def.stages.push(
      { id: "summarize", kind: "agentic", instructions: "Summarize the outcome." },
      {
        id: "polish",
        kind: "agentic",
        instructions: "Polish the summary.",
        loop: { backTo: "summarize", until: "the summary is clear", maxIterations: 2 },
      },
    );
    expect(validateDefinition(def, CTX)).toEqual([]);
  });

  it("flags durations over the 1-year ceiling", () => {
    const def = validPipelineDefinition();
    const gate = expectDefined(stage(def, 1).gate, "gate config");
    gate.timeout = "60w";
    const issues = validateDefinition(def, CTX);
    expect(issues.some((i) => i.message.includes("1-year wait ceiling"))).toBe(true);
  });
});
