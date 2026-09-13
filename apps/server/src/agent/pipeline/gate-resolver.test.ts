import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import { type PipelineGateDecision, pipelineGateResolved } from "../../inngest/events.js";
import {
  directStep,
  fakeRunInTx,
  invokeInngestFn,
  invokeInngestOnFailure,
  spyOnInngestSend,
} from "../../test/factories.js";
import { createPipelineGateResolver, gateNotice } from "./gate-resolver.js";
import type { ResolveGateOutcome } from "./resolve-gate.js";
import type { PipelineRunRow, PipelineRunStore } from "./store/index.js";

let sendSpy: ReturnType<typeof spyOnInngestSend>;
beforeEach(() => {
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: ["fake"] });
});
afterEach(() => {
  sendSpy.mockRestore();
});

const base = { conversationId: "conv-1", pipelineName: "issue-to-pr" };
const TOO_LATE = "arrived after the checkpoint had already been resolved";
const advanced: ResolveGateOutcome = {
  kind: "advanced",
  ...base,
  nextStage: "build",
  iteration: 0,
};

type Stale = Extract<ResolveGateOutcome, { kind: "stale" }>;
const staleAt = (overrides: Partial<Stale>): Stale => ({
  kind: "stale",
  ...base,
  status: "running",
  currentStage: "build",
  iteration: 0,
  gateStage: "approve",
  gateIteration: 0,
  nextStage: "build",
  pastGate: true,
  appliedByThis: false,
  ...overrides,
});
/** The run sits on the stage right after the approve gate. */
const staleAdvanced = staleAt({});
/** The run was cancelled at the approve gate. */
const staleCancelled = staleAt({ status: "cancelled", currentStage: "approve", pastGate: false });
/** The same positions, where the run's recorded claim is this resolution's own. */
const ownAdvanced = staleAt({ appliedByThis: true });
const ownCancelled = staleAt({
  status: "cancelled",
  currentStage: "approve",
  pastGate: false,
  appliedByThis: true,
});
const ownCompleted = staleAt({
  status: "completed",
  currentStage: "approve",
  nextStage: null,
  appliedByThis: true,
});

function eventData(decision: PipelineGateDecision) {
  return { runId: "run-1", gateKey: "run-1:approve:0", conversationId: "conv-1", decision };
}

