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
 */

import { NonRetriableError } from "inngest";
import type { Transactor } from "../../db/index.js";
import { inngest as inngestClient } from "../../inngest/client.js";
import {
  buildPipelineGatePendingEvent,
  buildPipelineStageDueEvent,
  pipelineGateKey,
  pipelineStageDue,
  responseReady,
} from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { StepRunner } from "../loop.js";
import { createTurnStepRunner } from "../turn-step-runner.js";
import type {
  AgenticStageArgs,
  AgenticStageOutcome,
  AgenticStageSteps,
} from "./run-agentic-stage.js";
import { StageOutputsSchema } from "./run-types.js";
import type { PipelineRunStore } from "./store/index.js";
import { PipelineDefinitionSchema, parseDurationMs } from "./types.js";

export interface PipelineStageRunnerDeps {
  runInTx: Transactor;
  runStore: Pick<
    PipelineRunStore,
    "getRunWithDefinition" | "transitionStatus" | "advanceStage" | "completeRun" | "failRun"
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
      concurrency: { limit: 1, key: "event.data.runId" },
      // Retries exhausted (or non-retriable): the run cannot advance past this
      // stage, so it fails rather than sitting `running` with nothing scheduled.
      // The reason carries the error class only — messages can hold query text
      // or payloads, and the full error is in the log.
      onFailure: async ({ event, error, step }) => {
        const { runId, stageId } = event.data.event.data;
        logger.error(
          { err: error, runId, stageId, component: "pipeline.stage-runner" },
          "pipeline stage failed after retries",
        );
        const failed = await step.run("fail-run", () =>
          deps.runInTx((tx) =>
            deps.runStore.failRun(tx, runId, `stage "${stageId}" failed (${error.name})`),
          ),
        );
        if (failed.kind === "failed") {
          const { conversationId } = failed;
          await step.run("notify-failure", () =>
            deps.deliveryRouter.notifyConversation(
              conversationId,
              `❌ The pipeline run failed at stage "${stageId}" and has stopped.`,
            ),
          );
        }
      },
    },
    async ({ event, step, runId: inngestRunId }) => {
      const { runId, stageId, iteration } = event.data;
      const log = logger.child({
        component: "pipeline.stage-runner",
        runId,
        stageId,
        inngestRunId,
      });

      const snapshot = await step.run("load-run", async () => {
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

      const failRun = async (reason: string) => {
        const failed = await step.run("fail-run", () =>
          deps.runInTx((tx) => deps.runStore.failRun(tx, runId, reason)),
        );
        if (failed.kind === "failed") {
          await step.run("notify-failure", () =>
            deps.deliveryRouter.notifyConversation(
              conversationId,
              `❌ Pipeline "${definition.name}" failed at stage "${stageId}": ${reason}`,
            ),
          );
        }
        return { status: "failed" as const, reason };
      };

      if (stage === undefined) {
        return failRun(`stage "${stageId}" is not in the pinned definition`);
      }

      // A run started from chat: its first stage would otherwise stream into
      // the same chat while the starting turn's reply is still streaming.
      // Bounded — if that turn's `response/ready` has already gone by, or
      // never comes, the stage starts after the timeout anyway.
      const origin = event.data.originConversationId;
      if (origin !== undefined && index === 0) {
        await step.waitForEvent("wait-for-origin-turn", {
          event: responseReady,
          timeout: "30s",
          if: `async.data.conversationId == ${JSON.stringify(origin)}`,
        });
      }

      if (stage.kind === "wait") {
        return failRun("wait stages are not supported yet");
      }

      if (stage.kind === "gate") {
        const gate = stage.gate;
        if (gate === undefined) {
          // The compiler's validation pass requires `gate` on gate stages.
          throw new NonRetriableError(`gate stage "${stageId}" has no gate configuration`);
        }
        const parked = await step.run("park-on-gate", () =>
          deps.runInTx((tx) =>
            deps.runStore.transitionStatus(tx, runId, "running", "waiting_gate"),
          ),
        );
        if (parked.kind !== "transitioned") {
          return { status: "skipped" as const, reason: "stale" as const };
        }
        await step.sendEvent(
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

      // The cast erases Inngest's `Jsonify<T>`: every value these steps return
      // is JSON-safe by construction, so `Jsonify<T>` and `T` coincide at
      // runtime but not for the compiler.
      const run: StepRunner = <T>(id: string, fn: () => Promise<T>) =>
        step.run(id, fn) as Promise<T>;
      const stepRun = createTurnStepRunner((id, fn) => step.run(id, fn));

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
        { run, stepRun },
        log,
      );
      if (outcome.kind === "failed") return failRun(outcome.reason);

      const { artifact } = outcome;
      const moved = await step.run("advance-run", () =>
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
        return { status: "skipped" as const, reason: "stale" as const };
      }

      if (next !== undefined) {
        await step.sendEvent(
          "emit-next-stage",
          buildPipelineStageDueEvent({ runId, stageId: next.id, iteration }),
        );
        return { status: "advanced" as const, nextStage: next.id };
      }

      await step.run("notify-completed", () =>
        deps.deliveryRouter.notifyConversation(
          conversationId,
          `✅ Pipeline "${definition.name}" completed.`,
        ),
      );
      return { status: "completed" as const };
    },
  );
}
