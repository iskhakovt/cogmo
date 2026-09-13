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
 * A stale resolution is one of two things. On a first attempt it lost to
 * another resolution, which sent its own notice — so it stays silent, or, if
 * it was a tap whose decision didn't take, says so. On a retry it may be this
 * resolution's own step re-run after its commit, whose first attempt died
 * before notifying — so it sends the notice for its effect, but only while
 * the run still sits exactly where that effect left it.
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
import { notifyAfterRetries } from "./notify.js";
import { type ResolveGateDeps, type ResolveGateOutcome, resolveGate } from "./resolve-gate.js";
import type { PipelineRunStore } from "./store/index.js";

const log = logger.child({ component: "pipeline.gate-resolver" });

const TOO_LATE =
  "⌛ That decision arrived after the checkpoint had already been resolved, so it was not applied.";

export interface PipelineGateResolverDeps extends ResolveGateDeps {
  runStore: ResolveGateDeps["runStore"] & Pick<PipelineRunStore, "failRun">;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

type StaleOutcome = Extract<ResolveGateOutcome, { kind: "stale" }>;

function isTap(decision: PipelineGateDecision): boolean {
  return decision === "approved" || decision === "cancelled";
}

function isApproval(decision: PipelineGateDecision): boolean {
  return decision === "approved" || decision === "timeout_proceed";
}

/**
 * Whether a stale resolution's decision already stands in the run: an
 * approval finds the run past the gate, a cancellation finds it cancelled at
 * this gate's stage and iteration.
 */
export function decisionReflected(decision: PipelineGateDecision, outcome: StaleOutcome): boolean {
  return isApproval(decision)
    ? outcome.pastGate
    : outcome.status === "cancelled" &&
        outcome.currentStage === outcome.gateStage &&
        outcome.iteration === outcome.gateIteration;
}

/**
 * The outcome this decision produced, if the run still sits exactly where it
 * left it — cancelled or completed at the gate, or on the next stage at the
 * gate's iteration. Null once the run has moved on: a notice then would
 * describe something this resolution didn't do.
 */
function effectInPlace(
  decision: PipelineGateDecision,
  outcome: StaleOutcome,
): ResolveGateOutcome | null {
  const base = { conversationId: outcome.conversationId, pipelineName: outcome.pipelineName };
  const atGate =
    outcome.currentStage === outcome.gateStage && outcome.iteration === outcome.gateIteration;
  if (!isApproval(decision)) {
    return outcome.status === "cancelled" && atGate ? { kind: "cancelled", ...base } : null;
  }
  if (outcome.nextStage === null) {
    return outcome.status === "completed" && atGate ? { kind: "completed", ...base } : null;
  }
  const atNextStage =
    outcome.currentStage === outcome.nextStage &&
    outcome.iteration === outcome.gateIteration &&
    (outcome.status === "running" || outcome.status === "waiting_gate");
  return atNextStage
    ? { kind: "advanced", ...base, nextStage: outcome.nextStage, iteration: outcome.iteration }
    : null;
}

/**
 * What the run's conversation hears about a resolution, or null. A tapped
 * approval that advances says nothing: the tap already rewrote the keyboard
 * message, and the next stage's own output follows. `retried` is whether the
 * `resolve-gate` step ran on a retry attempt (see the module comment).
 */
export function gateNotice(
  decision: PipelineGateDecision,
  outcome: ResolveGateOutcome,
  retried: boolean,
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
    case "stale": {
      if (!decisionReflected(decision, outcome)) return timedOut ? null : TOO_LATE;
      if (!retried) return null;
      const effect = effectInPlace(decision, outcome);
      return effect === null ? null : gateNotice(decision, effect, retried);
    }
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
          await notifyAfterRetries(
            (id, body) => step.run(id, body),
            "notify-tap-failed",
            deps.deliveryRouter,
            conversationId,
            "⚠️ Your decision at this checkpoint couldn't be applied. The checkpoint is still open and will resolve on its timeout.",
          );
          return;
        }
        const failed = await step.run("fail-run", () =>
          deps.runInTx((tx) =>
            deps.runStore.failRun(tx, runId, `gate timeout could not be applied (${error.name})`),
          ),
        );
        if (failed.kind === "failed") {
          await notifyAfterRetries(
            (id, body) => step.run(id, body),
            "notify-timeout-failed",
            deps.deliveryRouter,
            conversationId,
            "❌ A pipeline checkpoint's timeout couldn't be applied, so the run has stopped.",
          );
        }
      },
    },
    async ({ event, step, attempt }) => {
      const { runId, gateKey, conversationId, decision } = event.data;
      // `retried` is captured inside the step, so it records the attempt that
      // actually ran the resolution and replays with its memoized result.
      const { outcome, retried } = await step.run("resolve-gate", async () => ({
        outcome: await resolveGate(deps, { runId, gateKey, decision }),
        retried: attempt > 0,
      }));

      if (outcome.kind !== "not_found") {
        await step.sendEvent("emit-gate-settled", pipelineGateSettled.create({ runId, gateKey }));
      }

      // A stale approval whose run sits on the next stage re-sends it: if this
      // is the resolution's own retry, the first attempt died before sending
      // it. Deduped on the run cursor, so when another resolution already sent
      // it this is a no-op.
      if (
        outcome.kind === "stale" &&
        isApproval(decision) &&
        outcome.pastGate &&
        outcome.nextStage !== null &&
        outcome.status === "running" &&
        outcome.currentStage === outcome.nextStage &&
        outcome.iteration === outcome.gateIteration
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

      const notice = gateNotice(decision, outcome, retried);
      if (notice !== null) {
        await notifyAfterRetries(
          (id, body) => step.run(id, body),
          "notify",
          deps.deliveryRouter,
          conversationId,
          notice,
        );
      }
      return outcome;
    },
  );
}
