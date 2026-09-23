/**
 * `pipeline-gate-resolve` — applies the user's decision at a gate.
 *
 * The decision arrives as an event from `Transport.pipelines.resolveGate`
 * (inline-keyboard tap or `/gate` command), which is where identity is
 * checked. No model sits between the user's words and the transition: a
 * gate is the one point in a run where the engine is required to do exactly
 * what the human said.
 *
 * - `approve` moves the run on, exactly like an agentic stage completing.
 * - `revise` sends it back to the stage before the gate, at the next
 *   iteration, carrying the feedback as that stage's note.
 * - `cancel` terminates the run.
 */

import type { Inngest } from "inngest";
import { match } from "ts-pattern";
import type { z } from "zod";
import type { Transactor } from "../../db/index.js";
import {
  pipelineGateRequested,
  pipelineGateResolved,
  pipelineRunFinished,
  pipelineStageDue,
} from "../../inngest/events.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import { advanceRun, emitAdvanceFollowUp } from "./advance-run.js";
import { loadStageContextStep } from "./load-stage-context.js";
import {
  isTerminalPipelineRunStatus,
  type PipelineRunStore,
  type PipelineStore,
} from "./store/index.js";

const log = logger.child({ component: "pipeline.gate-resolve" });

export interface PipelineGateResolveDeps {
  runInTx: Transactor;
  store: PipelineStore;
  runStore: PipelineRunStore;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

export type PipelineGateResolvedData = z.infer<typeof pipelineGateResolved.schema>;

export type PipelineGateResolveResult =
  | { status: "approved"; toStage: string }
  | { status: "revising"; toStage: string }
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "skipped"; reason: string };

/**
 * Function body, extracted so tests drive it with step shims instead of an
 * Inngest runtime.
 */
export async function resolvePipelineGate(
  deps: PipelineGateResolveDeps,
  event: PipelineGateResolvedData,
  stepRun: StepRun,
  stepSendEvent: StepSendEvent,
): Promise<PipelineGateResolveResult> {
  const { runId, stageId, iteration, decision, feedback } = event;

  const context = await loadStageContextStep(deps, stepRun, { kind: "run", runId });
  if (context === undefined) {
    log.warn({ runId, stageId }, "gate resolution for an unknown run or stage");
    return { status: "skipped" as const, reason: "no_stage_context" };
  }

  if (
    context.stageId !== stageId ||
    context.iteration !== iteration ||
    isTerminalPipelineRunStatus(context.status) ||
    context.status !== "waiting_gate"
  ) {
    log.info(
      { runId, stageId, iteration, at: context.stageId, status: context.status },
      "gate resolution no longer matches a parked gate",
    );
    return { status: "skipped" as const, reason: "stale_cursor" };
  }

  return match(decision)
    .with("approve", async () => {
      const moved = await stepRun("persist-approval", () =>
        advanceRun(deps, { context, artifact: null }),
      );
      const followUp = await emitAdvanceFollowUp(deps, { context, moved }, stepRun, stepSendEvent);
      return followUp.status === "advanced"
        ? { status: "approved" as const, toStage: followUp.toStage }
        : followUp;
    })
    .with("revise", async () => {
      const backTo = context.priorStageIds.at(-1);
      if (backTo === undefined) {
        // A gate with nothing before it has nothing to send back. The run
        // stays parked — but the channel that rendered the keyboard tore it
        // down when the tap was accepted at the transport, before this ran,
        // so re-request one alongside the explanation rather than leaving
        // `/gate` as the user's only remaining route.
        await stepRun("notify-nothing-to-revise", () =>
          deps.deliveryRouter.notifyConversation(
            context.conversationId,
            `"${context.pipelineName}" starts at this gate, so there is no earlier stage to revise. Approve or cancel it instead.`,
          ),
        );
        await stepSendEvent("re-request-gate-keyboard", {
          ...pipelineGateRequested.create({
            runId,
            stageId,
            iteration,
            conversationId: context.conversationId,
            pipelineName: context.pipelineName,
          }),
          // Distinct from the runner's own request for this cursor, so the
          // bus dedup doesn't swallow the replacement keyboard.
          id: `pipeline-gate-requested-${runId}:${stageId}:${iteration}:revise-refused`,
        });
        return { status: "skipped" as const, reason: "no_stage_to_revise" };
      }

      const toIteration = context.iteration + 1;
      const moved = await stepRun("persist-revise", () =>
        deps.runInTx((tx) =>
          deps.runStore.advanceStage(tx, {
            runId,
            fromStage: stageId,
            fromIteration: iteration,
            output: null,
            toStage: backTo,
            toIteration,
          }),
        ),
      );
      if (moved.kind !== "advanced") {
        return { status: "skipped" as const, reason: moved.kind };
      }
      await stepSendEvent("emit-revise-stage-due", {
        ...pipelineStageDue.create({
          runId,
          stageId: backTo,
          iteration: toIteration,
          ...(feedback !== undefined && { note: feedback }),
        }),
        id: `pipeline-stage-due-${runId}:${backTo}:${toIteration}`,
      });
      return { status: "revising" as const, toStage: backTo };
    })
    .with("cancel", async () => {
      const cancelled = await stepRun("persist-cancel", () =>
        deps.runInTx((tx) =>
          deps.runStore.cancelRunIfActive(tx, runId, "cancelled by the user at a gate"),
        ),
      );
      if (cancelled.kind !== "cancelled") {
        return { status: "skipped" as const, reason: cancelled.kind };
      }
      await stepRun("notify-cancelled", () =>
        deps.deliveryRouter.notifyConversation(
          context.conversationId,
          `🛑 The "${context.pipelineName}" pipeline was cancelled.`,
        ),
      );
      await stepSendEvent("emit-run-finished", {
        ...pipelineRunFinished.create({
          runId,
          pipelineName: context.pipelineName,
          status: "cancelled",
        }),
        id: `pipeline-run-finished-${runId}`,
      });
      return { status: "cancelled" as const };
    })
    .exhaustive();
}

export function createPipelineGateResolve(deps: PipelineGateResolveDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "pipeline-gate-resolve",
      retries: 2,
      concurrency: { limit: 1, key: "event.data.runId" },
      triggers: [pipelineGateResolved],
    },
    async ({ event, step }) => resolvePipelineGate(deps, event.data, step.run, step.sendEvent),
  );
}
