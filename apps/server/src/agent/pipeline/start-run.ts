/**
 * Open a run of an activated pipeline in the conversation the user asked
 * from (design/pipelines.md → Execution Model). One transaction: resolve the
 * active version, refuse what this engine cannot execute, insert the run row
 * pinned to that version. Emitting the first `pipeline/stage.due` is the
 * caller's job — persist and emit stay separate steps so a retry after the
 * commit replays only the emit.
 *
 * The run lives in the triggering conversation: delivery already points
 * there, and gates read as part of the thread the user started. Cron
 * triggers have no triggering conversation and will reuse the scheduled-fire
 * dispatch instead.
 */

import type { Transactor } from "../../db/index.js";
import type { PipelineRunStore, PipelineStore } from "./store/index.js";
import type { PipelineDefinition, Stage } from "./types.js";

export interface StartPipelineRunDeps {
  runInTx: Transactor;
  store: Pick<PipelineStore, "getActiveDefinitionByName">;
  runStore: Pick<PipelineRunStore, "createRun" | "findActiveRunByConversation">;
}

export interface StartPipelineRunArgs {
  userId: string;
  conversationId: string;
  name: string;
}

export type StartPipelineRunResult =
  | {
      kind: "started";
      runId: string;
      pipelineName: string;
      version: number;
      firstStageId: string;
      stageCount: number;
    }
  | { kind: "no_active_version"; name: string }
  | { kind: "run_already_active"; runId: string; currentStage: string }
  | { kind: "unsupported_feature"; detail: string };

/**
 * Features a compiled definition may legally carry that this engine does not
 * execute yet. Checked at run start rather than at compile time: a definition
 * compiled today may be run by a newer engine, and refusing to *compile* them
 * would lose the user's intent. Failing here is loud and specific — far better
 * than silently running a loop as a straight line.
 */
function unsupported(definition: PipelineDefinition): string | null {
  const stage = definition.stages.find((s: Stage) => s.loop !== undefined);
  if (stage) {
    return `stage "${stage.id}" declares a loop, and loop back-edges are not executable yet`;
  }
  const waiting = definition.stages.find((s: Stage) => s.kind === "wait");
  if (waiting) {
    return `stage "${waiting.id}" waits on an external event, and no event sources are wired yet`;
  }
  const artifact = definition.stages.find(
    (s: Stage) => s.output?.kind === "plan" || s.output?.kind === "pr_metadata",
  );
  if (artifact) {
    return `stage "${artifact.id}" produces a ${artifact.output?.kind} artifact, which only a coding-delegation stage can produce`;
  }
  return null;
}

export async function startPipelineRun(
  deps: StartPipelineRunDeps,
  args: StartPipelineRunArgs,
): Promise<StartPipelineRunResult> {
  return deps.runInTx(async (tx) => {
    const definition = await deps.store.getActiveDefinitionByName(tx, args.userId, args.name);
    if (!definition) return { kind: "no_active_version" as const, name: args.name };

    const blocker = unsupported(definition.compiled);
    if (blocker !== null) return { kind: "unsupported_feature" as const, detail: blocker };

    // Checked before the insert so the caller gets a useful answer instead of
    // a 23505 from `uq_pipeline_runs_active_conversation`. The index is still
    // the authority — REPEATABLE READ does not predicate-lock, so two
    // concurrent starts in one conversation can both pass this read and the
    // loser surfaces the constraint violation.
    const active = await deps.runStore.findActiveRunByConversation(tx, args.conversationId);
    if (active) {
      return {
        kind: "run_already_active" as const,
        runId: active.id,
        currentStage: active.currentStage,
      };
    }

    const firstStage = definition.compiled.stages[0];
    if (!firstStage) {
      // Structurally impossible — `PipelineDefinitionSchema` requires at
      // least one stage — but the pinned blob is data, so this stays total.
      return { kind: "unsupported_feature" as const, detail: "the definition has no stages" };
    }

    const run = await deps.runStore.createRun(tx, {
      definitionId: definition.id,
      conversationId: args.conversationId,
      currentStage: firstStage.id,
    });

    return {
      kind: "started" as const,
      runId: run.id,
      pipelineName: definition.name,
      version: definition.version,
      firstStageId: firstStage.id,
      stageCount: definition.compiled.stages.length,
    };
  });
}
