/**
 * Inngest function: sleeps out a gate checkpoint's timeout and resolves it
 * with the envelope's `onTimeout` action. Cancelled by
 * `pipeline/gate.settled` on the same `gateKey` — emitted only once a
 * resolution has committed, so a tap whose resolution fails leaves this
 * timeout armed.
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
  pipelineGateSettled,
} from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";

const log = logger.child({ component: "pipeline.gate-waiter" });

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
      cancelOn: [{ event: pipelineGateSettled, match: "data.gateKey" }],
    },
    async ({ event, step }) => {
      const { runId, gateKey, conversationId, pipelineName, stageId, timeoutMs, onTimeout } =
        event.data;
      const reminders = reminderCount(onTimeout);

      for (let i = 1; i <= reminders; i++) {
        await step.sleep(`wait-${i}`, `${timeoutMs}ms`);
        // A reminder is a courtesy: a delivery failure must not fail the
        // waiter, or the gate would never reach its timeout action.
        await step.run(`remind-${i}`, async () => {
          try {
            await deps.deliveryRouter.notifyConversation(
              conversationId,
              `⏳ Reminder ${i} of ${reminders}: pipeline "${pipelineName}" is waiting for your decision at stage "${stageId}".`,
            );
          } catch (err) {
            log.warn({ err, runId, gateKey, reminder: i }, "gate reminder not delivered");
          }
        });
      }
      await step.sleep(`wait-${reminders + 1}`, `${timeoutMs}ms`);

      const decision = timeoutDecision(onTimeout);
      await step.sendEvent(
        "emit-timeout-resolution",
        pipelineGateResolved.create({ runId, gateKey, conversationId, decision }),
      );
      return { gateKey, decision };
    },
  );
}
