/**
 * Activities for the ported functions. Each closes over worker-level deps,
 * as an Inngest `createFunction` closure does today, and takes only
 * serializable arguments.
 */

import { heartbeat } from "@temporalio/activity";
import {
  type DispatchScheduledFireArgs,
  type DispatchScheduledFireDeps,
  type DispatchScheduledFireResult,
  dispatchScheduledFire,
} from "../../../src/agent/scheduling/dispatch-fire.js";

export interface SchedulingActivities {
  dispatchScheduledFire(args: DispatchScheduledFireArgs): Promise<DispatchScheduledFireResult>;
}

/** The real use case, unchanged: the controller is the only part that moves. */
export function createSchedulingActivities(deps: DispatchScheduledFireDeps): SchedulingActivities {
  return { dispatchScheduledFire: (args) => dispatchScheduledFire(deps, args) };
}

export interface JournalEntry {
  conversationId: string;
  mark: string;
  at: number;
}

/** Stand-ins for a turn's steps, recording when each starts and ends. */
export interface TurnActivities {
  record(entry: { conversationId: string; mark: string }): Promise<void>;
  llmIteration(args: {
    conversationId: string;
    iteration: number;
    durationMs: number;
  }): Promise<void>;
}

export function createTurnActivities(journal: JournalEntry[]): TurnActivities {
  return {
    record: async ({ conversationId, mark }) => {
      journal.push({ conversationId, mark, at: Date.now() });
    },
    llmIteration: async ({ conversationId, iteration, durationMs }) => {
      journal.push({ conversationId, mark: `iter-${iteration}`, at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      heartbeat();
    },
  };
}
