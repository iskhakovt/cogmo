/**
 * `pipeline-stage-runner` — enters one stage of one run, then ends.
 *
 * The run row is the source of truth and each stage transition is its own
 * short function invocation chained by events; nothing stays in flight
 * across a deploy, and a week-long gate costs no in-flight state
 * (design/pipelines.md → Execution Model).
 *
 * Entering a stage means different things per kind, and neither blocks:
 * an `agentic` stage's instructions go into the conversation as a synthetic
 * inbound and the ordinary turn pipeline takes over until the model calls
 * `complete_stage`; a `gate` posts its prompt, parks the run at
 * `waiting_gate` and waits for the user's decision to arrive as a fresh
 * event.
 */

import type { Inngest } from "inngest";
import { match } from "ts-pattern";
import type { z } from "zod";
import type { Transactor } from "../../db/index.js";
import {
  buildInboundArrivedEvent,
  pipelineGateRequested,
  pipelineRunFinished,
  pipelineStageDue,
} from "../../inngest/events.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { TransportStore } from "../../transport/store/index.js";
import { dispatchStageInbound } from "./dispatch-stage-inbound.js";
import { loadStageContextStep } from "./load-stage-context.js";
import { buildGatePrompt } from "./stage-input.js";
import {
  isTerminalPipelineRunStatus,
  type PipelineRunStore,
  type PipelineStore,
} from "./store/index.js";

const log = logger.child({ component: "pipeline.stage-runner" });

export interface PipelineStageRunnerDeps {
  runInTx: Transactor;
  store: PipelineStore;
  runStore: PipelineRunStore;
  transportStore: Pick<TransportStore, "persistInbound" | "findInboundByPipelineStageKey">;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

export type PipelineStageDueData = z.infer<typeof pipelineStageDue.schema>;

export type PipelineStageRunResult =
  | { status: "dispatched"; kind: "agentic"; inboundId: string }
  | { status: "parked"; kind: "gate" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Function body, extracted so tests drive it with step shims instead of an
 * Inngest runtime (same shape as the coding orchestrators).
 */
export async function runPipelineStage(
  deps: PipelineStageRunnerDeps,
  event: PipelineStageDueData,
  stepRun: StepRun,
  stepSendEvent: StepSendEvent,
): Promise<PipelineStageRunResult> {
  const { runId, stageId, iteration, note } = event;

  const context = await loadStageContextStep(deps, stepRun, { kind: "run", runId });
  if (context === undefined) {
    log.warn({ runId, stageId }, "pipeline stage.due for an unknown run or stage");
    return { status: "skipped" as const, reason: "no_stage_context" };
  }

  // The cursor is the authority on what should run, and the event is
  // only a request to run it. A redelivery, a superseded revise, or a
  // cancellation that landed first all read as stale here.
  if (
    context.stageId !== stageId ||
    context.iteration !== iteration ||
    isTerminalPipelineRunStatus(context.status)
  ) {
    log.info(
      { runId, stageId, iteration, at: context.stageId, status: context.status },
      "pipeline stage.due no longer matches the run cursor",
    );
    return { status: "skipped" as const, reason: "stale_cursor" };
  }

  return match(context.stage.kind)
    .with("agentic", async () => {
      const { inboundId } = await stepRun("dispatch-stage-inbound", () =>
        dispatchStageInbound(deps, {
          context,
          ...(note !== undefined && { note }),
        }),
      );
      await stepSendEvent(
        "trigger-handle-message",
        buildInboundArrivedEvent({
          conversationId: context.conversationId,
          inboundMessageId: inboundId,
        }),
      );
      return { status: "dispatched" as const, kind: "agentic" as const, inboundId };
    })
    .with("gate", async () => {
      const parked = await stepRun("park-gate", async () => {
        const result = await deps.runInTx((tx) =>
          deps.runStore.transitionStatus(tx, runId, "running", "waiting_gate"),
        );
        // `stale` at `waiting_gate` means the run is already parked where
        // this wants it, so the entry proceeds and the prompt is posted.
        // That is a deliberate trade: a redelivered `stage.due` for a gate
        // that is already parked re-posts the prompt, which is noise, while
        // treating it as a skip would swallow the prompt entirely when the
        // park committed and the post did not — a gate nobody is told about
        // waits forever. Any other stale status means something else moved
        // the run, and prompting for it would mislead the user.
        return {
          parked:
            result.kind === "transitioned" ||
            (result.kind === "stale" && result.status === "waiting_gate"),
        };
      });
      if (!parked.parked) {
        return { status: "skipped" as const, reason: "run_moved_before_gate" };
      }

      await stepRun("post-gate-prompt", () =>
        deps.deliveryRouter.notifyConversation(
          context.conversationId,
          buildGatePrompt({
            pipelineName: context.pipelineName,
            stage: context.stage,
            stageIndex: context.stageIndex,
            stageCount: context.stageCount,
            // A revise can land on a gate when two gates sit next to each
            // other; the feedback belongs in the prompt rather than nowhere.
            ...(note !== undefined && { note }),
          }),
        ),
      );

      // Channels that render an inline keyboard subscribe to this and
      // add the buttons; the prompt above already stands on its own for
      // the ones that don't.
      await stepSendEvent("request-gate-keyboard", {
        ...pipelineGateRequested.create({
          runId,
          stageId,
          iteration,
          conversationId: context.conversationId,
          pipelineName: context.pipelineName,
        }),
        id: `pipeline-gate-requested-${runId}:${stageId}:${iteration}`,
      });
      return { status: "parked" as const, kind: "gate" as const };
    })
    .with("wait", async () => {
      // `startPipelineRun` refuses definitions carrying wait stages, so
      // this is only reachable for a run started before that guard — fail
      // loudly rather than silently skipping a stage the user declared.
      const reason = `stage "${stageId}" waits on an external event, which this engine cannot do yet`;
      const failed = await stepRun("fail-unsupported-stage", () =>
        deps.runInTx((tx) => deps.runStore.failRun(tx, runId, reason)),
      );
      if (failed.kind === "failed") {
        await stepRun("notify-unsupported-stage", () =>
          deps.deliveryRouter.notifyConversation(
            context.conversationId,
            `The "${context.pipelineName}" pipeline stopped: ${reason}.`,
          ),
        );
        await stepSendEvent("emit-run-finished", {
          ...pipelineRunFinished.create({
            runId,
            pipelineName: context.pipelineName,
            status: "failed",
          }),
          id: `pipeline-run-finished-${runId}`,
        });
      }
      return { status: "failed" as const, reason };
    })
    .exhaustive();
}

export function createPipelineStageRunner(deps: PipelineStageRunnerDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "pipeline-stage-runner",
      retries: 2,
      // Per-run singleton: two stage entries for one run would race the
      // cursor. Stages of *different* runs stay parallel.
      concurrency: { limit: 1, key: "event.data.runId" },
      triggers: [pipelineStageDue],
    },
    async ({ event, step }) => runPipelineStage(deps, event.data, step.run, step.sendEvent),
  );
}
