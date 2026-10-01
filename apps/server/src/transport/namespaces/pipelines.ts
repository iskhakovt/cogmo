import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import { gateToken } from "../../agent/pipeline/gate-keyboard.js";
import type { PipelineRunStore } from "../../agent/pipeline/store/index.js";
import { pipelineGateKey, pipelineGateResolved } from "../../inngest/events.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * Pipeline gate checkpoints — the Approve / Cancel keyboard on a run parked
 * at `waiting_gate`. Identity-checked against the owner of the run's pinned
 * definition. Returns `pipelines_disabled` when no run store is wired.
 */
export interface PipelinesNamespace {
  /**
   * Emit `pipeline/gate.resolved` if `gateToken` names the gate the run is
   * parked on, so a leftover button from an earlier gate is refused. The
   * tapper is identified before the run is looked up, so an unknown tapper
   * learns nothing about which runs exist. The status check is advisory;
   * the resolver's conditional flip decides races.
   */
  resolveGate(
    runId: string,
    gateToken: string,
    action: "approve" | "cancel",
    tapperPlatformHandle: string,
  ): Promise<Result<{ runId: string; pipelineName: string; stageId: string }, TransportError>>;
}

export function createPipelines(
  deps: Omit<TransportContext, "agentStore"> & {
    inngest: Inngest;
    pipelineRunStore: PipelineRunStore | undefined;
  },
): PipelinesNamespace {
  const { channelId, runInTx, transportStore, inngest, pipelineRunStore } = deps;
  return {
    async resolveGate(runId, token, action, tapperPlatformHandle) {
      if (!pipelineRunStore) return err({ code: "pipelines_disabled" as const });
      const checked = await runInTx(async (tx) => {
        const tapper = await transportStore.resolveUser(tx, channelId, tapperPlatformHandle);
        if (!tapper) return err({ code: "identity_rejected" as const });
        const loaded = await pipelineRunStore.getRunWithDefinition(tx, runId);
        if (!loaded) return err({ code: "pipeline_run_not_found" as const, runId });
        const { run, definition } = loaded;
        if (tapper.userId !== definition.userId) {
          return err({ code: "identity_rejected" as const });
        }
        const gateKey = pipelineGateKey(run.id, run.currentStage, run.iteration);
        if (run.status !== "waiting_gate" || gateToken(gateKey) !== token) {
          return err({ code: "pipeline_gate_not_pending" as const, runId, status: run.status });
        }
        return ok({
          gateKey,
          conversationId: run.conversationId,
          pipelineName: definition.name,
          stageId: run.currentStage,
        });
      });
      if (checked.isErr()) return err(checked.error);
      const { gateKey, conversationId, pipelineName, stageId } = checked.value;
      await inngest.send(
        pipelineGateResolved.create({
          runId,
          gateKey,
          conversationId,
          decision: action === "approve" ? "approved" : "cancelled",
        }),
      );
      return ok({ runId, pipelineName, stageId });
    },
  };
}
