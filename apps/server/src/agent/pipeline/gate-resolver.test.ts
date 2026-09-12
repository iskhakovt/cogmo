import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import { pipelineGateResolved } from "../../inngest/events.js";
import { fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
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

function resolvedEvent(decision: "approved" | "cancelled" | "timeout_proceed" | "timeout_abort") {
  return {
    name: "pipeline/gate.resolved" as const,
    data: { runId: "run-1", gateKey: "run-1:approve:0", decision },
  };
}

function engine(decision: Parameters<typeof resolvedEvent>[0]) {
  const notifyConversation = vi.fn().mockResolvedValue(undefined);
  const fn = createPipelineGateResolver({
    runInTx: fakeRunInTx,
    runStore: mock<PipelineRunStore>(),
    deliveryRouter: { notifyConversation },
  });
  const t = new InngestTestEngine({ function: fn, events: [resolvedEvent(decision)] });
  return { t, fn, notifyConversation };
}

describe("gateNotice", () => {
  it.each([
    ["approved", advanced, null],
    ["timeout_proceed", advanced, 'pipeline "issue-to-pr" is proceeding to "build"'],
    ["approved", { kind: "completed", ...base }, '✅ Pipeline "issue-to-pr" completed.'],
    ["timeout_proceed", { kind: "completed", ...base }, "timed out — pipeline"],
    ["cancelled", { kind: "cancelled", ...base }, '❌ Pipeline "issue-to-pr" cancelled.'],
    ["timeout_abort", { kind: "cancelled", ...base }, "was cancelled"],
    ["approved", { kind: "stale" }, null],
    ["timeout_abort", { kind: "not_found" }, null],
  ] as const)("%s + %o → %s", (decision, outcome, expected) => {
    const notice = gateNotice(decision, outcome);
    if (expected === null) expect(notice).toBeNull();
    else expect(notice).toContain(expected);
  });
});

describe("createPipelineGateResolver", () => {
  it("pins the trigger and per-run concurrency", () => {
    const { fn } = engine("approved");
    expect(fn.opts.id).toBe("pipeline-gate-resolver");
    expect(fn.opts.triggers).toEqual([pipelineGateResolved]);
    expect(fn.opts.concurrency).toEqual({ limit: 1, key: "event.data.runId" });
  });

  it("emits the next stage after an advancing resolution, and stays quiet on a tapped approval", async () => {
    const { t, notifyConversation } = engine("approved");

    const { result, ctx } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => advanced }],
    });

    expect(result).toEqual(advanced);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith(
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
    const { t, notifyConversation } = engine("timeout_abort");

    const { ctx } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => ({ kind: "cancelled", ...base }) }],
    });

    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(notifyConversation).toHaveBeenCalledWith(
      "conv-1",
      '⏱ Checkpoint timed out — pipeline "issue-to-pr" was cancelled.',
    );
  });

  it("does nothing further for a stale resolution", async () => {
    const { t, notifyConversation } = engine("timeout_abort");

    const { result, ctx } = await t.execute({
      steps: [{ id: "resolve-gate", handler: () => ({ kind: "stale" }) }],
    });

    expect(result).toEqual({ kind: "stale" });
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(notifyConversation).not.toHaveBeenCalled();
  });
});
