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
 *
 * A stale outcome reports where the run actually is. From that the caller can
 * tell a resolution whose effect already stands — the same step re-run after
 * its commit, or a same-effect resolution that raced it — from one that
 * genuinely lost.
 */

import type { Transactor } from "../../db/index.js";
import {
  type PipelineGateDecision,
  parsePipelineGateKey,
  pipelineGateKey,
} from "../../inngest/events.js";
import type {
  PipelineRunRow,
  PipelineRunStatus,
  PipelineRunStore,
  PipelineRunWithDefinition,
} from "./store/index.js";

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
  | {
      kind: "stale";
      status: PipelineRunStatus;
      currentStage: string;
      iteration: number;
      /** The stage the resolution's gate key names. */
      gateStage: string;
      /** The stage after that gate, or null when the gate is the last stage. */
      nextStage: string | null;
      /** The run has moved forward past the gate: onto a later stage, or completed at it. */
      pastGate: boolean;
    }
  | { kind: "not_found" };

function staleOutcome(
  run: PipelineRunRow,
  definition: PipelineRunWithDefinition["definition"],
  gateKey: string,
): ResolveGateOutcome {
  const gate = parsePipelineGateKey(gateKey);
  const stages = definition.compiled.stages;
  const gateIndex = stages.findIndex((s) => s.id === gate.stageId);
  const currentIndex = stages.findIndex((s) => s.id === run.currentStage);
  const pastGate =
    gateIndex >= 0 &&
    (run.status === "completed"
      ? currentIndex >= gateIndex
      : run.status !== "cancelled" &&
        run.status !== "failed" &&
        run.iteration === gate.iteration &&
        currentIndex > gateIndex);
  return {
    kind: "stale",
    status: run.status,
    currentStage: run.currentStage,
    iteration: run.iteration,
    gateStage: gate.stageId,
    nextStage: gateIndex >= 0 ? (stages[gateIndex + 1]?.id ?? null) : null,
    pastGate,
  };
}

export async function resolveGate(
  deps: ResolveGateDeps,
  args: ResolveGateArgs,
): Promise<ResolveGateOutcome> {
  return deps.runInTx(async (tx): Promise<ResolveGateOutcome> => {
    const loaded = await deps.runStore.getRunWithDefinition(tx, args.runId);
    if (!loaded) return { kind: "not_found" };
    const { run, definition } = loaded;
    if (pipelineGateKey(run.id, run.currentStage, run.iteration) !== args.gateKey) {
      return staleOutcome(run, definition, args.gateKey);
    }

    const claimed = await deps.runStore.transitionStatus(tx, run.id, "waiting_gate", "running");
    if (claimed.kind !== "transitioned") return staleOutcome(run, definition, args.gateKey);

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
