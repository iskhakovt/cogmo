/**
 * Inngest function for `pipeline/gate.resolved`: applies the resolution in
 * one step, then sends its follow-ups (`pipeline/gate.settled`, the next
 * stage, a notice), each in its own step. Per-run concurrency of one, so a
 * tap and a timeout for the same gate queue and the second reads `stale`.
 *
 * A stale outcome whose recorded claim is this function run's own is a re-run
 * after the commit: it re-sends what the first run may have lost, while the
 * run still sits where its effect left it. Otherwise another resolution won
 * and sent its own follow-ups; this one stays silent, except to tell a tap
 * its decision didn't take.
 *
 * `onFailure` inspects the run under the failed run's id. Still parked means
 * nothing committed: a tap is told the gate resolves on its timeout, and a
 * timeout, with no waiter left, fails the run. Moved on, it sends the
 * follow-ups the stale path would, so a failure never stops a moving run.
 */

import { inngest as inngestClient } from "../../inngest/client.js";
import {
  buildPipelineStageDueEvent,
  type PipelineGateDecision,
  pipelineGateResolved,
  pipelineGateSettled,
} from "../../inngest/events.js";
import type { StepSendEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import { type NoticeStep, notifyAfterRetries } from "./notify.js";
import {
  inspectGate,
  type ResolveGateDeps,
  type ResolveGateOutcome,
  resolveGate,
} from "./resolve-gate.js";
import type { PipelineRunStore } from "./store/index.js";

const log = logger.child({ component: "pipeline.gate-resolver" });

const TOO_LATE =
  "⌛ That decision arrived after the checkpoint had already been resolved, so it was not applied.";
const RUN_STOPPED = "⌛ That decision wasn't applied: the pipeline run has already stopped.";

export interface PipelineGateResolverDeps extends ResolveGateDeps {
  runStore: ResolveGateDeps["runStore"] & Pick<PipelineRunStore, "failRun">;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

type StaleOutcome = Extract<ResolveGateOutcome, { kind: "stale" }>;

interface GateResolution {
  runId: string;
  gateKey: string;
  conversationId: string;
  decision: PipelineGateDecision;
}

interface FollowUpStep extends NoticeStep {
  sendEvent: StepSendEvent;
}

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
      if (timedOut || decisionReflected(decision, outcome)) return null;
      return outcome.status === "failed" ? RUN_STOPPED : TOO_LATE;
    }
    case "not_found":
      return null;
  }
}

/**
 * Settle the gate's waiter, send the next stage when this resolution advanced
 * the run (or, as its own re-run, finds it still `running` there; deduped on
 * the run cursor), and deliver the notice.
 */
async function sendFollowUps(
  step: FollowUpStep,
  deliveryRouter: PipelineGateResolverDeps["deliveryRouter"],
  resolution: GateResolution,
  outcome: ResolveGateOutcome,
): Promise<void> {
  const { runId, gateKey, conversationId, decision } = resolution;
  if (outcome.kind !== "not_found") {
    await step.sendEvent("emit-gate-settled", pipelineGateSettled.create({ runId, gateKey }));
  }

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
    await notifyAfterRetries(step, "notify", deliveryRouter, conversationId, notice, {
      runId,
      gateKey,
    });
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
        const resolution = event.data.event.data;
        const { runId, gateKey, conversationId, decision } = resolution;
        log.error({ err: error, runId, gateKey, decision }, "gate resolution failed after retries");
        const inspection = await step.run("inspect-gate", () =>
          inspectGate(deps, { runId, gateKey, resolverRunId: event.data.run_id }),
        );

        if (inspection.kind !== "parked") {
          await sendFollowUps(step, deps.deliveryRouter, resolution, inspection);
          return;
        }
        if (isTap(decision)) {
          await notifyAfterRetries(
            step,
            "notify-tap-failed",
            deps.deliveryRouter,
            conversationId,
            "⚠️ Your decision at this checkpoint couldn't be applied. The checkpoint is still open and will resolve on its timeout.",
            { runId, gateKey },
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
            step,
            "notify-run-failed",
            deps.deliveryRouter,
            conversationId,
            "❌ A pipeline checkpoint's timeout couldn't be applied, so the run has stopped.",
            { runId, gateKey },
          );
        }
      },
    },
    async ({ event, step, runId: resolverRunId }) => {
      const resolution = event.data;
      const { runId, gateKey, decision } = resolution;
      const outcome = await step.run("resolve-gate", () =>
        resolveGate(deps, { runId, gateKey, decision, resolverRunId }),
      );
      await sendFollowUps(step, deps.deliveryRouter, resolution, outcome);
      return outcome;
    },
  );
}
