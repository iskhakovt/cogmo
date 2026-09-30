import { logger } from "../../logger.js";
import type { ExecuteStreamHandle, PlanStreamHandle } from "./orchestrator.js";

const log = logger.child({ component: "coding.streaming-registry" });

/**
 * Events the orchestrators publish per task while the CLI is streaming.
 * Mirrors the meaningful subset of `CodingEvent`, flattened for consumers
 * that just need to render progress (not parse tool-use semantics).
 */
export type CodingStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; tool: string }
  | { kind: "tool_result"; tool: string; ok: boolean; summary?: string }
  | {
      kind: "plan_finalized";
      plan: string;
      /**
       * `true` when the plan orchestrator is about to stamp
       * `plan_approved_at` itself — a user trigger whose profile carries
       * `coding_autoapprove_mode = 'on'`, or an `evolution` /
       * `signal_pipeline` trigger, which has no interactive gate.
       * Subscribers suppress the approve/revise/cancel keyboard in that
       * case — the buttons would either be misleading (Approve is a no-op
       * against an already-approved plan) or action-at-a-distance (a stray
       * Cancel mid-execute).
       */
      autoApproved?: boolean;
    }
  | { kind: "execute_started" }
  | { kind: "execute_complete"; ok: boolean; tokens?: { input: number; output: number } }
  | { kind: "failed"; reason: string };

type CodingStreamListener = (event: CodingStreamEvent) => void | Promise<void>;

interface TaskStream {
  readonly listeners: Set<CodingStreamListener>;
  /** The previous sweep found the task ended. */
  endedAtLastSweep: boolean;
}

/**
 * In-process fan-out of each coding task's progress: the durable
 * orchestrators publish through the handles `planStream` and
 * `executeStream` return, and the delivery layer subscribes.
 *
 * In-process rather than Inngest events because text deltas land at chat
 * cadence, and routing each through the bus would serialize, persist and
 * dispatch every few characters. Cogmo is single-node, so the orchestrators
 * and the Telegram adapter share a process. Inngest events carry the state
 * transitions (`task/start`, `plan-approved`, `failed`), where durability
 * matters.
 *
 * The registry holds a task only while something is subscribed to it:
 *
 * - `subscribe` opens the task's stream. A publish to a task without one is
 *   dropped, so publishing never holds state: a replayed or retried step
 *   body, or the verify phase streaming after execute ended the stream,
 *   changes nothing.
 * - `failed`, and an `execute_complete` reporting success, end the stream:
 *   every subscriber gets the event and the registry lets go of the task.
 *   A failed execute's `execute_complete` is followed by the `failed` that
 *   carries the reason, so it doesn't end the stream.
 * - A task can end without its stream ending: cancelled or revised at the
 *   plan gate, failed before a stream opened, or failed by reconcile after
 *   its worker died. `sweep` releases a task the database reports ended at
 *   two consecutive sweeps; the second is the grace an orchestrator's final
 *   event gets after its status write.
 *
 * A task awaiting approval keeps its stream, so the execute phase edits the
 * message the plan went to. Admission caps non-terminal tasks per repo,
 * which bounds what the registry holds.
 *
 * Publishers are isolated from subscribers. A listener that throws or
 * rejects is logged, and its siblings still get the event. The registry
 * never awaits a listener, so one that hangs holds neither the orchestrator
 * nor the task. Events aren't replayed: a subscriber sees what is published
 * after it subscribes.
 */
export class CodingStreamingRegistry {
  readonly #streams = new Map<string, TaskStream>();

  /** The plan orchestrator's handle for `taskId`. */
  planStream(taskId: string): PlanStreamHandle {
    return {
      appendText: async (delta) => this.#publish(taskId, { kind: "text", delta }),
      finalize: async (plan, opts) =>
        this.#publish(taskId, {
          kind: "plan_finalized",
          plan,
          ...(opts?.autoApproved && { autoApproved: true }),
        }),
      fail: async (reason) => this.#publish(taskId, { kind: "failed", reason }),
    };
  }

  /** The execute and verify orchestrators' handle for `taskId`. */
  executeStream(taskId: string): ExecuteStreamHandle {
    return {
      started: async () => this.#publish(taskId, { kind: "execute_started" }),
      appendText: async (delta) => this.#publish(taskId, { kind: "text", delta }),
      toolCall: async (tool) => this.#publish(taskId, { kind: "tool_call", tool }),
      toolResult: async (tool, ok, summary) =>
        this.#publish(taskId, {
          kind: "tool_result",
          tool,
          ok,
          ...(summary !== undefined && { summary }),
        }),
      complete: async (ok, tokens) =>
        this.#publish(taskId, {
          kind: "execute_complete",
          ok,
          ...(tokens !== undefined && { tokens }),
        }),
      fail: async (reason) => this.#publish(taskId, { kind: "failed", reason }),
    };
  }

  /** Deliver `taskId`'s events to `listener` until its stream ends. */
  subscribe(taskId: string, listener: CodingStreamListener): void {
    let stream = this.#streams.get(taskId);
    if (!stream) {
      stream = { listeners: new Set(), endedAtLastSweep: false };
      this.#streams.set(taskId, stream);
    }
    stream.listeners.add(listener);
  }

  /** The tasks the registry holds — what a sweep asks the database about. */
  taskIds(): ReadonlyArray<string> {
    return [...this.#streams.keys()];
  }

  /**
   * Release every task in `ended`, the held tasks the database reports
   * terminal or gone, that the previous sweep also found ended. Returns how
   * many were released.
   */
  sweep(ended: ReadonlySet<string>): number {
    let released = 0;
    for (const taskId of ended) {
      const stream = this.#streams.get(taskId);
      if (!stream) continue;
      if (stream.endedAtLastSweep) {
        this.#streams.delete(taskId);
        released++;
      } else {
        stream.endedAtLastSweep = true;
      }
    }
    return released;
  }

  #publish(taskId: string, event: CodingStreamEvent): void {
    const stream = this.#streams.get(taskId);
    if (!stream) return;
    if (endsStream(event)) this.#streams.delete(taskId);
    // A copy, so a listener that subscribes during delivery gets the next event, not this one.
    for (const listener of [...stream.listeners]) deliver(listener, event, taskId);
  }
}

function endsStream(event: CodingStreamEvent): boolean {
  return event.kind === "failed" || (event.kind === "execute_complete" && event.ok);
}

function deliver(listener: CodingStreamListener, event: CodingStreamEvent, taskId: string): void {
  try {
    const result = listener(event);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        log.warn({ err, taskId, eventKind: event.kind }, "coding stream listener rejected");
      });
    }
  } catch (err) {
    log.warn({ err, taskId, eventKind: event.kind }, "coding stream listener threw");
  }
}
