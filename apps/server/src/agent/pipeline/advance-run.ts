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
