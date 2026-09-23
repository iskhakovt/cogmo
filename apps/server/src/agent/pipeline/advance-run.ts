/**
 * Move a run off the stage it is sitting on: record the stage's artifact and
 * either hand the cursor to the next stage or complete the run.
 *
 * Shared by the two things that end a stage — an agentic stage's
 * `complete_stage` call and a gate's approval — so "what happens when a
 * stage finishes" has one implementation and one idempotency story. Emitting
 * the follow-on event stays with the callers: persist and emit are separate
 * steps, so a retry after the commit replays only the emit.
 */

import type { Transactor } from "../../db/index.js";
import { pipelineRunFinished, pipelineStageDue } from "../../inngest/events.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { PipelineStageContext } from "./load-stage-context.js";
import type { StageArtifact } from "./run-types.js";
import type { PipelineRunStore } from "./store/index.js";

export interface AdvanceRunDeps {
  runInTx: Transactor;
  runStore: Pick<PipelineRunStore, "advanceStage" | "completeRun">;
}

export type AdvanceRunResult =
  | { kind: "advanced"; toStage: string; toIteration: number }
  | { kind: "completed" }
  | { kind: "stale" }
  | { kind: "not_found" };

/**
 * `iteration` carries forward unchanged on a forward move: it is the run's
 * pass counter, bumped only when the run goes *backwards* (a gate's revise
 * today, loop back-edges in slice 3). Keeping it monotonic is what makes the
 * per-entry idempotency keys — the synthetic inbound's, the gate event's —
 * distinct on a second visit to the same stage.
 */
export async function advanceRun(
  deps: AdvanceRunDeps,
  args: { context: PipelineStageContext; artifact: StageArtifact | null },
): Promise<AdvanceRunResult> {
  const { context } = args;
  const at = {
    runId: context.runId,
    fromStage: context.stageId,
    fromIteration: context.iteration,
    output: args.artifact,
  };

  if (context.nextStageId === null) {
    const result = await deps.runInTx((tx) => deps.runStore.completeRun(tx, at));
    return result.kind === "advanced" ? { kind: "completed" as const } : { kind: result.kind };
  }

  const toStage = context.nextStageId;
  const result = await deps.runInTx((tx) =>
    deps.runStore.advanceStage(tx, { ...at, toStage, toIteration: context.iteration }),
  );
  return result.kind === "advanced"
    ? { kind: "advanced" as const, toStage, toIteration: context.iteration }
    : { kind: result.kind };
}

/**
 * What follows a successful move: hand the next stage to the runner, or tell
 * the user the run is done. Shared by the two things that end a stage — an
 * agentic stage's `complete_stage` and a gate's approval — so the emitted ids,
 * the completion notice and the terminal event cannot drift between them.
 *
 * Kept out of {@link advanceRun} because that runs inside a `step.run`: the
 * persist and the emit stay separate steps, so a retry after the commit
 * replays only the emit.
 */
export async function emitAdvanceFollowUp(
  deps: { deliveryRouter: Pick<DeliveryRouter, "notifyConversation"> },
  args: { context: PipelineStageContext; moved: AdvanceRunResult },
  stepRun: StepRun,
  stepSendEvent: StepSendEvent,
): Promise<
  | { status: "advanced"; toStage: string }
  | { status: "completed" }
  | { status: "skipped"; reason: string }
> {
  const { context, moved } = args;
  if (moved.kind === "advanced") {
    await stepSendEvent("emit-next-stage-due", {
      ...pipelineStageDue.create({
        runId: context.runId,
        stageId: moved.toStage,
        iteration: moved.toIteration,
      }),
      id: `pipeline-stage-due-${context.runId}:${moved.toStage}:${moved.toIteration}`,
    });
    return { status: "advanced", toStage: moved.toStage };
  }

  if (moved.kind === "completed") {
    await stepRun("notify-run-complete", () =>
      deps.deliveryRouter.notifyConversation(
        context.conversationId,
        `✅ The "${context.pipelineName}" pipeline finished.`,
      ),
    );
    await stepSendEvent("emit-run-finished", {
      ...pipelineRunFinished.create({
        runId: context.runId,
        pipelineName: context.pipelineName,
        status: "completed",
      }),
      id: `pipeline-run-finished-${context.runId}`,
    });
    return { status: "completed" };
  }

  return { status: "skipped", reason: moved.kind };
}
