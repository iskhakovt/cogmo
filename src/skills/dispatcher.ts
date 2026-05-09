import { logger } from "../logger.js";
import {
  type CtxCall,
  type CtxResult,
  type TaskInvoke,
  type TaskResult,
  WorkerMessageSchema,
} from "./protocol.js";

const log = logger.child({ component: "skills.dispatcher" });

/**
 * Transport contract — same shape `MessagePort` exposes natively. The Tier 2
 * (NDJSON over stdio) worker plugs in by providing a thin wrapper that frames
 * lines and dispatches to a single `message` handler.
 */
export interface RpcTransport {
  postMessage(message: unknown): void;
  /** Receive parsed messages. Same callback shape `MessagePort.on('message', …)` uses. */
  onMessage(handler: (message: unknown) => void): void;
  /**
   * Subscribe to fatal transport errors — conditions where the transport
   * cannot deliver any more messages (line-framing overflow, underlying
   * stream error, etc.). Distinct from normal close: transports that don't
   * have a meaningful error path (e.g. the in-process Pyodide MessagePort
   * adapter, where the worker thread's error flows up via the host's own
   * worker.on('error') handler) may leave this unimplemented. When set,
   * the Dispatcher uses it to reject the pending task immediately so the
   * caller doesn't sit on the wall-clock timeout for a transport that
   * already gave up.
   */
  onError?(handler: (err: Error) => void): void;
  close(): void;
}

/**
 * Host-side handler for `ctx_call` RPCs the worker emits mid-task. Implemented
 * by `DefaultCtxHandler` — see `src/skills/ctx-handler.ts`.
 */
export interface CtxHandler {
  /**
   * Resolve a single ctx_call. Return `{ ok: true, value }` on success, or
   * throw a `CtxError` to surface a typed Python exception in the worker.
   */
  handle(call: { method: string; args: unknown }): Promise<unknown>;
}

/**
 * Typed error a `CtxHandler` may throw to surface a specific Python exception
 * class to the caller. Maps to the `errorKind` field on `ctx_result`.
 */
export class CtxError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
    this.name = `CtxError(${kind})`;
  }
}

export interface DispatcherOptions {
  transport: RpcTransport;
  /**
   * Default ctx handler for `invoke()` calls that don't pass one
   * explicitly. Tier 1 (one dispatcher per task) wires it once at
   * construction. Tier 2 supervisor workers (one dispatcher reused across
   * many tasks) pass a fresh handler per `invoke()` call so each task
   * carries its own per-run audit hooks; the constructor default is then
   * unused but still required for a sane no-arg `invoke()`.
   */
  ctxHandler: CtxHandler;
}

/**
 * Drives skill tasks to completion over a transport. One in-flight task at a
 * time (sequential — the tier-2 supervisor protocol is "one task per
 * worker"). For each task: sends `task_invoke`, awaits the matching
 * `task_result`, and services every `ctx_call` the worker issues mid-task by
 * routing to the in-flight task's `CtxHandler`. Multiple ctx calls may be in
 * flight concurrently within a single task — the dispatcher correlates by
 * the ctx_call's `id`.
 *
 * Reuse-across-tasks: after a `task_result` resolves an `invoke()`, the
 * dispatcher is ready for the next `invoke()`. The transport is preserved.
 * `close()` is the boundary — only the worker's disposal calls it. This
 * lets a long-lived python supervisor accept many sequential task_invokes
 * without rebuilding the transport.
 */
