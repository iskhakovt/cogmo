/**
 * The event bus Temporal lacks. `emit` routes each event to the functions it
 * cancels and the functions it triggers; every workflow id it starts or
 * signals derives from the event's id or a key in its data, so a retried
 * fan-out lands on the same workflows.
 */

import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { fieldValue, type RegisteredFunction } from "./define.js";
import type { FlowEvent, Job } from "./types.js";
import { arriveSignal, debounceWorkflow, enqueueSignal, laneWorkflow } from "./workflows.js";

export interface Dispatcher {
  emit(events: ReadonlyArray<FlowEvent>): Promise<void>;
  /** Start one function's run for an event, past its debounce. */
  startRun(functionId: string, event: FlowEvent): Promise<void>;
}

export interface DispatcherDeps {
  client: Client;
  taskQueue: string;
  functions: ReadonlyArray<RegisteredFunction>;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { client, taskQueue, functions } = deps;
  const byId = new Map(functions.map((fn) => [fn.id, fn]));

  async function cancel(fn: RegisteredFunction, event: FlowEvent, field: string): Promise<void> {
    const handle = client.workflow.getHandle(`${fn.id}:${fieldValue(event, field)}`);
    try {
      await handle.cancel();
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;
    }
  }

  async function run(fn: RegisteredFunction, event: FlowEvent): Promise<void> {
    const jobId = fn.runId(event);
    if (fn.lane) {
      const key = fn.lane.key(event);
      const job: Job = {
        functionId: fn.id,
        workflowType: fn.workflowType,
        jobId,
        event,
        params: fn.params,
      };
      await client.workflow.signalWithStart(laneWorkflow, {
        workflowId: `lane:${key}`,
        taskQueue,
        args: [{ key, limit: fn.lane.limit, carried: [] }],
        signal: enqueueSignal,
        signalArgs: [job],
      });
      return;
    }
    try {
      await client.workflow.start(fn.workflowType, {
        workflowId: jobId,
        taskQueue,
        args: [event, fn.params],
        // cancelOn functions restart on a new trigger; the rest dedup on their id.
        ...(fn.cancelOn
          ? { workflowIdConflictPolicy: "TERMINATE_EXISTING" as const }
          : { workflowIdReusePolicy: "REJECT_DUPLICATE" as const }),
      });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
  }

  return {
    async emit(events) {
      for (const event of events) {
        for (const fn of functions) {
          if (fn.cancelOn?.event === event.name) await cancel(fn, event, fn.cancelOn.field);
        }
        for (const fn of functions) {
          if (fn.trigger !== event.name) continue;
          if (fn.debounce) {
            await client.workflow.signalWithStart(debounceWorkflow, {
              workflowId: `debounce:${fn.id}:${fn.debounce.key(event)}`,
              taskQueue,
              args: [
                {
                  functionId: fn.id,
                  periodMs: fn.debounce.periodMs,
                  timeoutMs: fn.debounce.timeoutMs,
                },
              ],
              signal: arriveSignal,
              signalArgs: [event],
            });
          } else {
            await run(fn, event);
          }
        }
      }
    },
    async startRun(functionId, event) {
      const fn = byId.get(functionId);
      if (fn === undefined) throw new Error(`no function ${functionId}`);
      await run(fn, event);
    },
  };
}
