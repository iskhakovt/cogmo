/**
 * Apply one gate resolution to a run parked at `waiting_gate`. The first
 * statement is a conditional `waiting_gate → running` flip under a row lock,
 * so a tap and a timeout racing for one gate produce exactly one winner. The
 * flip records the claim (gate key + resolving Inngest run) and shares a
 * transaction with the resulting advance, completion or cancellation.
 *
 * A resolution for any gate but the one the run is parked on is stale. A
 * stale outcome reports where the run is and whether its recorded claim is
 * this resolution's. `inspectFailedResolution` reads the same for a
 * resolution that failed, failing a still-parked run in the same transaction.
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
    "getRunWithDefinition" | "claimGate" | "advanceStage" | "completeRun" | "cancelRunIfActive"
  >;
}

export interface ResolveGateArgs {
  runId: string;
  gateKey: string;
  decision: PipelineGateDecision;
  /** The Inngest function run applying this resolution — stable across its retries. */
  resolverRunId: string;
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
      conversationId: string;
      pipelineName: string;
      status: PipelineRunStatus;
      currentStage: string;
      iteration: number;
      /** The stage and iteration the resolution's gate key names. */
      gateStage: string;
      gateIteration: number;
      /** The stage after that gate, or null when the gate is the last stage. */
      nextStage: string | null;
      /**
       * The run's cursor has moved forward past the gate — onto a later stage
       * (whatever became of the run there), or completed at it.
       */
      pastGate: boolean;
      /** The run's recorded gate claim is this resolution's — same gate, same resolver run. */
      appliedByThis: boolean;
    }
  | { kind: "not_found" };

type StaleOutcome = Extract<ResolveGateOutcome, { kind: "stale" }>;

/** Who is asking about a gate: the gate key and the resolving Inngest function run. */
export type GateClaimArgs = Omit<ResolveGateArgs, "decision">;

/** Where a run stands after a resolution failed for good, as read by {@link inspectFailedResolution}. */
export type FailedResolutionInspection =
  | { kind: "parked" }
  | { kind: "failed"; conversationId: string }
  | StaleOutcome
  | { kind: "not_found" };

function staleOutcome(
  run: PipelineRunRow,
  definition: PipelineRunWithDefinition["definition"],
  args: GateClaimArgs,
): StaleOutcome {
  const gate = parsePipelineGateKey(args.gateKey);
  const stages = definition.compiled.stages;
  const gateIndex = stages.findIndex((s) => s.id === gate.stageId);
  const currentIndex = stages.findIndex((s) => s.id === run.currentStage);
  // Judged by the cursor, not the status: a run that failed or was cancelled
  // on a later stage still had this gate's approval applied.
  const pastGate =
    gateIndex >= 0 &&
    run.iteration === gate.iteration &&
    (run.status === "completed" ? currentIndex >= gateIndex : currentIndex > gateIndex);
  return {
    kind: "stale",
    conversationId: run.conversationId,
    pipelineName: definition.name,
    status: run.status,
    currentStage: run.currentStage,
    iteration: run.iteration,
    gateStage: gate.stageId,
    gateIteration: gate.iteration,
    nextStage: gateIndex >= 0 ? (stages[gateIndex + 1]?.id ?? null) : null,
    pastGate,
    appliedByThis:
      run.gateResolution?.gateKey === args.gateKey &&
      run.gateResolution.resolverRunId === args.resolverRunId,
  };
}

/**
 * Read where the run stands relative to a failed resolution's gate. A run
 * still parked there is failed with `failParkedRunWith` when one is given, in
 * the same transaction as the check: a resolution that claims the gate
 * concurrently then forces a serialization retry instead of losing its run.
 * A run that moved on reports the stale outcome, including whether the
 * recorded claim is `resolverRunId`'s.
 */
export async function inspectFailedResolution(
  deps: Pick<ResolveGateDeps, "runInTx"> & {
    runStore: Pick<PipelineRunStore, "getRunWithDefinition" | "failRun">;
  },
  args: GateClaimArgs & { failParkedRunWith: string | null },
): Promise<FailedResolutionInspection> {
  return deps.runInTx(async (tx): Promise<FailedResolutionInspection> => {
    const loaded = await deps.runStore.getRunWithDefinition(tx, args.runId);
    if (!loaded) return { kind: "not_found" };
    const { run, definition } = loaded;
    const parked =
      run.status === "waiting_gate" &&
      pipelineGateKey(run.id, run.currentStage, run.iteration) === args.gateKey;
    if (!parked) {
      // This check's own failure, committed by an earlier run of the step
      // whose result was lost: report it, so the notice still goes out.
      const failedByThis =
        args.failParkedRunWith !== null &&
        run.status === "failed" &&
        run.failureReason === args.failParkedRunWith;
      return failedByThis
        ? { kind: "failed", conversationId: run.conversationId }
        : staleOutcome(run, definition, args);
    }
    if (args.failParkedRunWith === null) return { kind: "parked" };
    const failed = await deps.runStore.failRun(tx, run.id, args.failParkedRunWith);
    if (failed.kind !== "failed") {
      throw new Error(`run ${run.id} read as parked but could not be failed (${failed.kind})`);
    }
    return failed;
  });
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
      return staleOutcome(run, definition, args);
    }

    const claimed = await deps.runStore.claimGate(tx, run.id, {
      gateKey: args.gateKey,
      resolverRunId: args.resolverRunId,
    });
    if (claimed.kind !== "transitioned") return staleOutcome(run, definition, args);

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
