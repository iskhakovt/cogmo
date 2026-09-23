/**
 * Put an agentic stage's instructions into the run's conversation as a
 * synthetic inbound — the same re-entry the scheduled-task fire handler
 * uses, so a stage turn is an ordinary turn with ordinary delivery,
 * streaming, history and compaction (design/pipelines.md → Execution Model).
 *
 * Idempotent on `${runId}:${stageId}:${iteration}`: a retry that lands after
 * the tx committed but before Inngest recorded the step reuses the row
 * instead of posting the instructions to the user a second time.
 */

import type { Transactor } from "../../db/index.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { PipelineStageContext } from "./load-stage-context.js";
import { buildAgenticStageInput } from "./stage-input.js";

export interface DispatchStageInboundDeps {
  runInTx: Transactor;
  transportStore: Pick<TransportStore, "persistInbound" | "findInboundByPipelineStageKey">;
}

export interface DispatchStageInboundArgs {
  context: PipelineStageContext;
  /** Revise feedback from a gate, when the run is re-entering this stage. */
  note?: string;
}

export function stageInboundKey(runId: string, stageId: string, iteration: number): string {
  return `${runId}:${stageId}:${iteration}`;
}

export async function dispatchStageInbound(
  deps: DispatchStageInboundDeps,
  args: DispatchStageInboundArgs,
): Promise<{ inboundId: string }> {
  const { context } = args;
  const key = stageInboundKey(context.runId, context.stageId, context.iteration);

  return deps.runInTx(async (tx) => {
    const existing = await deps.transportStore.findInboundByPipelineStageKey(tx, key);
    if (existing) return { inboundId: existing.id };

    const inbound = await deps.transportStore.persistInbound(tx, {
      source: "pipeline",
      pipelineStageKey: key,
      conversationId: context.conversationId,
      content: buildAgenticStageInput({
        pipelineName: context.pipelineName,
        stage: context.stage,
        stageIndex: context.stageIndex,
        stageCount: context.stageCount,
        stageOutputs: context.stageOutputs,
        priorStageIds: context.priorStageIds,
        ...(args.note !== undefined && { note: args.note }),
      }),
      platformTs: new Date(),
    });
    return { inboundId: inbound.id };
  });
}
