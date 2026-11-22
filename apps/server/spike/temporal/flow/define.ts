/**
 * The declarative surface: a function is a trigger, a workflow type and
 * Inngest-shaped flow control. `defineFunction` erases the event type into
 * closures over `FlowEvent`, so one registry holds every function.
 */

import { type EventName, type FlowEvent, type FlowEventOf, isEvent } from "./types.js";

type Data<N extends EventName> = FlowEventOf<N>["data"];

export interface FunctionConfig<N extends EventName> {
  id: string;
  trigger: N;
  /** The workflow implementing the handler; it takes `(event, params)`. */
  workflowType: string;
  /** At most `limit` runs per key at once, queued in arrival order. Functions sharing a key share one lane. */
  concurrency?: { key: (data: Data<N>) => string; limit: number };
  /** Collapse a burst per key into one run, with the burst's last event. */
  debounce?: { key: (data: Data<N>) => string; periodMs: number; timeoutMs: number | null };
  /**
   * Cancel the run when one of these events carries the same value in
   * `field`. The run's workflow id is derived from that value, so there is
   * at most one run per value, and a new trigger restarts it.
   */
  cancelOn?: { event: EventName; field: string };
  /** One run per key, for as long as the namespace retains the closed run. */
  idempotency?: (data: Data<N>) => string;
  /** Values the handler reads, passed as the workflow's second argument. */
  params?: Readonly<Record<string, number | string>>;
}

export interface RegisteredFunction {
  id: string;
  trigger: EventName;
  workflowType: string;
  params: Readonly<Record<string, number | string>>;
  lane: { key: (event: FlowEvent) => string; limit: number } | null;
  debounce: {
    key: (event: FlowEvent) => string;
    periodMs: number;
    timeoutMs: number | null;
  } | null;
  cancelOn: { event: EventName; field: string } | null;
  /** The run's workflow id for one triggering event. */
  runId: (event: FlowEvent) => string;
}

export function defineFunction<N extends EventName>(config: FunctionConfig<N>): RegisteredFunction {
  const data = (event: FlowEvent): Data<N> => {
    if (!isEvent(event, config.trigger)) {
      throw new Error(`${config.id} is triggered by ${config.trigger}, not ${event.name}`);
    }
    return event.data;
  };
  const { concurrency, debounce, cancelOn, idempotency } = config;
  return {
    id: config.id,
    trigger: config.trigger,
    workflowType: config.workflowType,
    params: config.params ?? {},
    lane: concurrency
      ? { key: (event) => concurrency.key(data(event)), limit: concurrency.limit }
      : null,
    debounce: debounce
      ? {
          key: (event) => debounce.key(data(event)),
          periodMs: debounce.periodMs,
          timeoutMs: debounce.timeoutMs,
        }
      : null,
    cancelOn: cancelOn ?? null,
    runId: (event) => {
      if (cancelOn) return `${config.id}:${fieldValue(event, cancelOn.field)}`;
      return `${config.id}:${idempotency ? idempotency(data(event)) : event.id}`;
    },
  };
}

export function fieldValue(event: FlowEvent, field: string): string {
  const data = event.data;
  const value: unknown =
    typeof data === "object" && data !== null
      ? Object.entries(data).find(([key]) => key === field)?.[1]
      : undefined;
  if (typeof value !== "string") {
    throw new Error(`${event.name} has no string field ${field}`);
  }
  return value;
}
