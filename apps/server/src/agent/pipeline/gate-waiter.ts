/**
 * Inngest function: sleeps out a gate checkpoint's timeout and resolves it
 * with the envelope's `onTimeout` action. Cancelled by `pipeline/gate.resolved`
 * on the same `gateKey` — a keyboard tap that lands first wakes nothing.
 *
 * `remind` sleeps one full timeout per reminder, nudges the run's
 * conversation, and after the last reminder sleeps once more before applying
 * `finalAction` — so a gate waits `timeout × (maxReminders + 1)` in total,
 * the same bound the compiler's one-year park ceiling is checked against.
 *
 * The number of steps comes from the event payload alone, so every replay
 * plans the same sequence. The timeout resolution is emitted, not applied:
 * `pipeline-gate-resolver` owns the `waiting_gate` transition for taps and
 * timeouts alike, which is what lets it pick a winner when both land.
 */

import { inngest as inngestClient } from "../../inngest/client.js";
import {
  type PipelineGateDecision,
  type PipelineGatePendingData,
  pipelineGatePending,
  pipelineGateResolved,
} from "../../inngest/events.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";

export interface PipelineGateWaiterDeps {
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

export function reminderCount(onTimeout: PipelineGatePendingData["onTimeout"]): number {
  return onTimeout.kind === "remind" ? onTimeout.maxReminders : 0;
}

export function timeoutDecision(
  onTimeout: PipelineGatePendingData["onTimeout"],
): PipelineGateDecision {
  const action = onTimeout.kind === "remind" ? onTimeout.finalAction : onTimeout.kind;
  return action === "proceed" ? "timeout_proceed" : "timeout_abort";
}

export function createPipelineGateWaiter(deps: PipelineGateWaiterDeps) {
  return inngestClient.createFunction(
    {
      id: "pipeline-gate-waiter",
      triggers: [pipelineGatePending],
      idempotency: "event.data.gateKey",
      cancelOn: [{ event: pipelineGateResolved, match: "data.gateKey" }],
    },
    async ({ event, step }) => {
      const { runId, gateKey, conversationId, pipelineName, stageId, timeoutMs, onTimeout } =
        event.data;
      const reminders = reminderCount(onTimeout);

      for (let i = 1; i <= reminders; i++) {
        await step.sleep(`wait-${i}`, `${timeoutMs}ms`);
        await step.run(`remind-${i}`, () =>
          deps.deliveryRouter.notifyConversation(
            conversationId,
            `⏳ Reminder ${i} of ${reminders}: pipeline "${pipelineName}" is waiting for your decision at stage "${stageId}".`,
          ),
        );
      }
      await step.sleep(`wait-${reminders + 1}`, `${timeoutMs}ms`);

      const decision = timeoutDecision(onTimeout);
      await step.sendEvent(
        "emit-timeout-resolution",
        pipelineGateResolved.create({ runId, gateKey, decision }),
      );
      return { gateKey, decision };
    },
  );
}
