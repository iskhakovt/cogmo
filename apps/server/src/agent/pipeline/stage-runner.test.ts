import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import { conversationTurnConcurrency } from "../../inngest/concurrency.js";
import { pipelineStageDue, responseReady } from "../../inngest/events.js";
import {
  directStep,
  fakeRunInTx,
  invokeInngestFn,
  invokeInngestOnFailure,
  spyOnInngestSend,
} from "../../test/factories.js";
import type { AgenticStageOutcome } from "./run-agentic-stage.js";
import { createPipelineStageRunner } from "./stage-runner.js";
import type { PipelineRunStatus, PipelineRunStore } from "./store/index.js";
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

function stageDue(stageId: string, iteration = 0, originConversationId?: string) {
  return {
    name: "pipeline/stage.due" as const,
    data: {
      runId: RUN_ID,
      conversationId: "conv-1",
      stageId,
      iteration,
      ...(originConversationId !== undefined && { originConversationId }),
    },
  };
}

type FailureCtx = {
  event: { data: { event: { data: { runId: string; stageId: string; iteration: number } } } };
  error: Error;
  step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };
};

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
  it("pins the trigger and the conversation-turn concurrency it shares with chat", () => {
    const { fn } = harness();
    expect(fn.opts.id).toBe("pipeline-stage-runner");
    expect(fn.opts.triggers).toEqual([pipelineStageDue]);
    expect(fn.opts.concurrency).toBe(conversationTurnConcurrency);
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
        data: { runId: RUN_ID, conversationId: "conv-1", stageId: "approve", iteration: 0 },
        id: `pipeline-stage-due-${RUN_ID}-approve-0`,
      }),
    );
  });

  it("runs a stage.due without a conversation id, taking it from the run", async () => {
    const { fn, runStore, executeAgenticStage } = harness({ kind: "completed", artifact: null });
    runStore.advanceStage.mockResolvedValue({ kind: "advanced" });
    const withoutConversation = {
      name: "pipeline/stage.due" as const,
      data: { runId: RUN_ID, stageId: "draft", iteration: 0 },
    };
    const t = new InngestTestEngine({ function: fn, events: [withoutConversation] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toEqual({ status: "advanced", nextStage: "approve" });
    expect(executeAgenticStage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1" }),
      expect.anything(),
      expect.anything(),
    );
    expect(ctx.step.sendEvent).toHaveBeenCalledWith(
      "emit-next-stage",
      expect.objectContaining({
        data: { runId: RUN_ID, conversationId: "conv-1", stageId: "approve", iteration: 0 },
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
    runStore.parkAtGate.mockResolvedValue({ kind: "transitioned" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("approve")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "approve" }) }],
    });

    expect(result).toEqual({ status: "waiting_gate" });
    expect(runStore.parkAtGate).toHaveBeenCalledWith(expect.anything(), RUN_ID);
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
    const failure = { reason: "artifact_invalid", detail: "/title is required" } as const;
    const { fn, runStore, notifyConversation } = harness({ kind: "failed", failure });
    runStore.failRunAt.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result, ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toEqual({ status: "failed", failure });
    expect(runStore.failRunAt).toHaveBeenCalledWith(
      expect.anything(),
      { runId: RUN_ID, stageId: "draft", iteration: 0 },
      failure,
    );
    expect(runStore.advanceStage).not.toHaveBeenCalled();
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '❌ Pipeline "plan-then-build" failed at stage "draft": the stage\'s result did not match its declared output (/title is required)',
    );
  });

  it("still tells the conversation when its failure had committed before the step was recorded", async () => {
    const failure = { reason: "turn_truncated", detail: null } as const;
    const { fn, runStore, notifyConversation } = harness({ kind: "failed", failure });
    runStore.failRunAt.mockResolvedValue({ kind: "already_failed", conversationId: "conv-1" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toEqual({ status: "failed", failure });
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining('failed at stage "draft"'),
    );
  });

  it("skips the failure when the run is no longer on the stage", async () => {
    const { fn, runStore, notifyConversation } = harness({
      kind: "failed",
      failure: { reason: "turn_truncated", detail: null },
    });
    runStore.failRunAt.mockResolvedValue({
      kind: "stale",
      status: "cancelled",
      currentStage: "draft",
      iteration: 0,
    });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toEqual({ status: "skipped", reason: "stale" });
    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("doesn't emit the next stage when the cursor already moved under the advance", async () => {
    const { fn, runStore } = harness();
    runStore.advanceStage.mockResolvedValue({
      kind: "stale",
      status: "running",
      currentStage: "build",
      iteration: 0,
    });
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
    runStore.failRunAt.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot({ compiled: withWait }) }],
    });

    expect(result).toEqual({
      status: "failed",
      failure: { reason: "unsupported_stage", detail: null },
    });
  });

  it("parks a run's first stage on the starting chat turn before running it", async () => {
    // `executeStep` stops at the wait, which is never resolved here: the stage
    // must not start while the turn that launched the run is still streaming
    // its reply. (Memoizing the wait doesn't work under InngestTestEngine —
    // the SDK rejects the mocked event against the trigger schema — and the
    // resumed path is the same code the no-origin test below runs.)
    const { fn, executeAgenticStage } = harness();
    const t = new InngestTestEngine({
      function: fn,
      events: [stageDue("draft", 0, "conv-chat")],
    });

    const { ctx } = await t.executeStep("wait-for-origin-turn", {
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(ctx.step.waitForEvent).toHaveBeenCalledWith("wait-for-origin-turn", {
      event: responseReady,
      timeout: "30s",
      if: 'async.data.conversationId == "conv-chat"',
    });
    expect(executeAgenticStage).not.toHaveBeenCalled();
  });

  it("does not wait for a turn on later stages or runs started without one", async () => {
    const { fn, runStore } = harness();
    runStore.completeRun.mockResolvedValue({ kind: "advanced" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("build", 0, "conv-chat")] });

    const { ctx } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "build" }) }],
    });

    expect(ctx.step.waitForEvent).not.toHaveBeenCalled();
  });

  it("onFailure fails the run with the error class and tells the conversation", async () => {
    const { fn, runStore, notifyConversation } = harness();
    runStore.failRunAt.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });

    await invokeInngestOnFailure<FailureCtx>(fn, {
      event: { data: { event: { data: { runId: RUN_ID, stageId: "draft", iteration: 0 } } } },
      error: new TypeError("Failed query: insert into messages ..."),
      step: { run: (_id, body) => body() },
    });

    // The class only: messages can carry query text or payloads.
    expect(runStore.failRunAt).toHaveBeenCalledWith(
      expect.anything(),
      { runId: RUN_ID, stageId: "draft", iteration: 0 },
      { reason: "stage_error", detail: "TypeError" },
    );
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '❌ The pipeline run failed at stage "draft" and has stopped.',
    );
  });

  it("onFailure still tells the conversation when its failure had already committed", async () => {
    const { fn, runStore, notifyConversation } = harness();
    runStore.failRunAt.mockResolvedValue({ kind: "already_failed", conversationId: "conv-1" });

    await invokeInngestOnFailure<FailureCtx>(fn, {
      event: { data: { event: { data: { runId: RUN_ID, stageId: "draft", iteration: 0 } } } },
      error: new Error("boom"),
      step: { run: (_id, body) => body() },
    });

    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '❌ The pipeline run failed at stage "draft" and has stopped.',
    );
  });

  it("onFailure leaves a run that has moved past the failed stage alone", async () => {
    // The advance committed and only the emit failed: the run is healthy on
    // the next stage, and failing it would blame a stage that never ran.
    const { fn, runStore, notifyConversation } = harness();
    runStore.failRunAt.mockResolvedValue({
      kind: "stale",
      status: "running",
      currentStage: "approve",
      iteration: 0,
    });

    await invokeInngestOnFailure<FailureCtx>(fn, {
      event: { data: { event: { data: { runId: RUN_ID, stageId: "draft", iteration: 0 } } } },
      error: new Error("boom"),
      step: { run: (_id, body) => body() },
    });

    expect(notifyConversation).not.toHaveBeenCalled();
  });

  describe("recovery after a step committed but its result was lost", () => {
    // The store reports where the run is under the row lock that decided
    // `stale`, so recovery decides from the memoized step result alone.
    const at = (status: PipelineRunStatus, currentStage: string, iteration: number) => ({
      kind: "stale" as const,
      status,
      currentStage,
      iteration,
    });

    it("re-sends gate.pending when the park had already committed for this gate", async () => {
      const { fn, runStore } = harness();
      runStore.parkAtGate.mockResolvedValue(at("waiting_gate", "approve", 0));
      const t = new InngestTestEngine({ function: fn, events: [stageDue("approve")] });

      const { result, ctx } = await t.execute({
        steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "approve" }) }],
      });

      expect(result).toEqual({ status: "waiting_gate" });
      expect(ctx.step.sendEvent).toHaveBeenCalledWith(
        "emit-gate-pending",
        expect.objectContaining({ id: `pipeline-gate-pending-${RUN_ID}:approve:0` }),
      );
    });

    it("stays skipped when the run is parked somewhere else", async () => {
      const { fn, runStore } = harness();
      runStore.parkAtGate.mockResolvedValue(at("waiting_gate", "sign-off", 0));
      const t = new InngestTestEngine({ function: fn, events: [stageDue("approve")] });

      const { result, ctx } = await t.execute({
        steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "approve" }) }],
      });

      expect(result).toEqual({ status: "skipped", reason: "stale" });
      expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    });

    it("re-sends the next stage when the advance had already committed", async () => {
      const { fn, runStore } = harness();
      runStore.advanceStage.mockResolvedValue(at("running", "approve", 0));
      const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

      const { result, ctx } = await t.execute({
        steps: [{ id: "load-run", handler: () => snapshot() }],
      });

      expect(result).toEqual({ status: "advanced", nextStage: "approve" });
      expect(ctx.step.sendEvent).toHaveBeenCalledWith(
        "emit-next-stage",
        expect.objectContaining({ id: `pipeline-stage-due-${RUN_ID}-approve-0` }),
      );
    });

    it("sends the completion notice when the completion had already committed", async () => {
      const { fn, runStore, notifyConversation } = harness();
      runStore.completeRun.mockResolvedValue(at("completed", "build", 0));
      const t = new InngestTestEngine({ function: fn, events: [stageDue("build")] });

      const { result } = await t.execute({
        steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "build" }) }],
      });

      expect(result).toEqual({ status: "completed" });
      expect(notifyConversation).toHaveBeenCalledWith(
        "conv-1",
        '✅ Pipeline "plan-then-build" completed.',
      );
    });

    it("stays skipped when the completion belongs to a different iteration", async () => {
      const { fn, runStore, notifyConversation } = harness();
      runStore.completeRun.mockResolvedValue(at("completed", "build", 1));
      const t = new InngestTestEngine({ function: fn, events: [stageDue("build")] });

      const { result } = await t.execute({
        steps: [{ id: "load-run", handler: () => snapshot({ currentStage: "build" }) }],
      });

      expect(result).toEqual({ status: "skipped", reason: "stale" });
      expect(notifyConversation).not.toHaveBeenCalled();
    });

    it("stays skipped when another delivery moved the run past the next stage", async () => {
      const { fn, runStore } = harness();
      runStore.advanceStage.mockResolvedValue(at("running", "build", 0));
      const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

      const { result, ctx } = await t.execute({
        steps: [{ id: "load-run", handler: () => snapshot() }],
      });

      expect(result).toEqual({ status: "skipped", reason: "stale" });
      expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe("notices that fail permanently", () => {
    const due = (stageId: string) => ({ name: "pipeline/stage.due", data: stageDue(stageId).data });

    it("still completes the run when the completion notice can't be delivered", async () => {
      const { fn } = harness();
      const step = directStep(
        {
          "load-run": snapshot({ currentStage: "build" }),
          "advance-run": { kind: "advanced" },
        },
        "notify-completed",
      );

      const result = await invokeInngestFn(fn, { event: due("build"), step, runId: "inngest-1" });

      expect(step.run).toHaveBeenCalledWith("notify-completed", expect.any(Function));
      expect(result).toEqual({ status: "completed" });
    });

    it("still reports the failure when the failure notice can't be delivered", async () => {
      const failure = { reason: "artifact_invalid", detail: "schema mismatch" } as const;
      const { fn } = harness({ kind: "failed", failure });
      const step = directStep(
        {
          "load-run": snapshot(),
          "fail-run": { kind: "failed", conversationId: "conv-1" },
        },
        "notify-failure",
      );

      const result = await invokeInngestFn(fn, { event: due("draft"), step, runId: "inngest-1" });

      expect(step.run).toHaveBeenCalledWith("notify-failure", expect.any(Function));
      expect(result).toEqual({ status: "failed", failure });
    });
  });

  it("onFailure still resolves when the failure notice can't be delivered", async () => {
    const { fn, runStore, notifyConversation } = harness();
    runStore.failRunAt.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });

    await expect(
      invokeInngestOnFailure<FailureCtx>(fn, {
        event: { data: { event: { data: { runId: RUN_ID, stageId: "draft", iteration: 0 } } } },
        error: new Error("boom"),
        step: directStep({}, "notify-failure"),
      }),
    ).resolves.toBeUndefined();
    expect(runStore.failRunAt).toHaveBeenCalled();
    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("skips a stage failure for a run that does not exist", async () => {
    const { fn, runStore, notifyConversation } = harness({
      kind: "failed",
      failure: { reason: "turn_truncated", detail: null },
    });
    runStore.failRunAt.mockResolvedValue({ kind: "not_found" });
    const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

    const { result } = await t.execute({
      steps: [{ id: "load-run", handler: () => snapshot() }],
    });

    expect(result).toEqual({ status: "skipped", reason: "not_found" });
    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("onFailure stays quiet for a run that does not exist", async () => {
    const { fn, runStore, notifyConversation } = harness();
    runStore.failRunAt.mockResolvedValue({ kind: "not_found" });

    await invokeInngestOnFailure<FailureCtx>(fn, {
      event: { data: { event: { data: { runId: RUN_ID, stageId: "draft", iteration: 0 } } } },
      error: new Error("boom"),
      step: { run: (_id, body) => body() },
    });

    expect(notifyConversation).not.toHaveBeenCalled();
  });

  describe("a fail-run result memoized by a build whose step returned failRun's outcome", () => {
    const memoized = { kind: "already_terminal", status: "cancelled" };

    it("is treated as stale by the stage body", async () => {
      const { fn, runStore, notifyConversation } = harness({
        kind: "failed",
        failure: { reason: "turn_truncated", detail: null },
      });
      const t = new InngestTestEngine({ function: fn, events: [stageDue("draft")] });

      const { result } = await t.execute({
        steps: [
          { id: "load-run", handler: () => snapshot() },
          { id: "fail-run", handler: () => memoized },
        ],
      });

      expect(result).toEqual({ status: "skipped", reason: "stale" });
      expect(runStore.failRunAt).not.toHaveBeenCalled();
      expect(notifyConversation).not.toHaveBeenCalled();
    });

    it("is treated as stale by onFailure", async () => {
      const { fn, runStore, notifyConversation } = harness();

      await invokeInngestOnFailure<FailureCtx>(fn, {
        event: { data: { event: { data: { runId: RUN_ID, stageId: "draft", iteration: 0 } } } },
        error: new Error("boom"),
        step: directStep({ "fail-run": memoized }, null),
      });

      expect(runStore.failRunAt).not.toHaveBeenCalled();
      expect(notifyConversation).not.toHaveBeenCalled();
    });
  });
});
