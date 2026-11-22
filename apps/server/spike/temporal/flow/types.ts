/**
 * Shapes the generic workflows (sandboxed) and the dispatcher (Node) share.
 * The workflow bundle includes this file, so it imports types only.
 */

import type { DefinedEvent } from "../../../src/inngest/durable.js";

export type EventName = DefinedEvent["name"];

/** One event as the flow layer carries it: always with an id, which every workflow id downstream derives from. */
export type FlowEventOf<N extends EventName> = {
  name: N;
  id: string;
  data: Extract<DefinedEvent, { name: N }>["data"];
};

/** Any one defined event, its data checked against its name: what emitters build. */
export type AnyFlowEvent = { [N in EventName]: FlowEventOf<N> }[EventName];

/** An event as the flow layer carries it, its data opaque until narrowed by name. */
export interface FlowEvent {
  name: EventName;
  id: string;
  data: unknown;
}

/** Narrow an event to one name. */
export function isEvent<N extends EventName>(
  event: FlowEvent,
  name: N,
): event is FlowEvent & FlowEventOf<N> {
  return event.name === name;
}

/** One run of a function, queued on a lane. `jobId` is the child workflow's id. */
export interface Job {
  functionId: string;
  workflowType: string;
  jobId: string;
  event: FlowEvent;
  params: Readonly<Record<string, number | string>>;
}

export interface LaneArgs {
  key: string;
  limit: number;
  /** Jobs still queued when the previous run continued as new. */
  carried: Job[];
}

export interface LaneResult {
  ran: number;
  duplicates: number;
  failed: number;
}

export interface DebounceArgs {
  functionId: string;
  periodMs: number;
  /** Ceiling on one window, from its first arrival; null = none. */
  timeoutMs: number | null;
}

export interface DebounceResult {
  fired: number;
}
