/**
 * Inngest function for `pipeline/gate.resolved`. Applies the resolution in
 * one durable step, then — only once that has committed — emits
 * `pipeline/gate.settled` (cancelling the gate's waiter) and the next stage,
 * each in its own step, and finally tells the run's conversation what
 * happened when nobody else already has.
 *
 * Per-run concurrency of one: a tap and a timeout for the same gate queue
 * behind each other, and the second reads `stale` from the conditional flip.
 *
 * If the resolution itself cannot be applied, `onFailure` handles the two
 * sources differently. A tap leaves the gate parked with its waiter still
 * armed (settlement never happened), so the user is told the decision didn't
 * take and the checkpoint will resolve on its timeout. A timeout has no
 * waiter behind it any more, so the run is failed rather than left parked
 * with nothing that could ever move it.
 */

import { inngest as inngestClient } from "../../inngest/client.js";
import {
  buildPipelineStageDueEvent,
  type PipelineGateDecision,
  pipelineGateResolved,
  pipelineGateSettled,
} from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import { type ResolveGateDeps, type ResolveGateOutcome, resolveGate } from "./resolve-gate.js";
import type { PipelineRunStore } from "./store/index.js";

const log = logger.child({ component: "pipeline.gate-resolver" });

export interface PipelineGateResolverDeps extends ResolveGateDeps {
  runStore: ResolveGateDeps["runStore"] & Pick<PipelineRunStore, "failRun">;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

function isTap(decision: PipelineGateDecision): boolean {
  return decision === "approved" || decision === "cancelled";
}

function isApproval(decision: PipelineGateDecision): boolean {
  return decision === "approved" || decision === "timeout_proceed";
}

/**
 * Whether a stale resolution's decision already stands in the run: an
 * approval finds the run past the gate, a cancellation finds it cancelled at
 * the gate. True for this step re-run after its own commit and for a
 * same-effect resolution that raced it; false only for one that lost.
 */
export function decisionReflected(
  decision: PipelineGateDecision,
  outcome: Extract<ResolveGateOutcome, { kind: "stale" }>,
): boolean {
  return isApproval(decision)
    ? outcome.pastGate
    : outcome.status === "cancelled" && outcome.currentStage === outcome.gateStage;
}

async function notifyBestEffort(
  deps: Pick<PipelineGateResolverDeps, "deliveryRouter">,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await deps.deliveryRouter.notifyConversation(conversationId, text);
  } catch (err) {
    log.warn({ err, conversationId }, "pipeline gate notice not delivered");
  }
}

/**
 * What the run's conversation hears about a resolution, or null. A tapped
 * approval that advances says nothing: the tap already rewrote the keyboard
 * message, and the next stage's own output follows. A tap whose decision
 * didn't take is told so, since its keyboard said "sent"; a stale resolution
 * whose effect already stands says nothing.
 */
export function gateNotice(
  decision: PipelineGateDecision,
  outcome: ResolveGateOutcome,
): string | null {
  const timedOut = !isTap(decision);
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
      return timedOut || decisionReflected(decision, outcome)
        ? null
        : "⌛ That decision arrived after the checkpoint had already been resolved, so it was not applied.";
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
      onFailure: async ({ event, error, step }) => {
        const { runId, gateKey, conversationId, decision } = event.data.event.data;
        log.error({ err: error, runId, gateKey, decision }, "gate resolution failed after retries");
        if (isTap(decision)) {
          await step.run("notify-tap-failed", () =>
            notifyBestEffort(
              deps,
              conversationId,
              "⚠️ Your decision at this checkpoint couldn't be applied. The checkpoint is still open and will resolve on its timeout.",
            ),
          );
          return;
        }
        const failed = await step.run("fail-run", () =>
          deps.runInTx((tx) =>
            deps.runStore.failRun(tx, runId, `gate timeout could not be applied (${error.name})`),
          ),
        );
        if (failed.kind === "failed") {
          await step.run("notify-timeout-failed", () =>
            notifyBestEffort(
              deps,
              conversationId,
              "❌ A pipeline checkpoint's timeout couldn't be applied, so the run has stopped.",
            ),
          );
        }
      },
    },
    async ({ event, step }) => {
      const { runId, gateKey, conversationId, decision } = event.data;
      const outcome = await step.run("resolve-gate", () =>
        resolveGate(deps, { runId, gateKey, decision }),
      );

      if (outcome.kind !== "not_found") {
        await step.sendEvent("emit-gate-settled", pipelineGateSettled.create({ runId, gateKey }));
      }

      // A stale approval whose effect already stands re-sends the next stage:
      // if this is the resolution's own retry, the first attempt died before
      // sending it. Deduped on the run cursor, so a raced same-effect
      // resolution that did send it makes this a no-op.
      if (
        outcome.kind === "stale" &&
        isApproval(decision) &&
        outcome.pastGate &&
        outcome.nextStage !== null &&
        outcome.status === "running" &&
        outcome.currentStage === outcome.nextStage
      ) {
        await step.sendEvent(
          "emit-next-stage",
          buildPipelineStageDueEvent({
            runId,
            stageId: outcome.nextStage,
            iteration: outcome.iteration,
          }),
        );
      }

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
      if (notice !== null) {
        await step.run("notify", () => notifyBestEffort(deps, conversationId, notice));
      }
      return outcome;
    },
  );
}
