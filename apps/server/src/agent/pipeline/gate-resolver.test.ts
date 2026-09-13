import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import { type PipelineGateDecision, pipelineGateResolved } from "../../inngest/events.js";
import { fakeRunInTx, invokeInngestOnFailure, spyOnInngestSend } from "../../test/factories.js";
import { createPipelineGateResolver, gateNotice } from "./gate-resolver.js";
import type { ResolveGateOutcome } from "./resolve-gate.js";
import type { PipelineRunStore } from "./store/index.js";

let sendSpy: ReturnType<typeof spyOnInngestSend>;
beforeEach(() => {
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: ["fake"] });
});
afterEach(() => {
  sendSpy.mockRestore();
});

const base = { conversationId: "conv-1", pipelineName: "issue-to-pr" };
const advanced: ResolveGateOutcome = {
  kind: "advanced",
  ...base,
  nextStage: "build",
  iteration: 0,
};

/** A resolution that found the run already moved on past the approve gate. */
const staleAdvanced: ResolveGateOutcome = {
  kind: "stale",
  ...base,
  status: "running",
  currentStage: "build",
  iteration: 0,
  gateStage: "approve",
  nextStage: "build",
  pastGate: true,
};
/** A resolution that found the run already cancelled at the approve gate. */
const staleCancelled: ResolveGateOutcome = {
  kind: "stale",
  ...base,
  status: "cancelled",
  currentStage: "approve",
  iteration: 0,
  gateStage: "approve",
  nextStage: "build",
  pastGate: false,
};

/** A resolution that found the run already completed at its final gate. */
const staleCompleted: ResolveGateOutcome = {
  kind: "stale",
  ...base,
  status: "completed",
  currentStage: "approve",
  iteration: 0,
  gateStage: "approve",
  nextStage: null,
  pastGate: true,
};

function eventData(decision: PipelineGateDecision) {
  return { runId: "run-1", gateKey: "run-1:approve:0", conversationId: "conv-1", decision };
}

function harness(decision: PipelineGateDecision) {
  const notifyConversation = vi.fn().mockResolvedValue(undefined);
  const runStore = mock<PipelineRunStore>();
  const fn = createPipelineGateResolver({
    runInTx: fakeRunInTx,
    runStore,
    deliveryRouter: { notifyConversation },
  });
  const t = new InngestTestEngine({
    function: fn,
    events: [{ name: "pipeline/gate.resolved" as const, data: eventData(decision) }],
  });
  return { t, fn, runStore, notifyConversation };
}

type FailureCtx = {
  event: { data: { event: { data: ReturnType<typeof eventData> } } };
  error: Error;
  step: { run: (id: string, fn: () => unknown) => unknown };
};

function failureCtx(decision: PipelineGateDecision): FailureCtx {
  return {
    event: { data: { event: { data: eventData(decision) } } },
    error: new TypeError("connection terminated"),
    step: { run: (_id, fn) => fn() },
  };
}

describe("gateNotice", () => {
  it.each([
    ["approved", advanced, null],
    ["timeout_proceed", advanced, 'pipeline "issue-to-pr" is proceeding to "build"'],
    ["approved", { kind: "completed", ...base }, '✅ Pipeline "issue-to-pr" completed.'],
    ["timeout_proceed", { kind: "completed", ...base }, "timed out — pipeline"],
    ["cancelled", { kind: "cancelled", ...base }, '❌ Pipeline "issue-to-pr" cancelled.'],
    ["timeout_abort", { kind: "cancelled", ...base }, "was cancelled"],
    ["approved", staleCancelled, "arrived after the checkpoint had already been resolved"],
    ["cancelled", staleAdvanced, "was not applied"],
    ["approved", staleAdvanced, null],
    // A stale resolution whose decision already stands sends the notice its
    // effect calls for: a retry after a lost commit would otherwise send none.
    ["cancelled", staleCancelled, '❌ Pipeline "issue-to-pr" cancelled.'],
    ["timeout_abort", staleCancelled, "was cancelled"],
    ["approved", staleCompleted, '✅ Pipeline "issue-to-pr" completed.'],
    ["timeout_proceed", staleAdvanced, 'is proceeding to "build"'],
    ["timeout_abort", staleAdvanced, null],
    ["timeout_abort", { kind: "not_found" }, null],
  ] as const)("%s + %o → %s", (decision, outcome, expected) => {
    const notice = gateNotice(decision, outcome);
    if (expected === null) expect(notice).toBeNull();
    else expect(notice).toContain(expected);
  });
});

