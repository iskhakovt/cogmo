/**
 * `pipeline-stage-runner` — executes exactly one stage of a run per
 * `pipeline/stage.due`, then hands off by event (design/pipelines.md →
 * Execution Model). No function stays in flight across stages or gates.
 *
 * - `agentic`: runs the stage turn, then records its artifact and moves the
 *   cursor in one step, and emits the next stage in a separate one — a retry
 *   after the commit replays only the emit.
 * - `gate`: parks the run at `waiting_gate` and emits `pipeline/gate.pending`;
 *   the resolver picks it up from there.
 * - `wait`: not runnable yet. `start_pipeline` refuses such definitions, so
 *   reaching one fails the run with that reason.
 *
 * Every branch keys on the run snapshot memoized by `load-run`, never on a
 * live read of state the run's own steps mutate. A delivery whose cursor no
 * longer matches the run — a duplicate, or one the run has moved past — is
 * skipped.
 *
 * A transition step re-run after its own commit reads `stale` with the run's
 * cursor. When that is where the step would have put the run, it sends the
 * follow-up anyway; the event is deduped on the run cursor.
 */

import { NonRetriableError } from "inngest";
import { match, P } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { inngest as inngestClient } from "../../inngest/client.js";
import { conversationTurnConcurrency } from "../../inngest/concurrency.js";
import { fromStepTools } from "../../inngest/durable.js";
import {
  buildPipelineGatePendingEvent,
  buildPipelineStageDueEvent,
  pipelineGateKey,
  pipelineStageDue,
  responseReady,
} from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import { createTurnStepRunner } from "../turn-step-runner.js";
import { notifyAfterRetries } from "./notify.js";
import type {
  AgenticStageArgs,
  AgenticStageOutcome,
  AgenticStageSteps,
} from "./run-agentic-stage.js";
import { describePipelineRunFailure, type PipelineRunFailure } from "./run-failure.js";
import { StageOutputsSchema } from "./run-types.js";
import {
  isTerminalPipelineRunStatus,
  type PipelineRunStatus,
  type PipelineRunStore,
  type StageFailure,
} from "./store/index.js";
import { PipelineDefinitionSchema, parseDurationMs } from "./types.js";

/**
 * What the `fail-run` step can replay. A run in flight across a deploy
 * replays the result an earlier build's step stored (`.agents/rules/inngest.md`
 * → a memoized result is a contract), and that build's `fail-run` returned
 * `failRun`'s `already_terminal`; it means the same as `stale`.
 */
type FailRunStepResult = StageFailure | { kind: "already_terminal"; status: PipelineRunStatus };

/**
 * Why `fail-run` left the run alone: a terminal run on the stage ended
 * another way; any other status means the run moved off the stage.
 */
function staleFailureNote(status: PipelineRunStatus): string {
  return isTerminalPipelineRunStatus(status)
    ? "the run already ended another way"
    : "the run is no longer on the failed stage";
}

export interface PipelineStageRunnerDeps {
  runInTx: Transactor;
  runStore: Pick<
    PipelineRunStore,
    "getRunWithDefinition" | "parkAtGate" | "advanceStage" | "completeRun" | "failRunAt"
  >;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
  executeAgenticStage: (
    args: AgenticStageArgs,
    steps: AgenticStageSteps,
    log: typeof logger,
  ) => Promise<AgenticStageOutcome>;
}

