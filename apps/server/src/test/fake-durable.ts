/**
 * An in-memory `Durable` for use-case tests that don't need Inngest's
 * execution engine: each primitive runs at once and is recorded, so a test
 * asserts on the steps a use case planned, in order, with their payloads.
 * A `memo` stands in for an earlier invocation's step results. Engine
 * behaviour beyond that (re-invocation at each boundary, `StepError` after
 * retries) is tested through `@inngest/test` or `directStep`.
 */

import type { DefinedEvent, Durable } from "../inngest/durable.js";

/** One step a use case planned, as the fake recorded it. Immutable once recorded. */
type PlannedStep = Readonly<
  | { kind: "run"; id: string }
  | { kind: "sendEvent"; id: string; events: ReadonlyArray<DefinedEvent> }
  | { kind: "sleep"; id: string; duration: string }
  | { kind: "waitForEvent"; id: string; event: string }
>;

export interface FakeDurable extends Durable {
  /** Every step planned so far, in call order. */
  planned(): ReadonlyArray<PlannedStep>;
  /** The ids of `planned()`, for asserting on step order alone. */
  stepIds(): string[];
}

export interface FakeDurableOptions {
  /** Step results from an earlier invocation, by step id: `run` returns these without running the body. */
  memo?: Readonly<Record<string, unknown>>;
}

/**
 * `run` invokes its body inline and returns the body's value (or the memo's,
 * for a memoized id); `sendEvent` and `sleep` resolve at once;
 * `waitForEvent` resolves `null`, as a wait that timed out.
 */
export function fakeDurable(options: FakeDurableOptions = {}): FakeDurable {
  const memo = options.memo ?? {};
  const planned: PlannedStep[] = [];
  return {
    run: async <T>(id: string, body: () => Promise<T>): Promise<T> => {
      planned.push({ kind: "run", id });
      // A memo entry is what the test says an earlier invocation returned
      // for this id; the test owns that it has the step's result type.
      return id in memo ? (memo[id] as T) : body();
    },
    sendEvent: async (id, events) => {
      planned.push({
        kind: "sendEvent",
        id,
        events: Array.isArray(events) ? [...events] : [events],
      });
    },
    sleep: async (id, duration) => {
      planned.push({ kind: "sleep", id, duration });
    },
    waitForEvent: async (id, waitOptions) => {
      planned.push({ kind: "waitForEvent", id, event: waitOptions.event.name });
      return null;
    },
    planned: () => [...planned],
    stepIds: () => planned.map((step) => step.id),
  };
}
