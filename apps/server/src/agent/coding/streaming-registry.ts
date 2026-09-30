import { logger } from "../../logger.js";
import type { ExecuteStreamHandle, PlanStreamHandle } from "./progress-stream.js";

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

export interface CodingStreamingRegistryOptions {
  /** Which of `taskIds` have ended: a terminal status, or no row. See `findEndedCodingTasks`. */
  endedTasks: (taskIds: ReadonlyArray<string>) => Promise<ReadonlySet<string>>;
  /** How often the registry asks `endedTasks` about the tasks it holds. */
  sweepIntervalMs: number;
  /** Test seam — replace the timer. Defaults to an unref'd `setInterval` / `clearInterval`. */
  setInterval?: (tick: () => Promise<void>, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface TaskStream {
  readonly listeners: Set<CodingStreamListener>;
  /** The previous sweep found the task ended. */
  endedAtLastSweep: boolean;
}

/**
 * In-process fan-out of each coding task's progress, from the orchestrators'
 * handles to the subscribers. See design/coding-delegation.md → Progress
 * stream.
 *
 * - A task is held only while something is subscribed to it. A publish to a
 *   task with no subscriber is dropped.
 * - `failed`, and an `execute_complete` reporting success, end the stream:
 *   the registry releases the task, then delivers the event to the
 *   subscribers it had.
 * - A sweep releases a task the database reports ended at two consecutive
 *   sweeps. A failed sweep changes nothing.
 * - A listener's throw or rejection is logged, and reaches neither the
 *   publisher nor its siblings. No listener is awaited.
 */
export class CodingStreamingRegistry {
  readonly #streams = new Map<string, TaskStream>();
  readonly #endedTasks: CodingStreamingRegistryOptions["endedTasks"];
  readonly #clearInterval: (handle: unknown) => void;
  #timer: unknown = null;
  #closed = false;

  private constructor(opts: CodingStreamingRegistryOptions) {
    this.#endedTasks = opts.endedTasks;
    this.#clearInterval =
      opts.clearInterval ??
      // Paired with the default `setInterval` in `create`, whose handle this
      // gets back; the seam types it `unknown` so a test's timer can use any token.
      ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** A registry that sweeps every `sweepIntervalMs` until `close()`. */
  static create(opts: CodingStreamingRegistryOptions): CodingStreamingRegistry {
    const registry = new CodingStreamingRegistry(opts);
    const setTimer =
      opts.setInterval ??
      ((tick: () => Promise<void>, ms: number): unknown => {
        const handle = setInterval(() => void tick(), ms);
        // The sweep holds nothing that needs closing, so it never keeps the process alive.
        handle.unref();
        return handle;
      });
    registry.#timer = setTimer(() => registry.#sweep(), opts.sweepIntervalMs);
    return registry;
  }

  /** Stop sweeping. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearInterval(this.#timer);
  }

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

  /** The execute orchestrator's handle for `taskId`. */
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

  /**
   * Ask the database which held tasks have ended, and release those the
   * previous sweep also found ended.
   */
  async #sweep(): Promise<void> {
    const held = [...this.#streams.keys()];
    if (held.length === 0) return;
    let ended: ReadonlySet<string>;
    try {
      ended = await this.#endedTasks(held);
    } catch (err) {
      log.warn({ err, held: held.length }, "coding stream sweep failed");
      return;
    }
    let released = 0;
    for (const taskId of ended) {
      const stream = this.#streams.get(taskId);
      // Its own event released it while the lookup ran.
      if (!stream) continue;
      if (stream.endedAtLastSweep) {
        this.#streams.delete(taskId);
        released++;
      } else {
        stream.endedAtLastSweep = true;
      }
    }
    if (released > 0) log.info({ released }, "released the streams of ended coding tasks");
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
