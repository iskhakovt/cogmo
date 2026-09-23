import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Service } from "../service.js";
import { buildCompleteStageTool } from "./complete-stage-tool.js";
import type { PipelinesService } from "./pipelines-service.js";
import type { Stage } from "./types.js";

const CURSOR = { runId: "run-1", stageId: "draft", iteration: 0 };

function stage(overrides: Partial<Stage> = {}): Stage {
  return {
    id: "draft",
    kind: "agentic",
    instructions: "Draft the release notes.",
    ...overrides,
  };
}

/**
 * Hand-built rather than `mock<Service>()`: the tool reads
 * `service.pipelines` as possibly-absent, and the auto-mocking proxy makes
 * an absent namespace unrepresentable.
 */
function serviceWith(pipelines: PipelinesService | undefined): Service {
  return {
    memory: mock<Service["memory"]>(),
    files: mock<Service["files"]>(),
    coreMemory: mock<Service["coreMemory"]>(),
    ...(pipelines !== undefined && { pipelines }),
  };
}

function pipelinesStub() {
  const pipelines = mock<PipelinesService>();
  pipelines.completeStage.mockResolvedValue(undefined);
  return pipelines;
}

describe("buildCompleteStageTool", () => {
  it("records a text artifact for a stage that declares text output", async () => {
    const pipelines = pipelinesStub();
    const tool = buildCompleteStageTool(stage({ output: { kind: "text" } }), CURSOR);

    const result = await tool.handler({ text: "the notes" }, serviceWith(pipelines));

    expect(pipelines.completeStage).toHaveBeenCalledWith({
      ...CURSOR,
      artifact: { kind: "text", text: "the notes" },
    });
    expect(result).toContain('"ok":true');
  });

  it("records no artifact for a stage that declares no output", async () => {
    const pipelines = pipelinesStub();
    const tool = buildCompleteStageTool(stage(), CURSOR);

    await tool.handler({ summary: "chatted with the user" }, serviceWith(pipelines));

    expect(pipelines.completeStage).toHaveBeenCalledWith({ ...CURSOR, artifact: null });
  });

  it("validates a json value against the stage's declared schema", async () => {
    const pipelines = pipelinesStub();
    const tool = buildCompleteStageTool(
      stage({
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: { severity: { type: "string" } },
            required: ["severity"],
          },
        },
      }),
      CURSOR,
    );

    await tool.handler({ value: { severity: "high" } }, serviceWith(pipelines));

    expect(pipelines.completeStage).toHaveBeenCalledWith({
      ...CURSOR,
      artifact: { kind: "json", value: { severity: "high" } },
    });
  });

  it("hands a schema violation back to the model instead of recording it", async () => {
    const pipelines = pipelinesStub();
    const tool = buildCompleteStageTool(
      stage({
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: { severity: { type: "string" } },
            required: ["severity"],
          },
        },
      }),
      CURSOR,
    );

    const result = await tool.handler({ value: { sev: "high" } }, serviceWith(pipelines));

    expect(pipelines.completeStage).not.toHaveBeenCalled();
    expect(result).toContain("does not satisfy the stage's declared schema");
    expect(result).toContain("complete_stage again");
  });

  it("quotes the declared schema in its description so the model can satisfy it", () => {
    const tool = buildCompleteStageTool(
      stage({ output: { kind: "json", schema: { type: "object", title: "Triage" } } }),
      CURSOR,
    );
    expect(tool.description).toContain('"title":"Triage"');
    expect(tool.description).toContain("draft");
  });

  it("is durable and side-effectful — it moves the run", () => {
    const tool = buildCompleteStageTool(stage(), CURSOR);
    expect(tool.durable).toBe(true);
    expect(tool.sideEffectful).toBe(true);
    expect(tool.parallelSafe).toBe(false);
  });

  it("throws rather than silently dropping the completion when pipelines are unavailable", async () => {
    const tool = buildCompleteStageTool(stage(), CURSOR);
    await expect(tool.handler({ summary: "done" }, serviceWith(undefined))).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("rejects input the stage's schema does not allow before any recording", async () => {
    const pipelines = pipelinesStub();
    const tool = buildCompleteStageTool(stage({ output: { kind: "text" } }), CURSOR);
    // Empty text is not a handoff; the Zod schema refuses it.
    await expect(tool.handler({ text: "" }, serviceWith(pipelines))).rejects.toThrow();
    expect(pipelines.completeStage).not.toHaveBeenCalled();
  });
});

describe("stage cursor", () => {
  it("records against the iteration it was built for, not the stage alone", async () => {
    const pipelines = pipelinesStub();
    const tool = buildCompleteStageTool(stage(), { ...CURSOR, iteration: 2 });
    await tool.handler({ summary: "second pass" }, serviceWith(pipelines));
    expect(pipelines.completeStage).toHaveBeenCalledWith(expect.objectContaining({ iteration: 2 }));
  });

  it("does not mutate the cursor it was handed", async () => {
    const cursor = { ...CURSOR };
    const pipelines = pipelinesStub();
    const tool = buildCompleteStageTool(stage(), cursor);
    await tool.handler({ summary: "done" }, serviceWith(pipelines));
    expect(cursor).toEqual(CURSOR);
  });
});

describe("tool identity", () => {
  it("always registers under the same name, whatever the stage declares", () => {
    expect(buildCompleteStageTool(stage(), CURSOR).name).toBe("complete_stage");
    expect(buildCompleteStageTool(stage({ output: { kind: "text" } }), CURSOR).name).toBe(
      "complete_stage",
    );
  });

  it("does not reach for the service until the input validates", async () => {
    const pipelines = pipelinesStub();
    const service = serviceWith(pipelines);
    const spy = vi.spyOn(pipelines, "completeStage");
    const tool = buildCompleteStageTool(stage({ output: { kind: "text" } }), CURSOR);
    await expect(tool.handler({ nope: true }, service)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
