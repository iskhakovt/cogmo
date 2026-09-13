import { describe, expect, it } from "vitest";
import { findUnsupportedFeatures } from "./run-support.js";
import { validPipelineDefinition } from "./test-fixtures.js";
import type { PipelineDefinition } from "./types.js";

function linear(): PipelineDefinition {
  const def = validPipelineDefinition();
  return {
    ...def,
    stages: def.stages.map(({ loop: _loop, ...stage }) => stage),
  };
}

describe("findUnsupportedFeatures", () => {
  it("accepts a linear command pipeline of agentic and gate stages", () => {
    expect(findUnsupportedFeatures(linear())).toEqual([]);
  });

  it("flags the fixture's loop", () => {
    expect(findUnsupportedFeatures(validPipelineDefinition())).toEqual([
      'loop on stage "implement"',
    ]);
  });

  it("flags non-command triggers, wait stages, and coding artifacts together", () => {
    const def: PipelineDefinition = {
      name: "review-loop",
      trigger: { kind: "cron", schedule: "0 9 * * 1", timezone: "Europe/London" },
      stages: [
        {
          id: "draft",
          kind: "agentic",
          instructions: "Draft a plan.",
          output: { kind: "plan" },
        },
        {
          id: "wait-review",
          kind: "wait",
          wait: {
            event: "github/pr.review_submitted",
            timeout: "14d",
            onTimeout: { kind: "abort" },
          },
        },
        {
          id: "summarize",
          kind: "agentic",
          instructions: "Summarize.",
          output: { kind: "pr_metadata" },
        },
      ],
    };
    expect(findUnsupportedFeatures(def)).toEqual([
      "cron trigger",
      'plan output on stage "draft"',
      'wait stage "wait-review"',
      'pr_metadata output on stage "summarize"',
    ]);
  });

  it("accepts text and json outputs", () => {
    const def = linear();
    def.stages[0] = {
      id: "gather-context",
      kind: "agentic",
      instructions: "Gather.",
      output: { kind: "json", schema: { type: "object", properties: {} } },
    };
    expect(findUnsupportedFeatures(def)).toEqual([]);
  });
});
