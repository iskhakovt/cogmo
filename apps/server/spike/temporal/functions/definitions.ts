/**
 * The spiked functions, declared the way their Inngest counterparts are.
 * Each `defineFunction` is the whole of what the flow layer needs; the
 * lane, debounce and cancel machinery is generated from it.
 */

import { defineFunction, type RegisteredFunction } from "../flow/define.js";

export interface SpikeConfig {
  debounce: { periodMs: number; timeoutMs: number | null };
  idleTimeoutMs: number;
  turn: { iterations: number; iterationMs: number };
}

export function createFunctions(config: SpikeConfig): RegisteredFunction[] {
  const turnLane = (conversationId: string) => `conversation-turn:${conversationId}`;
  return [
    // src/agent/scheduling/fire-handler.ts
    defineFunction({
      id: "scheduled-task-fire",
      trigger: "agent/scheduled-task.fire",
      workflowType: "scheduledTaskFireWorkflow",
      concurrency: { limit: 1, key: (data) => data.taskId },
    }),
    // src/agent/debounce.ts, native path
    defineFunction({
      id: "debounce-router",
      trigger: "inbound/arrived",
      workflowType: "debounceRouterWorkflow",
      debounce: { key: (data) => data.conversationId, ...config.debounce },
    }),
    // src/agent/handle-message.ts: conversationTurnConcurrency
    defineFunction({
      id: "handle-message",
      trigger: "inbound/ready",
      workflowType: "turnWorkflow",
      concurrency: { limit: 1, key: (data) => turnLane(data.conversationId) },
      params: { ...config.turn },
    }),
    // src/agent/pipeline/stage-runner.ts: the same lane as handle-message
    defineFunction({
      id: "stage-runner",
      trigger: "pipeline/stage.due",
      workflowType: "stageWorkflow",
      concurrency: { limit: 1, key: (data) => turnLane(data.conversationId ?? data.runId) },
      params: { iterationMs: config.turn.iterationMs },
    }),
    // src/agent/idle-timer.ts
    defineFunction({
      id: "idle-timer",
      trigger: "response/ready",
      workflowType: "idleTimerWorkflow",
      cancelOn: { event: "inbound/arrived", field: "conversationId" },
      params: { idleTimeoutMs: config.idleTimeoutMs },
    }),
  ];
}
