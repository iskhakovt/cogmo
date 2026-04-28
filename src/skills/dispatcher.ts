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
  ctxHandler: CtxHandler;
}

/**
 * Drives a single task to completion over a transport. Sends one
 * `task_invoke`, awaits the matching `task_result`, and services every
 * `ctx_call` the worker issues mid-task by routing to the host's
 * `CtxHandler`. Multiple ctx calls may be in flight concurrently — the
 * dispatcher correlates by `id`.
 */
export class Dispatcher {
  #transport: RpcTransport;
  #ctxHandler: CtxHandler;
  #pendingTask: {
    id: string;
    resolve: (result: TaskResult) => void;
    reject: (e: Error) => void;
  } | null = null;
  #closed = false;

  constructor(opts: DispatcherOptions) {
    this.#transport = opts.transport;
    this.#ctxHandler = opts.ctxHandler;
    this.#transport.onMessage((raw) => this.#onMessage(raw));
  }

  /** Send a `task_invoke` and resolve when the matching `task_result` arrives. */
  invoke(invoke: TaskInvoke): Promise<TaskResult> {
    if (this.#pendingTask) {
      throw new Error("dispatcher already has an in-flight task — one task per dispatcher");
    }
    if (this.#closed) {
      throw new Error("dispatcher is closed");
    }
    const promise = new Promise<TaskResult>((resolve, reject) => {
      this.#pendingTask = { id: invoke.id, resolve, reject };
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
      log.warn(
        { expected: pending.id, got: message.id },
        "task_result id does not match in-flight task",
      );
      return;
    }
    this.#pendingTask = null;
    pending.resolve(message);
  }

  async #handleCtxCall(call: CtxCall): Promise<void> {
    let response: CtxResult;
    try {
      const value = await this.#ctxHandler.handle({ method: call.method, args: call.args });
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
    this.#transport.postMessage(response);
  }
}