function runAt(status: PipelineRunRow["status"], currentStage: string): PipelineRunRow {
  return {
    id: "run-1",
    definitionId: "def-1",
    conversationId: "conv-1",
    status,
    currentStage,
    iteration: 0,
    stageOutputs: {},
    failureReason: null,
    gateResolution: null,
    idempotencyKey: "k1",
    createdAt: new Date("2026-09-12T00:00:00Z"),
  };
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

/** The memoized `resolve-gate` step result. */
function resolved(outcome: ResolveGateOutcome) {
  return { id: "resolve-gate", handler: () => outcome };
}

type FailureCtx = {
  event: { data: { event: { data: ReturnType<typeof eventData> } } };
  error: Error;
  step: ReturnType<typeof directStep>;
};

function failureCtx(decision: PipelineGateDecision, failingStep: string | null): FailureCtx {
  return {
    event: { data: { event: { data: eventData(decision) } } },
    error: new TypeError("connection terminated"),
    step: directStep({}, failingStep),
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
    ["timeout_abort", { kind: "not_found" }, null],
  ] as const)("%s + %o → %s", (decision, outcome, expected) => {
    const notice = gateNotice(decision, outcome);
    if (expected === null) expect(notice).toBeNull();
    else expect(notice).toContain(expected);
  });

  it.each([
    // A tap whose decision didn't take is told so.
    ["approved", staleCancelled, TOO_LATE],
    ["cancelled", staleAdvanced, "was not applied"],
    // A decision that already stands, applied by another resolution — a tap
    // racing the timeout — which sent its own notice.
    ["approved", staleAdvanced, null],
    ["timeout_proceed", staleAdvanced, null],
    ["timeout_abort", staleCancelled, null],
    ["cancelled", staleCancelled, null],
    ["timeout_abort", staleAdvanced, null],
  ] as const)("claimed by another resolution: %s + %o → %s", (decision, outcome, expected) => {
    const notice = gateNotice(decision, outcome);
    if (expected === null) expect(notice).toBeNull();
    else expect(notice).toContain(expected);
  });

  it.each([
    // Its own claim, re-run after the commit, with its effect exactly in place:
    // sends the notice the first run of the step died before sending.
    ["cancelled", ownCancelled, '❌ Pipeline "issue-to-pr" cancelled.'],
    ["timeout_abort", ownCancelled, "was cancelled"],
    ["approved", ownCompleted, '✅ Pipeline "issue-to-pr" completed.'],
    ["timeout_proceed", ownAdvanced, 'is proceeding to "build"'],
    ["approved", ownAdvanced, null],
    // Once the run has moved on from that position, a notice would describe
    // something this resolution didn't do.
    ["timeout_proceed", staleAt({ status: "failed", appliedByThis: true }), null],
    ["timeout_proceed", staleAt({ currentStage: "sign-off", appliedByThis: true }), null],
  ] as const)("its own claim: %s + %o → %s", (decision, outcome, expected) => {
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

    const { result, ctx } = await t.execute({ steps: [resolved(advanced)] });

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

    const { ctx } = await t.execute({ steps: [resolved({ kind: "cancelled", ...base })] });

    expect(ctx.step.sendEvent).toHaveBeenCalledTimes(1);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith("emit-gate-settled", expect.anything());
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '⏱ Checkpoint timed out — pipeline "issue-to-pr" was cancelled.',
    );
  });

  it("tells a tap that lost the race it was not applied", async () => {
    const { t, notifyConversation } = harness("approved");

    const { result } = await t.execute({ steps: [resolved(staleCancelled)] });

    expect(result).toEqual(staleCancelled);
    expect(notifyConversation).toHaveBeenCalledWith("conv-1", expect.stringContaining(TOO_LATE));
  });

  it("stays silent when a timeout lost to a tap with the same effect", async () => {
    // The tap advanced the run (silently, as taps do); the queued timeout must
    // not then announce that the checkpoint timed out.
    const { t, notifyConversation } = harness("timeout_proceed");

    await t.execute({ steps: [resolved(staleAdvanced)] });

    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("re-sends the next stage when this resolution's own claim already stands", async () => {
    const { t, notifyConversation } = harness("approved");

    const { ctx } = await t.execute({ steps: [resolved(ownAdvanced)] });

    expect(ctx.step.sendEvent).toHaveBeenCalledWith(
      "emit-next-stage",
      expect.objectContaining({ id: "pipeline-stage-due-run-1-build-0" }),
    );
    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("leaves the next stage to the resolution that claimed the gate", async () => {
    const { t } = harness("approved");

    const { ctx } = await t.execute({ steps: [resolved(staleAdvanced)] });

    expect(ctx.step.sendEvent).toHaveBeenCalledTimes(1);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith("emit-gate-settled", expect.anything());
  });

  it("doesn't re-send a next stage that has already parked", async () => {
    const { t } = harness("approved");

    const { ctx } = await t.execute({
      steps: [resolved(staleAt({ status: "waiting_gate", appliedByThis: true }))],
    });

    expect(ctx.step.sendEvent).toHaveBeenCalledTimes(1);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith("emit-gate-settled", expect.anything());
  });

  it("sends the lost notice when its own cancellation had already been applied", async () => {
    const { t, notifyConversation } = harness("timeout_abort");

    await t.execute({ steps: [resolved(ownCancelled)] });

    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '⏱ Checkpoint timed out — pipeline "issue-to-pr" was cancelled.',
    );
  });

  it("doesn't re-send a stage the run has already moved beyond", async () => {
    const { t } = harness("timeout_proceed");

    const { ctx } = await t.execute({
      steps: [resolved(staleAt({ currentStage: "sign-off", appliedByThis: true }))],
    });

    expect(ctx.step.sendEvent).toHaveBeenCalledTimes(1);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith("emit-gate-settled", expect.anything());
  });

  it("finishes the run even when the notice step fails permanently", async () => {
    // Without the catch around the notice step, this failure would reach
    // onFailure, which fails a run the resolution already advanced.
    const { fn } = harness("timeout_abort");
    const cancelled: ResolveGateOutcome = { kind: "cancelled", ...base };
    const step = directStep({ "resolve-gate": cancelled }, "notify");

    const result = await invokeInngestFn(fn, {
      event: { name: "pipeline/gate.resolved", data: eventData("timeout_abort") },
      step,
      runId: "inngest-run-1",
    });

    expect(step.run).toHaveBeenCalledWith("notify", expect.any(Function));
    expect(result).toEqual(cancelled);
  });

  it("claims the gate under this function run's id", async () => {
    // The Inngest run id is stable across retries of the resolution and unique
    // to it, so a re-run step recognises its own claim and nothing else's.
    const { fn, runStore } = harness("approved");
    runStore.getRunWithDefinition.mockResolvedValue({
      run: runAt("waiting_gate", "approve"),
      definition: {
        id: "def-1",
        userId: "user-1",
        name: "issue-to-pr",
        version: 1,
        sourceText: "source",
        compiled: {
          name: "issue-to-pr",
          trigger: { kind: "command", phrase: "issue to pr" },
          stages: [
            {
              id: "approve",
              kind: "gate",
              instructions: "Approve?",
              gate: { timeout: "1d", onTimeout: { kind: "abort" } },
            },
            { id: "build", kind: "agentic", instructions: "Build." },
          ],
        },
        active: true,
        createdAt: new Date("2026-09-12T00:00:00Z"),
      },
    });
    runStore.claimGate.mockResolvedValue({ kind: "transitioned" });
    runStore.advanceStage.mockResolvedValue({ kind: "advanced" });

    const result = await invokeInngestFn(fn, {
      event: { name: "pipeline/gate.resolved", data: eventData("approved") },
      step: directStep({}, null),
      runId: "inngest-run-7",
    });

    expect(runStore.claimGate).toHaveBeenCalledWith(expect.anything(), "run-1", {
      gateKey: "run-1:approve:0",
      resolverRunId: "inngest-run-7",
    });
    expect(result).toEqual(advanced);
  });

  it("neither settles nor notifies for a run that does not exist", async () => {
    const { t, notifyConversation } = harness("timeout_abort");

    const { ctx } = await t.execute({ steps: [resolved({ kind: "not_found" })] });

    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(notifyConversation).not.toHaveBeenCalled();
  });
});

describe("createPipelineGateResolver onFailure", () => {
  it("tells the user a tapped decision didn't apply while the gate is still parked", async () => {
    const { fn, runStore, notifyConversation } = harness("approved");
    runStore.getRun.mockResolvedValue(runAt("waiting_gate", "approve"));

    await invokeInngestOnFailure<FailureCtx>(fn, failureCtx("approved", null));

    expect(runStore.failRun).not.toHaveBeenCalled();
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("will resolve on its timeout"),
    );
  });

  it("fails the run when a tap's resolution committed but what follows it couldn't be sent", async () => {
    // The flip and advance committed; a later emit failed for good. The waiter
    // may already be cancelled and no stage is scheduled, so nothing else would
    // ever move the run — and the gate is no longer open to resolve.
    const { fn, runStore, notifyConversation } = harness("approved");
    runStore.getRun.mockResolvedValue(runAt("running", "build"));
    runStore.failRun.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });

    await invokeInngestOnFailure<FailureCtx>(fn, failureCtx("approved", null));

    expect(runStore.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      "gate resolution could not be completed (TypeError)",
    );
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("the run has stopped"),
    );
    expect(notifyConversation).not.toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("will resolve on its timeout"),
    );
  });

  it("fails the run when a timeout can't be applied, since no waiter remains", async () => {
    const { fn, runStore, notifyConversation } = harness("timeout_proceed");
    runStore.getRun.mockResolvedValue(runAt("waiting_gate", "approve"));
    runStore.failRun.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });

    await invokeInngestOnFailure<FailureCtx>(fn, failureCtx("timeout_proceed", null));

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
    runStore.getRun.mockResolvedValue(runAt("cancelled", "approve"));
    runStore.failRun.mockResolvedValue({ kind: "already_terminal", status: "cancelled" });

    await invokeInngestOnFailure<FailureCtx>(fn, failureCtx("timeout_abort", null));

    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("still resolves when the failure notice can't be delivered", async () => {
    const { fn, runStore } = harness("approved");
    runStore.getRun.mockResolvedValue(runAt("waiting_gate", "approve"));

    await expect(
      invokeInngestOnFailure<FailureCtx>(fn, failureCtx("approved", "notify-tap-failed")),
    ).resolves.toBeUndefined();
  });
});
