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
 * The winning flip records its claim on the run: the gate key and this
 * function run's Inngest id, which stays the same across its retries. A stale
 * outcome says whether that claim is this resolution's own. If it is, the
 * step re-ran after its commit and the first run may have died before its
 * follow-ups, so it re-sends the next stage and its notice — but only while
 * the run still sits exactly where its effect left it. If it isn't, another
 * resolution won and sent its own; this one stays silent, or, if it was a tap
 * whose decision didn't take, says so.
 *
 * If the resolution fails for good, `onFailure` first checks whether the run
 * is still parked on this gate. If it is, the resolution never committed: a
 * tap's waiter is still armed, so the user is told the decision didn't take
 * and the checkpoint will resolve on its timeout. Otherwise — a timeout, whose
 * waiter is gone, or a resolution that committed before a later step failed,
 * leaving no stage scheduled and possibly no waiter — nothing could ever move
 * the run again, so it is failed.
 */

import { inngest as inngestClient } from "../../inngest/client.js";
import {
  buildPipelineStageDueEvent,
  type PipelineGateDecision,
  pipelineGateKey,
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
  runStore: ResolveGateDeps["runStore"] & Pick<PipelineRunStore, "getRun" | "failRun">;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

type StaleOutcome = Extract<ResolveGateOutcome, { kind: "stale" }>;

function isTap(decision: PipelineGateDecision): boolean {
  return decision === "approved" || decision === "cancelled";
}

function isApproval(decision: PipelineGateDecision): boolean {
  return decision === "approved" || decision === "timeout_proceed";
}

/** The run's cursor is on the resolution's gate stage and iteration. */
function atGate(outcome: StaleOutcome): boolean {
  return outcome.currentStage === outcome.gateStage && outcome.iteration === outcome.gateIteration;
}

/**
 * Whether a stale resolution's decision already stands in the run: an
 * approval finds the run past the gate, a cancellation finds it cancelled at
 * this gate.
 */
function decisionReflected(decision: PipelineGateDecision, outcome: StaleOutcome): boolean {
  return isApproval(decision)
    ? outcome.pastGate
    : outcome.status === "cancelled" && atGate(outcome);
}

/**
 * The outcome this resolution produced, if the run still sits exactly where
 * it left it — cancelled or completed at the gate, or on the next stage at
 * the gate's iteration. Null once the run has moved on, or when the run's
 * claim isn't this resolution's: a notice or re-send then would describe
 * something this resolution didn't do.
 */
function effectInPlace(
  decision: PipelineGateDecision,
  outcome: StaleOutcome,
): ResolveGateOutcome | null {
  if (!outcome.appliedByThis) return null;
  const base = { conversationId: outcome.conversationId, pipelineName: outcome.pipelineName };
  if (!isApproval(decision)) {
    return decisionReflected(decision, outcome) ? { kind: "cancelled", ...base } : null;
  }
  if (outcome.nextStage === null) {
    return outcome.status === "completed" && atGate(outcome)
      ? { kind: "completed", ...base }
      : null;
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
 * message, and the next stage's own output follows.
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
    case "stale": {
      if (outcome.appliedByThis) {
        const effect = effectInPlace(decision, outcome);
        return effect === null ? null : gateNotice(decision, effect);
      }
      if (decisionReflected(decision, outcome)) return null;
      return timedOut ? null : TOO_LATE;
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
        const parked = await step.run("check-gate", async () => {
          const run = await deps.runInTx((tx) => deps.runStore.getRun(tx, runId));
          return (
            run?.status === "waiting_gate" &&
            pipelineGateKey(run.id, run.currentStage, run.iteration) === gateKey
          );
        });
        if (parked && isTap(decision)) {
          await notifyAfterRetries(
            step,
            "notify-tap-failed",
            deps.deliveryRouter,
            conversationId,
            "⚠️ Your decision at this checkpoint couldn't be applied. The checkpoint is still open and will resolve on its timeout.",
          );
          return;
        }
        const reason = parked
          ? `gate timeout could not be applied (${error.name})`
          : `gate resolution could not be completed (${error.name})`;
        const failed = await step.run("fail-run", () =>
          deps.runInTx((tx) => deps.runStore.failRun(tx, runId, reason)),
        );
        if (failed.kind === "failed") {
          await notifyAfterRetries(
            step,
            "notify-run-failed",
            deps.deliveryRouter,
            conversationId,
            "❌ A pipeline checkpoint couldn't be resolved, so the run has stopped.",
          );
        }
      },
    },
    async ({ event, step, runId: resolverRunId }) => {
      const { runId, gateKey, conversationId, decision } = event.data;
      const outcome = await step.run("resolve-gate", () =>
        resolveGate(deps, { runId, gateKey, decision, resolverRunId }),
      );

      if (outcome.kind !== "not_found") {
        await step.sendEvent("emit-gate-settled", pipelineGateSettled.create({ runId, gateKey }));
      }

      // The next stage is due when this resolution advanced the run, or when
      // its own claim, re-run after the commit, finds the run still running on
      // that stage — the first run of the step may have died before sending
      // it. Deduped on the run cursor. A run already parked there has had its
      // stage run.
      const due =
        outcome.kind !== "stale"
          ? outcome
          : outcome.status === "running"
            ? effectInPlace(decision, outcome)
            : null;
      if (due?.kind === "advanced") {
        await step.sendEvent(
          "emit-next-stage",
          buildPipelineStageDueEvent({ runId, stageId: due.nextStage, iteration: due.iteration }),
        );
      }

      const notice = gateNotice(decision, outcome);
      if (notice !== null) {
        await notifyAfterRetries(step, "notify", deps.deliveryRouter, conversationId, notice);
      }
      return outcome;
    },
  );
}
