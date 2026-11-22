/**
 * The flow layer's activities: how a workflow emits, hands a debounced
 * event on, and reports a failed lane job. Emitting is an activity because
 * a workflow can't start arbitrary workflows; the dispatcher's ids make a
 * retried activity land on the same workflows.
 */

import type { Dispatcher } from "./dispatcher.js";
import type { AnyFlowEvent, FlowEvent } from "./types.js";

export interface FunctionFailure {
  functionId: string;
  jobId: string;
  event: FlowEvent;
}

export interface FlowActivities {
  emit(events: AnyFlowEvent[]): Promise<void>;
  startRun(args: { functionId: string; event: FlowEvent }): Promise<void>;
  reportFailure(failure: FunctionFailure): Promise<void>;
}

export function createFlowActivities(
  dispatcher: Dispatcher,
  onFailure: (failure: FunctionFailure) => void,
): FlowActivities {
  return {
    emit: (events) => dispatcher.emit(events),
    startRun: ({ functionId, event }) => dispatcher.startRun(functionId, event),
    reportFailure: async (failure) => {
      onFailure(failure);
    },
  };
}
