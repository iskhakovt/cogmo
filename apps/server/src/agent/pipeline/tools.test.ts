import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Service } from "../service.js";
import type { PipelinesService } from "./pipelines-service.js";
import {
  activatePipelineTool,
  definePipelineTool,
  listPipelinesTool,
  PIPELINE_TOOL_NAMES,
  startPipelineTool,
} from "./tools.js";

// Optional sub-namespace caveat (see .claude/rules/testing.md): mock<Service>()
// auto-mocks `pipelines` on access, so the absent-namespace test hand-builds
// the stub with conditional spread instead.
function serviceWith(pipelines?: PipelinesService): Service {
  return {
    memory: mock<Service["memory"]>(),
    files: mock<Service["files"]>(),
    coreMemory: mock<Service["coreMemory"]>(),
    ...(pipelines !== undefined && { pipelines }),
  };
}

const DESCRIPTION = "when I say go: gather context, draft a plan, gate on approval, implement";

describe("define_pipeline", () => {
  it("returns the preview and the confirm-then-activate instruction", async () => {
    const pipelines = mock<PipelinesService>();
    pipelines.define.mockResolvedValue(
      ok({ id: "d1", name: "issue-to-pr", version: 1, preview: "**Pipeline: issue-to-pr**" }),
    );

    const result = await definePipelineTool.handler(
      { description: DESCRIPTION },
      serviceWith(pipelines),
    );

    expect(JSON.parse(result)).toMatchObject({
      ok: true,
      preview: expect.stringContaining("issue-to-pr"),
      nextStep: expect.stringContaining("explicitly confirm"),
    });
    expect(pipelines.define).toHaveBeenCalledWith({ sourceText: DESCRIPTION });
  });

  it("renders compile issues as a clarification ask", async () => {
    const pipelines = mock<PipelinesService>();
    pipelines.define.mockResolvedValue(
      err({
        kind: "compile_failed",
        issues: [{ path: "trigger.source", message: "no external event sources" }],
      }),
    );

    const result = await definePipelineTool.handler(
      { description: DESCRIPTION },
      serviceWith(pipelines),
    );

    expect(result).toContain("trigger.source");
    expect(result).toContain("Ask the user to clarify");
  });

  it("throws a clear error when the namespace is absent", async () => {
    await expect(
      definePipelineTool.handler({ description: DESCRIPTION }, serviceWith()),
    ).rejects.toThrow(/unavailable/);
  });

  it("is marked durable — the compile is a billable LLM interaction", () => {
    expect(definePipelineTool.durable).toBe(true);
  });
});

describe("activate_pipeline", () => {
  it("activates by name and reports the version", async () => {
    const pipelines = mock<PipelinesService>();
    pipelines.activate.mockResolvedValue(ok({ name: "issue-to-pr", version: 2 }));

    const result = await activatePipelineTool.handler(
      { name: "issue-to-pr" },
      serviceWith(pipelines),
    );

    expect(JSON.parse(result)).toMatchObject({ ok: true, name: "issue-to-pr", version: 2 });
  });

  it("renders not_found with a pointer to list_pipelines", async () => {
    const pipelines = mock<PipelinesService>();
    pipelines.activate.mockResolvedValue(err({ kind: "not_found", name: "ghost" }));

    const result = await activatePipelineTool.handler({ name: "ghost" }, serviceWith(pipelines));

    expect(result).toContain('"ghost"');
    expect(result).toContain("list_pipelines");
  });
});

describe("list_pipelines", () => {
  it("renders an empty-state message", async () => {
    const pipelines = mock<PipelinesService>();
    pipelines.list.mockResolvedValue([]);
    const result = await listPipelinesTool.handler({}, serviceWith(pipelines));
    expect(result).toBe("No pipelines defined yet.");
  });

  it("is a pure read", () => {
    expect(listPipelinesTool.sideEffectful).toBe(false);
    expect(listPipelinesTool.parallelSafe).toBe(true);
  });
});

describe("start_pipeline", () => {
  const started = {
    runId: "run-1",
    conversationId: "conv-run",
    name: "issue-to-pr",
    version: 2,
    firstStage: "gather-context",
    recovered: false,
  };

  it("starts the named pipeline keyed on the durable call, and says where the run continues", async () => {
    const pipelines = mock<PipelinesService>();
    pipelines.start.mockResolvedValue(ok(started));

    const result = await startPipelineTool.handler(
      { name: "issue-to-pr" },
      serviceWith(pipelines),
      {
        idempotencyKey: "turn-7:iter-1:0",
      },
    );

    expect(pipelines.start).toHaveBeenCalledWith({
      name: "issue-to-pr",
      idempotencyKey: "start_pipeline:turn-7:iter-1:0",
    });
    expect(JSON.parse(result)).toMatchObject({
      ok: true,
      runId: "run-1",
      version: 2,
      firstStage: "gather-context",
      note: expect.stringContaining("new conversation"),
    });
  });

  it("is durable, so a retried turn recovers the run instead of opening another", () => {
    expect(startPipelineTool.durable).toBe(true);
  });

  it("uses a fresh key outside a retrying context", async () => {
    const pipelines = mock<PipelinesService>();
    pipelines.start.mockResolvedValue(ok(started));

    await startPipelineTool.handler({ name: "issue-to-pr" }, serviceWith(pipelines));
    await startPipelineTool.handler({ name: "issue-to-pr" }, serviceWith(pipelines));

    const keys = pipelines.start.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it.each([
    [{ kind: "not_active", name: "issue-to-pr" } as const, "has no active version"],
    [
      {
        kind: "unsupported_features",
        name: "issue-to-pr",
        features: ['loop on stage "implement"', "cron trigger"],
      } as const,
      'loop on stage "implement", cron trigger',
    ],
    [{ kind: "no_reachable_channel" } as const, "No channel can reach the user"],
    [{ kind: "no_gate_channel" } as const, "none of the user's reachable channels can show them"],
    [{ kind: "runs_unavailable" } as const, "aren't available"],
  ])("renders %o for the model", async (error, expected) => {
    const pipelines = mock<PipelinesService>();
    pipelines.start.mockResolvedValue(err(error));

    const result = await startPipelineTool.handler({ name: "issue-to-pr" }, serviceWith(pipelines));

    expect(result).toContain(expected);
  });

  it("is excluded from stage tool allowlists with the other pipeline tools", () => {
    expect(PIPELINE_TOOL_NAMES).toEqual([
      "define_pipeline",
      "activate_pipeline",
      "list_pipelines",
      "start_pipeline",
    ]);
  });
});
