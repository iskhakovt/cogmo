/**
 * Apply one gate resolution to a run parked at `waiting_gate`. The first
 * statement is the conditional `waiting_gate → running` flip under a row
 * lock, so a keyboard tap and a timeout racing for the same gate produce
 * exactly one winner; the loser reads `stale` and changes nothing. The flip
 * and the resulting advance / complete / cancel share one transaction, so a
 * crash cannot leave a run `running` on a gate stage with nothing scheduled.
 *
 * The resolution must name the gate the run is actually parked on
 * (`gateKey` against the row's current stage and iteration): a resolution
 * for an earlier gate of the same run, delivered late, is stale.
 */

import type { Transactor } from "../../db/index.js";
import { type PipelineGateDecision, pipelineGateKey } from "../../inngest/events.js";
import type { PipelineRunStore } from "./store/index.js";

export interface ResolveGateDeps {
  runInTx: Transactor;
  runStore: Pick<
    PipelineRunStore,
    | "getRunWithDefinition"
    | "transitionStatus"
    | "advanceStage"
    | "completeRun"
    | "cancelRunIfActive"
  >;
}

export interface ResolveGateArgs {
  runId: string;
  gateKey: string;
  decision: PipelineGateDecision;
}

/** Plain JSON — returned from a `step.run` and replayed from the step cache. */
export type ResolveGateOutcome =
  | {
      kind: "advanced";
      conversationId: string;
      pipelineName: string;
      nextStage: string;
      iteration: number;
    }
  | { kind: "completed"; conversationId: string; pipelineName: string }
  | { kind: "cancelled"; conversationId: string; pipelineName: string }
  | { kind: "stale" }
  | { kind: "not_found" };

export async function resolveGate(
  deps: ResolveGateDeps,
  args: ResolveGateArgs,
): Promise<ResolveGateOutcome> {
  return deps.runInTx(async (tx): Promise<ResolveGateOutcome> => {
    const loaded = await deps.runStore.getRunWithDefinition(tx, args.runId);
    if (!loaded) return { kind: "not_found" };
    const { run, definition } = loaded;
    if (pipelineGateKey(run.id, run.currentStage, run.iteration) !== args.gateKey) {
      return { kind: "stale" };
    }

    const claimed = await deps.runStore.transitionStatus(tx, run.id, "waiting_gate", "running");
    if (claimed.kind !== "transitioned") return { kind: "stale" };

    const base = { conversationId: run.conversationId, pipelineName: definition.name };

    if (args.decision === "cancelled" || args.decision === "timeout_abort") {
      const reason =
        args.decision === "cancelled"
          ? `cancelled by the user at gate "${run.currentStage}"`
          : `gate "${run.currentStage}" timed out`;
      await deps.runStore.cancelRunIfActive(tx, run.id, reason);
      return { kind: "cancelled", ...base };
    }

    const stages = definition.compiled.stages;
    const index = stages.findIndex((s) => s.id === run.currentStage);
    const next = index >= 0 ? stages[index + 1] : undefined;
    if (next === undefined) {
      await deps.runStore.completeRun(tx, {
        runId: run.id,
        fromStage: run.currentStage,
        output: null,
      });
      return { kind: "completed", ...base };
    }
    await deps.runStore.advanceStage(tx, {
      runId: run.id,
      fromStage: run.currentStage,
      output: null,
      toStage: next.id,
    });
    return { kind: "advanced", ...base, nextStage: next.id, iteration: run.iteration };
  });
}
