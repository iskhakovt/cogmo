/**
 * Inngest function for `pipeline/gate.resolved`. Applies the resolution in
 * one durable step, emits the next stage in a separate step (a retry after
 * the commit replays only the emit), then tells the run's conversation what
 * happened when nobody else already has.
 *
 * Per-run concurrency of one: a tap and a timeout for the same gate queue
 * behind each other, and the second reads `stale` from the conditional flip.
 */

import { inngest as inngestClient } from "../../inngest/client.js";
import {
  buildPipelineStageDueEvent,
  type PipelineGateDecision,
  pipelineGateResolved,
} from "../../inngest/events.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import { type ResolveGateDeps, type ResolveGateOutcome, resolveGate } from "./resolve-gate.js";

export interface PipelineGateResolverDeps extends ResolveGateDeps {
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

/**
 * What the run's conversation hears about a resolution, or null. A tapped
 * approval that advances says nothing: the tap already rewrote the keyboard
 * message, and the next stage's own output follows. A tap that loses the race
 * gets its answer from the transport, not here.
 */
export function gateNotice(
  decision: PipelineGateDecision,
  outcome: ResolveGateOutcome,
): string | null {
  const timedOut = decision === "timeout_proceed" || decision === "timeout_abort";
  switch (outcome.kind) {
    case "advanced":
      return timedOut
        ? `⏱ Checkpoint timed out — pipeline "${outcome.pipelineName}" is proceeding to "${outcome.nextStage}".`
        : null;
    case "completed":
      return timedOut
        ? `⏱ Checkpoint timed out — pipeline "${outcome.pipelineName}" completed.`
        : `✅ Pipeline "${outcome.pipelineName}" completed.`;
    case "cancelled":
      return timedOut
        ? `⏱ Checkpoint timed out — pipeline "${outcome.pipelineName}" was cancelled.`
        : `❌ Pipeline "${outcome.pipelineName}" cancelled.`;
    case "stale":
    case "not_found":
      return null;
  }
}

export function createPipelineGateResolver(deps: PipelineGateResolverDeps) {
  return inngestClient.createFunction(
    {
      id: "pipeline-gate-resolver",
      triggers: [pipelineGateResolved],
      retries: 2,
      concurrency: { limit: 1, key: "event.data.runId" },
    },
    async ({ event, step }) => {
      const { runId, decision } = event.data;
      const outcome = await step.run("resolve-gate", () => resolveGate(deps, event.data));

      if (outcome.kind === "advanced") {
        await step.sendEvent(
          "emit-next-stage",
          buildPipelineStageDueEvent({
            runId,
            stageId: outcome.nextStage,
            iteration: outcome.iteration,
          }),
        );
      }

      const notice = gateNotice(decision, outcome);
      if (notice !== null && outcome.kind !== "stale" && outcome.kind !== "not_found") {
        const { conversationId } = outcome;
        await step.run("notify", () =>
          deps.deliveryRouter.notifyConversation(conversationId, notice),
        );
      }
      return outcome;
    },
  );
}