export class Dispatcher {
  #transport: RpcTransport;
  #defaultCtxHandler: CtxHandler;
  #pendingTask: {
    id: string;
    ctxHandler: CtxHandler;
    resolve: (result: TaskResult) => void;
    reject: (e: Error) => void;
  } | null = null;
  #closed = false;

  constructor(opts: DispatcherOptions) {
    this.#transport = opts.transport;
    this.#defaultCtxHandler = opts.ctxHandler;
    this.#transport.onMessage((raw) => this.#onMessage(raw));
    this.#transport.onError?.((err) => this.#onTransportError(err));
  }

  #onTransportError(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#pendingTask;
    this.#pendingTask = null;
    log.warn({ err: err.message }, "transport reported fatal error — rejecting pending task");
    pending?.reject(new Error(`dispatcher: transport error: ${err.message}`));
    // Don't call transport.close() here — the transport already closed itself
    // by reporting fatal. Calling close again would just be a no-op given
    // the closed flag, but it would also be an unnecessary nesting of the
    // close path during error propagation.
  }

  /**
   * Send a `task_invoke` and resolve when the matching `task_result` arrives.
   * `opts.ctxHandler` overrides the constructor default for this task only —
   * tier-2 supervisor workers use this to scope the run id / audit hooks per
   * task on a shared dispatcher.
   */
  invoke(invoke: TaskInvoke, opts?: { ctxHandler?: CtxHandler }): Promise<TaskResult> {
    if (this.#pendingTask) {
      throw new Error("dispatcher already has an in-flight task — one task at a time");
    }
    if (this.#closed) {
      throw new Error("dispatcher is closed");
    }
    const ctxHandler = opts?.ctxHandler ?? this.#defaultCtxHandler;
    const promise = new Promise<TaskResult>((resolve, reject) => {
      this.#pendingTask = { id: invoke.id, ctxHandler, resolve, reject };
    });
    try {
      this.#transport.postMessage(invoke);
    } catch (e) {
      // Roll back the pending task so a subsequent `close()` doesn't reject
      // a promise the caller never observed (postMessage threw, the caller
      // got the synchronous exception, not the promise).
      this.#pendingTask = null;
      throw e;
    }
    return promise;
  }

  /**
   * Tear down the transport. Any in-flight task is rejected with
   * `dispatcher closed`; subsequent `invoke` calls throw synchronously.
   */
  close(reason = "closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pendingTask) {
      this.#pendingTask.reject(new Error(`dispatcher ${reason}`));
      this.#pendingTask = null;
    }
    this.#transport.close();
  }

  #onMessage(raw: unknown): void {
    const parsed = WorkerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(
        { issues: parsed.error.issues.map((i) => i.message) },
        "discarding malformed worker message",
      );
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "task_result":
        this.#handleTaskResult(message);
        return;
      case "ctx_call":
        // Fire-and-forget — the awaitable lives on the worker side, blocked
        // on the matching ctx_result. Errors thrown during handling are
        // surfaced to the worker as `ctx_result.ok = false`, never as host
        // exceptions.
        void this.#handleCtxCall(message);
        return;
      case "task_invoke":
      case "ctx_result":
        log.warn({ type: message.type }, "received host-bound message from worker — ignoring");
        return;
    }
  }

  #handleTaskResult(message: TaskResult): void {
    const pending = this.#pendingTask;
    if (!pending) {
      log.warn({ id: message.id }, "received task_result with no pending task");
      return;
    }
    if (pending.id !== message.id) {
      // The worker is in an inconsistent state — surface it as a task
      // failure rather than waiting for the wall-clock timeout. Logging-
      // and-returning would leave `invoke()` hanging forever.
      log.warn(
        { expected: pending.id, got: message.id },
        "task_result id does not match in-flight task — rejecting",
      );
      this.#pendingTask = null;
      pending.reject(
        new Error(
          `dispatcher: task_result id mismatch (expected ${pending.id}, got ${message.id})`,
        ),
      );
      return;
    }
    this.#pendingTask = null;
    pending.resolve(message);
  }

  async #handleCtxCall(call: CtxCall): Promise<void> {
    // Capture the in-flight task's ctxHandler at dispatch time. If the task
    // resolves between the ctx_call landing and the handler running, the
    // captured reference is still the right one for this call.
    const pending = this.#pendingTask;
    const ctxHandler = pending?.ctxHandler ?? this.#defaultCtxHandler;
    let response: CtxResult;
    try {
      const value = await ctxHandler.handle({ method: call.method, args: call.args });
      response = { type: "ctx_result", id: call.id, ok: true, value };
    } catch (e) {
      if (e instanceof CtxError) {
        response = {
          type: "ctx_result",
          id: call.id,
          ok: false,
          errorKind: e.kind,
          message: e.message,
        };
      } else {
        const message = e instanceof Error ? e.message : String(e);
        response = {
          type: "ctx_result",
          id: call.id,
          ok: false,
          errorKind: "internal",
          message,
        };
      }
    }
    try {
      this.#transport.postMessage(response);
    } catch (e) {
      // Send failed (port closed mid-task, e.g.). Surface as a task failure
      // so `invoke()` rejects rather than hanging on the worker awaiting a
      // ctx_result that never arrives.
      const sendError = e instanceof Error ? e.message : String(e);
      log.warn({ ctxId: call.id, err: sendError }, "ctx_result send failed");
      const stillPending = this.#pendingTask;
      if (stillPending) {
        this.#pendingTask = null;
        stillPending.reject(new Error(`dispatcher: ctx_result send failed: ${sendError}`));
      }
    }
  }
}
