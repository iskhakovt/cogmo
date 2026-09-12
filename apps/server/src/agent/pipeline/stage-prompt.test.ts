import { describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { buildStagePrompt } from "./stage-prompt.js";
import { validPipelineDefinition } from "./test-fixtures.js";

describe("buildStagePrompt", () => {
  it("frames the stage with its position, instructions, and text output contract", () => {
    const definition = validPipelineDefinition();
    const stage = expectDefined(definition.stages[0], "first stage");
    const prompt = buildStagePrompt({ definition, stage, stageOutputs: {} });

    expect(prompt).toContain('# Pipeline "issue-to-pr" — stage 1 of 3: gather-context');
    expect(prompt).toContain("Chat with the user until you understand the issue scope.");
    expect(prompt).toContain("Later stages receive that reply verbatim.");
    // Nothing handed off yet, so no handoff section.
    expect(prompt).not.toContain("Outputs from earlier stages");
  });

  it("renders earlier text and json artifacts as the handoff", () => {
    const definition = validPipelineDefinition();
    const stage = expectDefined(definition.stages[2], "implement stage");
    const prompt = buildStagePrompt({
      definition,
      stage,
      stageOutputs: {
        "gather-context": { kind: "text", text: "Fix the login redirect." },
        estimate: { kind: "json", value: { hours: 3 } },
      },
    });

    expect(prompt).toContain("stage 3 of 3: implement");
    expect(prompt).toContain("### gather-context\n\nFix the login redirect.");
    expect(prompt).toContain('### estimate\n\n```json\n{\n  "hours": 3\n}\n```');
  });

  it("states the JSON Schema a json-output stage must satisfy", () => {
    const definition = validPipelineDefinition();
    const schema = {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    };
    definition.stages[0] = {
      id: "gather-context",
      kind: "agentic",
      instructions: "Gather.",
      output: { kind: "json", schema },
    };
    const stage = expectDefined(definition.stages[0], "first stage");
    const prompt = buildStagePrompt({ definition, stage, stageOutputs: {} });

    expect(prompt).toContain("converted into structured data matching this JSON Schema");
    expect(prompt).toContain(JSON.stringify(schema, null, 2));
  });

  it("omits the output section for a stage that declares none", () => {
    const definition = validPipelineDefinition();
    const stage = expectDefined(definition.stages[2], "implement stage");
    expect(buildStagePrompt({ definition, stage, stageOutputs: {} })).not.toContain("## Output");
  });
});