describe("createPipelineGateResolver", () => {
  it("pins the trigger and per-run concurrency", () => {
    const { fn } = harness("approved");
    expect(fn.opts.id).toBe("pipeline-gate-resolver");
    expect(fn.opts.triggers).toEqual([pipelineGateResolved]);
    expect(fn.opts.concurrency).toEqual({ limit: 1, key: "event.data.runId" });
  });

  it("settles the gate, then emits the next stage, and stays quiet on a tapped approval", async () => {
    const { t, notifyConversation } = harness("approved");

    const { result, ctx } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => advanced }],
    });

    expect(result).toEqual(advanced);
    expect(ctx.step.sendEvent).toHaveBeenNthCalledWith(
      1,
      "emit-gate-settled",
      expect.objectContaining({
        name: "pipeline/gate.settled",
        data: { runId: "run-1", gateKey: "run-1:approve:0" },
      }),
    );
    expect(ctx.step.sendEvent).toHaveBeenNthCalledWith(
      2,
      "emit-next-stage",
      expect.objectContaining({
        name: "pipeline/stage.due",
        data: { runId: "run-1", stageId: "build", iteration: 0 },
        id: "pipeline-stage-due-run-1-build-0",
      }),
    );
    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("notifies the conversation when a timeout cancels the run, without emitting a stage", async () => {
    const { t, notifyConversation } = harness("timeout_abort");

    const { ctx } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => ({ kind: "cancelled", ...base }) }],
    });

    expect(ctx.step.sendEvent).toHaveBeenCalledTimes(1);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith("emit-gate-settled", expect.anything());
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '⏱ Checkpoint timed out — pipeline "issue-to-pr" was cancelled.',
    );
  });

  it("tells a tap that lost the race it was not applied", async () => {
    const { t, notifyConversation } = harness("approved");

    const { result } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => staleCancelled }],
    });

    expect(result).toEqual(staleCancelled);
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("was not applied"),
    );
  });

  it("re-sends the next stage, silently, when this resolution had already been applied", async () => {
    // A retry after `resolve-gate` committed but lost its result, or a
    // same-effect resolution that raced it: either way the run sits on the
    // stage after the gate and the emit is deduped on the cursor.
    const { t, notifyConversation } = harness("approved");

    const { ctx } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => staleAdvanced }],
    });

    expect(ctx.step.sendEvent).toHaveBeenCalledWith(
      "emit-next-stage",
      expect.objectContaining({ id: "pipeline-stage-due-run-1-build-0" }),
    );
    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("sends the lost notice when a timeout's cancellation had already been applied", async () => {
    const { t, notifyConversation } = harness("timeout_abort");

    await t.execute({ steps: [{ id: "resolve-gate", handler: () => staleCancelled }] });

    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '⏱ Checkpoint timed out — pipeline "issue-to-pr" was cancelled.',
    );
  });

  it("doesn't re-send a stage the run has already moved beyond", async () => {
    const { t } = harness("timeout_proceed");

    const { ctx } = await t.execute({
      steps: [
        {
          id: "resolve-gate",
          handler: () => ({ ...staleAdvanced, currentStage: "sign-off" }),
        },
      ],
    });

    expect(ctx.step.sendEvent).toHaveBeenCalledTimes(1);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith("emit-gate-settled", expect.anything());
  });

  it("neither settles nor notifies for a run that does not exist", async () => {
    const { t, notifyConversation } = harness("timeout_abort");

    const { ctx } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => ({ kind: "not_found" }) }],
    });

    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(notifyConversation).not.toHaveBeenCalled();
  });
});

describe("createPipelineGateResolver onFailure", () => {
  it("tells the user a tapped decision didn't apply and leaves the run to its waiter", async () => {
    const { fn, runStore, notifyConversation } = harness("approved");

    await invokeInngestOnFailure<FailureCtx>(fn, failureCtx("approved"));

    expect(runStore.failRun).not.toHaveBeenCalled();
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("will resolve on its timeout"),
    );
  });

  it("fails the run when a timeout can't be applied, since no waiter remains", async () => {
    const { fn, runStore, notifyConversation } = harness("timeout_proceed");
    runStore.failRun.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });

    await invokeInngestOnFailure<FailureCtx>(fn, failureCtx("timeout_proceed"));

    expect(runStore.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      "gate timeout could not be applied (TypeError)",
    );
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("the run has stopped"),
    );
  });

  it("stays quiet when the run was already terminal", async () => {
    const { fn, runStore, notifyConversation } = harness("timeout_abort");
    runStore.failRun.mockResolvedValue({ kind: "already_terminal", status: "cancelled" });

    await invokeInngestOnFailure<FailureCtx>(fn, failureCtx("timeout_abort"));

    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("still resolves when the failure notice can't be delivered", async () => {
    const { fn, notifyConversation } = harness("approved");
    notifyConversation.mockRejectedValue(new Error("session lookup failed"));

    await expect(
      invokeInngestOnFailure<FailureCtx>(fn, failureCtx("approved")),
    ).resolves.toBeUndefined();
  });
});
