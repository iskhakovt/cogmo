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
    ["approved", { kind: "stale" }, "arrived after the checkpoint had already been resolved"],
    ["cancelled", { kind: "stale" }, "was not applied"],
    ["timeout_abort", { kind: "stale" }, null],
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
      steps: [{ id: "resolve-gate", handler: () => ({ kind: "stale" }) }],
    });

    expect(result).toEqual({ kind: "stale" });
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("was not applied"),
    );
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
});
