/**
 * `pipeline-stage-advance` — the transition half of a stage.
 *
 * Triggered by `pipeline/stage.completed`, which the per-turn
 * `complete_stage` tool emits. Persists the artifact and moves the cursor in
 * one transaction, then emits the next `pipeline/stage.due` — or, on the
 * last stage, tells the user the run is done. The split between the persist
 * step and the emit step is deliberate: a retry after the commit replays
 * only the emit, never the transition.
 */

import type { Inngest } from "inngest";
import type { z } from "zod";
import type { Transactor } from "../../db/index.js";
import { pipelineStageCompleted } from "../../inngest/events.js";
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

const log = logger.child({ component: "pipeline.stage-advance" });

export interface PipelineStageAdvanceDeps {
  runInTx: Transactor;
  store: PipelineStore;
  runStore: PipelineRunStore;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

export type PipelineStageCompletedData = z.infer<typeof pipelineStageCompleted.schema>;

export type PipelineStageAdvanceResult =
  | { status: "advanced"; toStage: string }
  | { status: "completed" }
  | { status: "skipped"; reason: string };

/**
 * Function body, extracted so tests drive it with step shims instead of an
 * Inngest runtime.
 */
export async function advancePipelineStage(
  deps: PipelineStageAdvanceDeps,
  event: PipelineStageCompletedData,
  stepRun: StepRun,
  stepSendEvent: StepSendEvent,
): Promise<PipelineStageAdvanceResult> {
  const { runId, stageId, iteration, artifact } = event;

  const context = await loadStageContextStep(deps, stepRun, { kind: "run", runId });
  if (context === undefined) {
    log.warn({ runId, stageId }, "stage completion for an unknown run or stage");
    return { status: "skipped" as const, reason: "no_stage_context" };
  }

  if (
    context.stageId !== stageId ||
    context.iteration !== iteration ||
    isTerminalPipelineRunStatus(context.status)
  ) {
    // The model called `complete_stage` for a stage the run has already
    // left — a redelivery, or a gate that cancelled the run while the
    // turn was still streaming.
    log.info(
      { runId, stageId, iteration, at: context.stageId, status: context.status },
      "stage completion no longer matches the run cursor",
    );
    return { status: "skipped" as const, reason: "stale_cursor" };
  }

  const moved = await stepRun("persist-advance", () => advanceRun(deps, { context, artifact }));
  return emitAdvanceFollowUp(deps, { context, moved }, stepRun, stepSendEvent);
}

export function createPipelineStageAdvance(deps: PipelineStageAdvanceDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "pipeline-stage-advance",
      retries: 2,
      concurrency: { limit: 1, key: "event.data.runId" },
      triggers: [pipelineStageCompleted],
    },
    async ({ event, step }) => advancePipelineStage(deps, event.data, step.run, step.sendEvent),
  );
}
