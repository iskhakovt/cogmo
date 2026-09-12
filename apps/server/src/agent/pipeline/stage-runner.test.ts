import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import { pipelineStageDue } from "../../inngest/events.js";
import { fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
import type { AgenticStageOutcome } from "./run-agentic-stage.js";
import { createPipelineStageRunner } from "./stage-runner.js";
import type { PipelineRunStore } from "./store/index.js";
import type { PipelineDefinition } from "./types.js";

let sendSpy: ReturnType<typeof spyOnInngestSend>;
beforeEach(() => {
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: ["fake"] });
});
afterEach(() => {
  sendSpy.mockRestore();
});

const RUN_ID = "run-1";

const DEFINITION: PipelineDefinition = {
  name: "plan-then-build",
  trigger: { kind: "command", phrase: "plan then build" },
  stages: [
    { id: "draft", kind: "agentic", instructions: "Draft a plan.", output: { kind: "text" } },
    {
      id: "approve",
      kind: "gate",
      instructions: "Approve the plan?",
      gate: {
        timeout: "2d",
        onTimeout: { kind: "remind", maxReminders: 1, finalAction: "abort" },
      },
    },
    { id: "build", kind: "agentic", instructions: "Build it." },
  ],
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    status: "running",
    currentStage: "draft",
    iteration: 0,
    conversationId: "conv-1",
    stageOutputs: {},
    compiled: DEFINITION,
    ...overrides,
  };
}

function stageDue(stageId: string, iteration = 0) {
  return { name: "pipeline/stage.due" as const, data: { runId: RUN_ID, stageId, iteration } };
}

function harness(outcome?: AgenticStageOutcome) {
  const runStore = mock<PipelineRunStore>();
  const notifyConversation = vi.fn().mockResolvedValue(undefined);
  const executeAgenticStage = vi
    .fn()
    .mockResolvedValue(outcome ?? { kind: "completed", artifact: null });
  const fn = createPipelineStageRunner({
    runInTx: fakeRunInTx,
    runStore,
    deliveryRouter: { notifyConversation },
    executeAgenticStage,
  });
  return { fn, runStore, notifyConversation, executeAgenticStage };
}

describe("createPipelineStageRunner", () => {
  it("pins the trigger and per-run concurrency", () => {
    const { fn } = harness();
    expect(fn.opts.id).toBe("pipeline-stage-runner");
    expect(fn.opts.triggers).toEqual([pipelineStageDue]);
    expect(fn.opts.concurrency).toEqual({ limit: 1, key: "event.data.runId" });
  });

  it("runs an agentic stage, records its artifact, and emits the next stage", async () => {
    const artifact = { kind: "text", text: "the plan" } as const;
    const { fn, runStore, executeAgenticStage } = harness({ kind: "completed", artifact });
    runStore.advanceStage.mockResolvedValue({ kind: "advanced" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toEqual({ status: "advanced", nextStage: "approve" });
    const [args] = executeAgenticStage.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      runId: RUN_ID,
      stageId: "draft",
      iteration: 0,
      conversationId: "conv-1",
      stage: { id: "draft", kind: "agentic" },
    });
    expect(runStore.advanceStage).toHaveBeenCalledWith(expect.anything(), {
      runId: RUN_ID,
      fromStage: "draft",
      output: artifact,
      toStage: "approve",
    });
    expect(ctx.step.sendEvent).toHaveBeenCalledWith(
      "emit-next-stage",
      expect.objectContaining({
        name: "pipeline/stage.due",
        data: { runId: RUN_ID, stageId: "approve", iteration: 0 },
        id: `pipeline-stage-due-${RUN_ID}-approve-0`,
      }),
    );
  });

  it("completes the run after its final agentic stage and says so", async () => {
    const { fn, runStore, notifyConversation } = harness();
    runStore.completeRun.mockResolvedValue({ kind: "advanced" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("build")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "build" }) }],
    });

    expect(result).toEqual({ status: "completed" });
    expect(runStore.completeRun).toHaveBeenCalledWith(expect.anything(), {
      runId: RUN_ID,
      fromStage: "build",
      output: null,
    });
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '✅ Pipeline "plan-then-build" completed.',
    );
  });

  it("parks on a gate stage and emits gate.pending with the parsed timeout", async () => {
    const { fn, runStore, executeAgenticStage } = harness();
    runStore.transitionStatus.mockResolvedValue({ kind: "transitioned" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("approve")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "approve" }) }],
    });

    expect(result).toEqual({ status: "waiting_gate" });
    expect(runStore.transitionStatus).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      "running",
      "waiting_gate",
    );
    expect(executeAgenticStage).not.toHaveBeenCalled();
    expect(ctx.step.sendEvent).toHaveBeenCalledWith(
      "emit-gate-pending",
      expect.objectContaining({
        name: "pipeline/gate.pending",
        id: `pipeline-gate-pending-${RUN_ID}:approve:0`,
        data: {
          runId: RUN_ID,
          gateKey: `${RUN_ID}:approve:0`,
          conversationId: "conv-1",
          pipelineName: "plan-then-build",
          stageId: "approve",
          prompt: "Approve the plan?",
          timeoutMs: 2 * 86_400_000,
          onTimeout: { kind: "remind", maxReminders: 1, finalAction: "abort" },
        },
      }),
    );
  });

  it.each([
    ["the run is parked", { status: "waiting_gate" }],
    ["the run moved to another stage", { currentStage: "build" }],
    ["the run is terminal", { status: "cancelled" }],
    ["the iteration differs", { iteration: 1 }],
  ])("skips a stale delivery when %s", async (_label, overrides) => {
    const { fn, runStore, executeAgenticStage } = harness();
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot(overrides) }],
    });

    expect(result).toEqual({ status: "skipped", reason: "stale" });
    expect(executeAgenticStage).not.toHaveBeenCalled();
    expect(runStore.advanceStage).not.toHaveBeenCalled();
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("skips a delivery for a run that does not exist", async () => {
    const { fn } = harness();
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result } = await t.execute({
      steps: [{ id: "load-run", handler: () => ({ found: false }) }],
    });

    expect(result).toEqual({ status: "skipped", reason: "not_found" });
  });

  it("fails the run with the stage's reason and tells the conversation", async () => {
    const { fn, runStore, notifyConversation } = harness({
      kind: "failed",
      reason: "the stage's result did not match its declared output: /title is required",
    });
    runStore.failRun.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(runStore.failRun).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      "the stage's result did not match its declared output: /title is required",
    );
    expect(runStore.advanceStage).not.toHaveBeenCalled();
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining('failed at stage "draft"'),
    );
  });

  it("doesn't emit the next stage when the cursor already moved under the advance", async () => {
    const { fn, runStore } = harness();
    runStore.advanceStage.mockResolvedValue({ kind: "stale", currentStage: "approve" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toEqual({ status: "skipped", reason: "stale" });
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("fails a run whose definition reaches a wait stage", async () => {
    const withWait: PipelineDefinition = {
      ...DEFINITION,
      stages: [
        {
          id: "draft",
          kind: "wait",
          wait: {
            event: "github/pr.review_submitted",
            timeout: "1d",
            onTimeout: { kind: "abort" },
          },
        },
      ],
    };
    const { fn, runStore } = harness();
    runStore.failRun.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot({ compiled: withWait }) }],
    });

    expect(result).toEqual({ status: "failed", reason: "wait stages are not supported yet" });
  });
});