export function createPipelineStageRunner(deps: PipelineStageRunnerDeps) {
  return inngestClient.createFunction(
    {
      id: "pipeline-stage-runner",
      triggers: [pipelineStageDue],
      retries: 2,
      // A run owns its conversation, so the shared key also runs one stage of
      // a run at a time.
      concurrency: conversationTurnConcurrency,
      // Retries exhausted (or non-retriable): a run still on this stage cannot
      // advance past it, so it fails rather than sitting `running` with nothing
      // scheduled. A run that has moved on — the advance committed and only
      // the emit failed — is left where it is. The detail carries the error
      // class only — messages can hold query text or payloads, and the full
      // error is in the log.
      onFailure: async ({ event, error, step }) => {
        const { runId, stageId, iteration } = event.data.event.data;
        const durable = fromStepTools(step);
        const log = logger.child({ component: "pipeline.stage-runner", runId, stageId });
        log.error({ err: error }, "pipeline stage failed after retries");
        const failed = await durable.run<FailRunStepResult>("fail-run", () =>
          deps.runInTx((tx) =>
            deps.runStore.failRunAt(
              tx,
              { runId, stageId, iteration },
              { reason: "stage_error", detail: error.name },
            ),
          ),
        );
        await match(failed)
          .with({ kind: P.union("failed", "already_failed") }, (f) =>
            notifyAfterRetries(
              durable,
              "notify-failure",
              deps.deliveryRouter,
              f.conversationId,
              `❌ The pipeline run failed at stage "${stageId}" and has stopped.`,
              { runId, stageId },
            ),
          )
          .with({ kind: P.union("stale", "already_terminal") }, (f) => {
            log.info({ runStatus: f.status }, `${staleFailureNote(f.status)} — leaving it`);
          })
          .with({ kind: "not_found" }, () => {
            log.warn("stage failed for a run that does not exist");
          })
          .exhaustive();
      },
    },
    async ({ event, step, runId: inngestRunId }) => {
      const { runId, stageId, iteration } = event.data;
      const durable = fromStepTools(step);
      const log = logger.child({
        component: "pipeline.stage-runner",
        runId,
        stageId,
        inngestRunId,
      });

      const snapshot = await durable.run("load-run", async () => {
        const loaded = await deps.runInTx((tx) => deps.runStore.getRunWithDefinition(tx, runId));
        if (!loaded) return { found: false as const };
        return {
          found: true as const,
          status: loaded.run.status,
          currentStage: loaded.run.currentStage,
          iteration: loaded.run.iteration,
          conversationId: loaded.run.conversationId,
          stageOutputs: loaded.run.stageOutputs,
          compiled: loaded.definition.compiled,
        };
      });
      if (!snapshot.found) {
        log.warn("stage due for a run that does not exist");
        return { status: "skipped" as const, reason: "not_found" as const };
      }
      if (
        snapshot.status !== "running" ||
        snapshot.currentStage !== stageId ||
        snapshot.iteration !== iteration
      ) {
        log.info(
          { runStatus: snapshot.status, runStage: snapshot.currentStage },
          "stage delivery no longer matches the run cursor — skipping",
        );
        return { status: "skipped" as const, reason: "stale" as const };
      }

      // Re-parse the step-cached JSON back into the domain types.
      const definition = PipelineDefinitionSchema.parse(snapshot.compiled);
      const stageOutputs = StageOutputsSchema.parse(snapshot.stageOutputs);
      const { conversationId } = snapshot;
      const index = definition.stages.findIndex((s) => s.id === stageId);
      const stage = definition.stages[index];
      const next = definition.stages[index + 1];

      const failRun = async (failure: PipelineRunFailure) => {
        const failed = await durable.run<FailRunStepResult>("fail-run", () =>
          deps.runInTx((tx) => deps.runStore.failRunAt(tx, { runId, stageId, iteration }, failure)),
        );
        return match(failed)
          .with({ kind: P.union("failed", "already_failed") }, async () => {
            await notifyAfterRetries(
              durable,
              "notify-failure",
              deps.deliveryRouter,
              conversationId,
              `❌ Pipeline "${definition.name}" failed at stage "${stageId}": ${describePipelineRunFailure(failure)}`,
              { runId, stageId },
            );
            return { status: "failed" as const, failure };
          })
          .with({ kind: P.union("stale", "already_terminal") }, async (f) => {
            log.info({ runStatus: f.status }, `${staleFailureNote(f.status)} — skipping`);
            return { status: "skipped" as const, reason: "stale" as const };
          })
          .with({ kind: "not_found" }, async () => ({
            status: "skipped" as const,
            reason: "not_found" as const,
          }))
          .exhaustive();
      };

      if (stage === undefined) {
        return failRun({ reason: "unknown_stage", detail: null });
      }

      // A run started from chat: its first stage would otherwise stream into
      // the same chat while the starting turn's reply is still streaming.
      // Bounded — if that turn's `response/ready` has already gone by, or
      // never comes, the stage starts after the timeout anyway.
      const origin = event.data.originConversationId;
      if (origin !== undefined && index === 0) {
        await durable.waitForEvent("wait-for-origin-turn", {
          event: responseReady,
          timeout: "30s",
          if: `async.data.conversationId == ${JSON.stringify(origin)}`,
        });
      }

      if (stage.kind === "wait") {
        return failRun({ reason: "unsupported_stage", detail: null });
      }

      if (stage.kind === "gate") {
        const gate = stage.gate;
        if (gate === undefined) {
          // The compiler's validation pass requires `gate` on gate stages.
          throw new NonRetriableError(`gate stage "${stageId}" has no gate configuration`);
        }
        const parked = await durable.run("park-on-gate", () =>
          deps.runInTx((tx) => deps.runStore.parkAtGate(tx, runId)),
        );
        if (parked.kind !== "transitioned") {
          const alreadyParkedHere =
            parked.kind === "stale" &&
            parked.status === "waiting_gate" &&
            parked.currentStage === stageId &&
            parked.iteration === iteration;
          if (!alreadyParkedHere) {
            return { status: "skipped" as const, reason: "stale" as const };
          }
        }
        await durable.sendEvent(
          "emit-gate-pending",
          buildPipelineGatePendingEvent({
            runId,
            gateKey: pipelineGateKey(runId, stageId, iteration),
            conversationId,
            pipelineName: definition.name,
            stageId,
            prompt: stage.instructions ?? "",
            timeoutMs: parseDurationMs(gate.timeout),
            onTimeout: gate.onTimeout,
          }),
        );
        return { status: "waiting_gate" as const };
      }

      const stepRun = createTurnStepRunner(durable.run);

      const outcome = await deps.executeAgenticStage(
        {
          runId,
          stageId,
          iteration,
          conversationId,
          definition,
          stage,
          stageOutputs,
          inngestRunId,
        },
        { run: durable.run, stepRun },
        log,
      );
      if (outcome.kind === "failed") return failRun(outcome.failure);

      const { artifact } = outcome;
      const moved = await durable.run("advance-run", () =>
        deps.runInTx((tx) =>
          next === undefined
            ? deps.runStore.completeRun(tx, { runId, fromStage: stageId, output: artifact })
            : deps.runStore.advanceStage(tx, {
                runId,
                fromStage: stageId,
                output: artifact,
                toStage: next.id,
              }),
        ),
      );
      if (moved.kind !== "advanced") {
        const alreadyMoved =
          moved.kind === "stale" &&
          moved.iteration === iteration &&
          (next === undefined
            ? moved.status === "completed" && moved.currentStage === stageId
            : moved.status === "running" && moved.currentStage === next.id);
        if (!alreadyMoved) {
          return { status: "skipped" as const, reason: "stale" as const };
        }
      }

      if (next !== undefined) {
        await durable.sendEvent(
          "emit-next-stage",
          buildPipelineStageDueEvent({ runId, conversationId, stageId: next.id, iteration }),
        );
        return { status: "advanced" as const, nextStage: next.id };
      }

      await notifyAfterRetries(
        durable,
        "notify-completed",
        deps.deliveryRouter,
        conversationId,
        `✅ Pipeline "${definition.name}" completed.`,
        { runId, stageId },
      );
      return { status: "completed" as const };
    },
  );
}
