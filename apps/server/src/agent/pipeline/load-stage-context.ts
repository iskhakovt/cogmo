/**
 * Resolve the stage a run currently sits on, joined with the pinned
 * definition that owns it.
 *
 * Two consumers key it differently: the stage runner has a run id from the
 * event, `handle-message` has only the conversation it is answering in. Both
 * want the same answer — "which stage is this, what may it touch, what has
 * been produced so far" — so it is one use case with two lookups rather than
 * two near-identical ones.
 *
 * The result is plain JSON (the stage comes out of the definition's compiled
 * blob) so callers can hold it across an Inngest step boundary.
 */

import type { Transactor } from "../../db/index.js";
import type { StepRun } from "../../inngest/index.js";
import type { StageOutputs } from "./run-types.js";
import type { PipelineRunStatus, PipelineRunStore, PipelineStore } from "./store/index.js";
import type { Stage } from "./types.js";

export interface LoadStageContextDeps {
  runInTx: Transactor;
  store: Pick<PipelineStore, "getDefinition">;
  runStore: Pick<PipelineRunStore, "getRun" | "findActiveRunByConversation">;
}

export type StageContextTarget =
  | { kind: "run"; runId: string }
  | { kind: "conversation"; conversationId: string };

export interface PipelineStageContext {
  runId: string;
  conversationId: string;
  status: PipelineRunStatus;
  /** Owner of the pinned definition — the identity every gate tap is checked against. */
  userId: string;
  pipelineName: string;
  definitionVersion: number;
  stage: Stage;
  stageId: string;
  iteration: number;
  stageIndex: number;
  stageCount: number;
  /** Stage ids before the current one, in definition order. */
  priorStageIds: readonly string[];
  /** Id of the stage after the current one; null when this is the last. */
  nextStageId: string | null;
  stageOutputs: StageOutputs;
}

/**
 * Returns `undefined` when there is no live run, and when a live run's
 * `current_stage` names a stage its pinned definition does not contain —
 * a corrupted cursor is not a stage context, and callers treat both as
 * "this is an ordinary turn".
 */
export async function loadPipelineStageContext(
  deps: LoadStageContextDeps,
  target: StageContextTarget,
): Promise<PipelineStageContext | undefined> {
  return deps.runInTx(async (tx) => {
    const run =
      target.kind === "run"
        ? await deps.runStore.getRun(tx, target.runId)
        : await deps.runStore.findActiveRunByConversation(tx, target.conversationId);
    if (!run) return undefined;

    const definition = await deps.store.getDefinition(tx, run.definitionId);
    if (!definition) return undefined;

    const stages = definition.compiled.stages;
    const stageIndex = stages.findIndex((s) => s.id === run.currentStage);
    const stage = stages[stageIndex];
    if (stage === undefined) return undefined;

    return {
      runId: run.id,
      conversationId: run.conversationId,
      status: run.status,
      userId: definition.userId,
      pipelineName: definition.name,
      definitionVersion: definition.version,
      stage,
      stageId: stage.id,
      iteration: run.iteration,
      stageIndex,
      stageCount: stages.length,
      priorStageIds: stages.slice(0, stageIndex).map((s) => s.id),
      nextStageId: stages[stageIndex + 1]?.id ?? null,
      stageOutputs: run.stageOutputs,
    };
  });
}

/**
 * `loadPipelineStageContext` behind a durable step, for the engine's
 * functions.
 *
 * The context gates which steps the rest of the invocation creates, so it
 * has to be memoized: reading it fresh in the bare body would let a stage
 * that moved mid-run (the `complete_stage` tool fires while the turn is
 * still streaming) produce a different step graph on replay, which is the
 * `Could not find step` failure mode. The `found` wrapper exists because
 * `undefined` does not survive a step boundary.
 */
export async function loadStageContextStep(
  deps: LoadStageContextDeps,
  stepRun: StepRun,
  target: StageContextTarget,
): Promise<PipelineStageContext | undefined> {
  const loaded = await stepRun("load-pipeline-stage", async () => {
    const context = await loadPipelineStageContext(deps, target);
    return context === undefined ? { found: false as const } : { found: true as const, context };
  });
  return loaded.found ? loaded.context : undefined;
}
