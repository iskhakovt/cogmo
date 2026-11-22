/**
 * The ported handlers. Sandboxed: orchestration only, every side effect an
 * activity. Compare `scheduledTaskFireWorkflow` with
 * src/agent/scheduling/fire-handler.ts.
 */

import {
  ApplicationFailure,
  log,
  proxyActivities,
  proxyLocalActivities,
  sleep,
} from "@temporalio/workflow";
import type { DispatchScheduledFireResult } from "../../../src/agent/scheduling/dispatch-fire.js";
import type { FlowActivities } from "../flow/activities.js";
import type { FlowEventOf } from "../flow/types.js";
import type { SchedulingActivities, TurnActivities } from "./activities.js";

type Params = Readonly<Record<string, number | string>>;

const flow = proxyActivities<FlowActivities>({
  startToCloseTimeout: "10s",
  retry: { initialInterval: "100ms" },
});

// `retries: 2` on the Inngest function: three attempts at the one step.
const scheduling = proxyActivities<SchedulingActivities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3, initialInterval: "100ms" },
});

const turn = proxyActivities<TurnActivities>({
  startToCloseTimeout: "5m",
  heartbeatTimeout: "30s",
  retry: { initialInterval: "100ms" },
});

function numberParam(params: Params, name: string): number {
  const value = params[name];
  if (typeof value !== "number") throw ApplicationFailure.nonRetryable(`param ${name} missing`);
  return value;
}

export async function scheduledTaskFireWorkflow(
  event: FlowEventOf<"agent/scheduled-task.fire">,
): Promise<DispatchScheduledFireResult> {
  const { taskId, userId, profileId, scheduledFor, prompt } = event.data;
  const scheduledFireKey = `${taskId}:${scheduledFor}`;

  const result = await scheduling.dispatchScheduledFire({
    userId,
    profileId,
    scheduledFor,
    prompt,
    scheduledFireKey,
  });

  if (result.status === "skipped") {
    log.warn("scheduled fire skipped", { taskId, reason: result.reason });
    return result;
  }

  await flow.emit([
    {
      name: "inbound/arrived",
      id: `fire:${result.inboundId}`,
      data: { conversationId: result.conversationId, inboundMessageId: result.inboundId },
    },
  ]);
  log.info("scheduled fire dispatched", { taskId, inboundId: result.inboundId });
  return result;
}

/** The debounced router: the burst went quiet, so hand its last inbound on. */
export async function debounceRouterWorkflow(event: FlowEventOf<"inbound/arrived">): Promise<void> {
  await flow.emit([
    {
      name: "inbound/ready",
      id: `ready:${event.id}`,
      data: {
        conversationId: event.data.conversationId,
        triggerInboundId: event.data.inboundMessageId,
      },
    },
  ]);
}

/** Stands in for handle-message: a turn of N model iterations, then the reply. */
export async function turnWorkflow(
  event: FlowEventOf<"inbound/ready">,
  params: Params,
): Promise<void> {
  const { conversationId, triggerInboundId } = event.data;
  if (triggerInboundId === "fail") throw ApplicationFailure.nonRetryable("turn failed");
  await turn.record({ conversationId, mark: `turn-start:${triggerInboundId}` });
  for (let iteration = 0; iteration < numberParam(params, "iterations"); iteration++) {
    await turn.llmIteration({
      conversationId,
      iteration,
      durationMs: numberParam(params, "iterationMs"),
    });
  }
  await turn.record({ conversationId, mark: `turn-end:${triggerInboundId}` });
  await flow.emit([
    {
      name: "response/ready",
      id: `response:${event.id}`,
      data: { conversationId, messageId: `message:${event.id}` },
    },
  ]);
}

/** Stands in for stage-runner, which shares the conversation's turn lane. */
export async function stageWorkflow(
  event: FlowEventOf<"pipeline/stage.due">,
  params: Params,
): Promise<void> {
  const conversationId = event.data.conversationId;
  if (conversationId === undefined) throw ApplicationFailure.nonRetryable("no conversation");
  await turn.record({ conversationId, mark: `stage-start:${event.data.stageId}` });
  await turn.llmIteration({
    conversationId,
    iteration: 0,
    durationMs: numberParam(params, "iterationMs"),
  });
  await turn.record({ conversationId, mark: `stage-end:${event.data.stageId}` });
}

/** idle-timer: sleep out the idle window, then announce it. Cancelled by the next inbound. */
export async function idleTimerWorkflow(
  event: FlowEventOf<"response/ready">,
  params: Params,
): Promise<void> {
  await sleep(numberParam(params, "idleTimeoutMs"));
  await flow.emit([
    {
      name: "conversation/idle",
      id: `idle:${event.id}`,
      data: { conversationId: event.data.conversationId },
    },
  ]);
}

const local = proxyLocalActivities<TurnActivities>({ startToCloseTimeout: "30s" });

/** Bench: `steps` sequential zero-length steps, as activities or local activities. */
export async function stepsWorkflow(args: {
  id: string;
  steps: number;
  local: boolean;
}): Promise<void> {
  const run = args.local ? local : turn;
  for (let i = 0; i < args.steps; i++) {
    await run.record({ conversationId: args.id, mark: `step-${i}` });
  }
}
