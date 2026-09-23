import { describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import type { StageOutputs } from "./run-types.js";
import { buildAgenticStageInput, buildGatePrompt } from "./stage-input.js";
import { validPipelineDefinition } from "./test-fixtures.js";

const definition = validPipelineDefinition();
const gatherStage = expectDefined(definition.stages[0], "gather-context stage");
const gateStage = expectDefined(definition.stages[1], "plan-gate stage");
const implementStage = expectDefined(definition.stages[2], "implement stage");

const outputs: StageOutputs = {
  "gather-context": { kind: "text", text: "the issue is a flaky test" },
};

describe("buildAgenticStageInput", () => {
  it("names the pipeline and the stage's position, then the instructions", () => {
    const text = buildAgenticStageInput({
      pipelineName: "issue-to-pr",
      stage: gatherStage,
      stageIndex: 0,
      stageCount: 3,
      stageOutputs: {},
      priorStageIds: [],
    });
    expect(text).toContain('[Pipeline "issue-to-pr" — stage 1/3]');
    expect(text).toContain("Chat with the user until you understand the issue scope.");
    expect(text).toContain("complete_stage");
  });

  it("restates earlier stages' artifacts so the handoff is deterministic", () => {
    const text = buildAgenticStageInput({
      pipelineName: "issue-to-pr",
      stage: implementStage,
      stageIndex: 2,
      stageCount: 3,
      stageOutputs: outputs,
      priorStageIds: ["gather-context", "plan-gate"],
    });
    expect(text).toContain("## Output of earlier stages");
    expect(text).toContain("### gather-context");
    expect(text).toContain("the issue is a flaky test");
    // plan-gate produced nothing, so it contributes no section.
    expect(text).not.toContain("### plan-gate");
  });

  it("serializes a json artifact rather than rendering [object Object]", () => {
    const text = buildAgenticStageInput({
      pipelineName: "issue-to-pr",
      stage: implementStage,
      stageIndex: 2,
      stageCount: 3,
      stageOutputs: { "gather-context": { kind: "json", value: { severity: "high" } } },
      priorStageIds: ["gather-context"],
    });
    expect(text).toContain('"severity": "high"');
  });

  it("carries revise feedback into the re-entered stage", () => {
    const text = buildAgenticStageInput({
      pipelineName: "issue-to-pr",
      stage: gatherStage,
      stageIndex: 0,
      stageCount: 3,
      stageOutputs: outputs,
      priorStageIds: [],
      note: "you missed the staging environment",
    });
    expect(text).toContain("## Revision requested");
    expect(text).toContain("you missed the staging environment");
  });

  it("omits the revision section when there is no feedback", () => {
    const text = buildAgenticStageInput({
      pipelineName: "issue-to-pr",
      stage: gatherStage,
      stageIndex: 0,
      stageCount: 3,
      stageOutputs: {},
      priorStageIds: [],
    });
    expect(text).not.toContain("Revision requested");
  });
});

describe("buildGatePrompt", () => {
  it("names both resolution routes, because only some channels have buttons", () => {
    const text = buildGatePrompt({
      pipelineName: "issue-to-pr",
      stage: gateStage,
      stageIndex: 1,
      stageCount: 3,
    });
    expect(text).toContain("Present the plan and get approval.");
    expect(text).toContain("/gate approve");
    expect(text).toContain("/gate revise");
    expect(text).toContain("/gate cancel");
  });
});
