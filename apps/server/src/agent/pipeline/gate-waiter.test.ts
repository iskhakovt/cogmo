import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../../inngest/client.js";
import {
  type PipelineGatePendingData,
  pipelineGatePending,
  pipelineGateSettled,
} from "../../inngest/events.js";
import { spyOnInngestSend } from "../../test/factories.js";
import { createPipelineGateWaiter, reminderCount, timeoutDecision } from "./gate-waiter.js";

let sendSpy: ReturnType<typeof spyOnInngestSend>;
beforeEach(() => {
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: ["fake"] });
});
afterEach(() => {
  sendSpy.mockRestore();
});

function pendingEvent(onTimeout: PipelineGatePendingData["onTimeout"]) {
  return {
    name: "pipeline/gate.pending" as const,
    data: {
      runId: "run-1",
      gateKey: "run-1:plan-gate:0",
      conversationId: "conv-1",
      pipelineName: "issue-to-pr",
      stageId: "plan-gate",
      prompt: "Approve the plan?",
      timeoutMs: 3_600_000,
      onTimeout,
    },
  };
}

describe("pipeline gate waiter", () => {
  it("pins trigger, idempotency and cancelOn to the gate key", () => {
    const fn = createPipelineGateWaiter({ deliveryRouter: { notifyConversation: vi.fn() } });
    expect(fn.opts.id).toBe("pipeline-gate-waiter");
    expect(fn.opts.triggers).toEqual([pipelineGatePending]);
    expect(fn.opts.idempotency).toBe("event.data.gateKey");
    // Keyed on the gate, not the run — settling one gate must not cancel the
    // waiter of a later gate. And on settlement, not on the tap: a resolution
    // that fails to apply must leave the timeout armed.
    expect(fn.opts.cancelOn).toEqual([{ event: pipelineGateSettled, match: "data.gateKey" }]);
  });

  it.each([
    [{ kind: "proceed" } as const, 0, "timeout_proceed"],
    [{ kind: "abort" } as const, 0, "timeout_abort"],
    [{ kind: "remind", maxReminders: 3, finalAction: "abort" } as const, 3, "timeout_abort"],
    [{ kind: "remind", maxReminders: 1, finalAction: "proceed" } as const, 1, "timeout_proceed"],
  ])("maps %o to %i reminders then %s", (onTimeout, reminders, decision) => {
    expect(reminderCount(onTimeout)).toBe(reminders);
    expect(timeoutDecision(onTimeout)).toBe(decision);
  });

  it("reminds maxReminders times, then emits the final timeout decision", async () => {
    const notifyConversation = vi.fn().mockResolvedValue(undefined);
    const fn = createPipelineGateWaiter({ deliveryRouter: { notifyConversation } });
    const t = new InngestTestEngine({
      function: fn,
      events: [pendingEvent({ kind: "remind", maxReminders: 2, finalAction: "abort" })],
    });

    // Memoize every sleep as elapsed so the run continues past it.
    const { result, ctx } = await t.execute({
      steps: ["wait-1", "wait-2", "wait-3"].map((id) => ({ id, handler: () => null })),
    });

    expect(result).toEqual({ gateKey: "run-1:plan-gate:0", decision: "timeout_abort" });
    expect(notifyConversation).toHaveBeenCalledTimes(2);
    expect(notifyConversation).toHaveBeenLastCalledWith(
      "conv-1",
      expect.stringContaining('Reminder 2 of 2: pipeline "issue-to-pr"'),
    );
    expect(ctx.step.sleep).toHaveBeenCalledTimes(3);
    expect(ctx.step.sendEvent).toHaveBeenCalledWith(
      "emit-timeout-resolution",
      expect.objectContaining({
        name: "pipeline/gate.resolved",
        data: {
          runId: "run-1",
          gateKey: "run-1:plan-gate:0",
          conversationId: "conv-1",
          decision: "timeout_abort",
        },
      }),
    );
  });

  it("proceeds after a single sleep with no reminders", async () => {
    const notifyConversation = vi.fn();
    const fn = createPipelineGateWaiter({ deliveryRouter: { notifyConversation } });
    const t = new InngestTestEngine({ function: fn, events: [pendingEvent({ kind: "proceed" })] });

    const { result, ctx } = await t.execute({ steps: [{ id: "wait-1", handler: () => null }] });

    expect(result).toEqual({ gateKey: "run-1:plan-gate:0", decision: "timeout_proceed" });
    expect(notifyConversation).not.toHaveBeenCalled();
    expect(ctx.step.sleep).toHaveBeenCalledTimes(1);
    expect(ctx.step.sleep).toHaveBeenCalledWith("wait-1", "3600000ms");
  });
});
