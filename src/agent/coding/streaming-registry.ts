import { EventEmitter } from "node:events";

/**
 * Generic reference to a chat message Cogmo has already posted and edits in
 * place as the task progresses. Stringly-typed for portability — Telegram
 * uses integers, but Slack/Discord/etc. use snowflakes/timestamps; the
 * adapter coerces.
 */
export interface ProgressMessageRef {
  channelId: string; // cogmo `channels.id`
  chatId: string; // platform-side chat/conversation id
  messageId: string; // platform-side message id
}

/**
 * Events the orchestrator publishes per task while the CLI is streaming.
 * Mirrors the meaningful subset of `CodingEvent`, flattened for consumers
 * that just need to render progress (not parse tool-use semantics).
 */
export type CodingStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; tool: string }
  | { kind: "tool_result"; tool: string; ok: boolean; summary?: string }
  | { kind: "plan_finalized"; plan: string }
  | { kind: "execute_started" }
  | { kind: "execute_complete"; ok: boolean; tokens?: { input: number; output: number } }
  | { kind: "failed"; reason: string };

/**
 * Snapshot of the per-task state the registry holds. Returned to consumers
 * so a late subscriber can render the message body it would have built had
 * it been listening from the start.
 */
export interface CodingStreamSnapshot {
  /** Accumulated text deltas (plan body during plan phase, narration during execute). */
  accumulatedText: string;
  /** Set once the Telegram (or other) adapter has posted the progress message. */
  progressMessageRef: ProgressMessageRef | null;
}

export type CodingStreamListener = (event: CodingStreamEvent) => void;
export type CodingStreamUnsubscribe = () => void;

interface TaskState {
  emitter: EventEmitter;
  accumulatedText: string;
  progressMessageRef: ProgressMessageRef | null;
}

const STREAM_EVENT = "stream";

/**
 * Bridge between the durable orchestrator (publisher) and the turn-bound
 * delivery layer (subscriber).
 *
 * Why in-process and not Inngest events: text deltas land at chat-cadence
 * (one event per few characters). Routing each through a workflow event bus
 * costs serialize + persist + dispatch overhead per delta and floods the
 * Inngest dashboard. Cogmo is single-node; the orchestrator and the
 * Telegram adapter live in the same process, so a Node `EventEmitter` is
 * the right primitive — same pattern `DeliveryRouter` uses for chat
 * streaming. Inngest events stay in use for state transitions
 * (`task/start`, `plan-approved`, `completed`) where durability and
 * cross-process delivery matter.
 *
 * Lifecycle: `getOrCreate(taskId)` is implicit on first publish/subscribe;
 * call `dispose(taskId)` once the task reaches a terminal state to free
 * the per-task state and detach all listeners. Re-publishing after dispose
 * implicitly creates a fresh state entry — the registry doesn't try to
 * prevent that, since the orchestrator is the sole authority on lifecycle.
 *
 * Late-subscriber semantics: events emitted before `subscribe()` are NOT
 * replayed. Consumers that need the buffered body (typical: the Telegram
 * adapter rebuilding the progress message after reconnect) should read
 * `getSnapshot()` and combine it with the live event stream.
 */
export class CodingStreamingRegistry {
  readonly #states = new Map<string, TaskState>();

  /**
   * Emit `event` to all current subscribers of `taskId`. For text events,
   * also append to the accumulated text snapshot. No-op listener invocation
   * if no one is subscribed — but text accumulation still happens, so a
   * subscriber that attaches mid-stream can read the buffered text via
   * `getSnapshot()`.
   */
  publish(taskId: string, event: CodingStreamEvent): void {
    const state = this.#getOrCreate(taskId);
    if (event.kind === "text") state.accumulatedText += event.delta;
    if (event.kind === "plan_finalized") state.accumulatedText = event.plan;
    state.emitter.emit(STREAM_EVENT, event);
  }

  /** Subscribe to live events for `taskId`. Returns an unsubscribe function. */
  subscribe(taskId: string, listener: CodingStreamListener): CodingStreamUnsubscribe {
    const state = this.#getOrCreate(taskId);
    state.emitter.on(STREAM_EVENT, listener);
    return () => state.emitter.off(STREAM_EVENT, listener);
  }

  /**
   * Snapshot of accumulated state. Returns null if the task has no entry —
   * either it was never started or it's been disposed. Returned object is a
   * defensive copy; mutating it does not affect the registry.
   */
  getSnapshot(taskId: string): CodingStreamSnapshot | null {
    const state = this.#states.get(taskId);
    if (!state) return null;
    return {
      accumulatedText: state.accumulatedText,
      progressMessageRef: state.progressMessageRef ? { ...state.progressMessageRef } : null,
    };
  }

  /**
   * Record the platform-side reference to the progress message once the
   * adapter has posted it. Consumers reading `getSnapshot()` after this
   * call see the ref; subscribers do not get a separate event.
   */
  setProgressMessageRef(taskId: string, ref: ProgressMessageRef): void {
    const state = this.#getOrCreate(taskId);
    state.progressMessageRef = { ...ref };
  }

  /**
   * Tear down per-task state and detach every subscriber. Idempotent — a
   * second dispose on the same taskId is a no-op.
   */
  dispose(taskId: string): void {
    const state = this.#states.get(taskId);
    if (!state) return;
    state.emitter.removeAllListeners(STREAM_EVENT);
    this.#states.delete(taskId);
  }

  /** Number of tasks currently held — exposed for tests + diagnostics. */
  size(): number {
    return this.#states.size;
  }

  #getOrCreate(taskId: string): TaskState {
    let state = this.#states.get(taskId);
    if (!state) {
      state = {
        emitter: new EventEmitter(),
        accumulatedText: "",
        progressMessageRef: null,
      };
      // Allow many subscribers without Node's "MaxListenersExceededWarning"
      // — practically there's only ever 1 (the Telegram delivery side), but
      // tests subscribe multiple listeners and the warning is just noise.
      state.emitter.setMaxListeners(0);
      this.#states.set(taskId, state);
    }
    return state;
  }
}
