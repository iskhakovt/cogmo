import { logger } from "../logger.js";
import {
  type CtxCall,
  type CtxResult,
  type TaskExited,
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
   * cannot deliver any more messages (line-framing overflow, the worker
   * closing its output, underlying stream error). Transports without a
   * meaningful error path (e.g. the in-process Pyodide MessagePort adapter,
   * where the worker thread's error flows up via the host's own
   * worker.on('error') handler) may leave this unimplemented. When set, the
   * Dispatcher uses it to reject the pending task immediately so the caller
   * doesn't sit on the wall-clock timeout for a transport that already gave
   * up.
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
   * Settle each task on the supervisor's `task_exited` rather than on its
   * `task_result`. The Tier 2 worker sets it: it is reusable only once the
   * supervisor has killed and reaped every process the task started. The
   * Tier 1 worker is torn down with its task, so it settles on the result.
   */
  awaitTaskExited: boolean;
}

interface InFlightTask {
  id: string;
  ctxHandler: CtxHandler;
  /** Set when the task's `task_result` arrives; from then on it serves no ctx calls. */
  result: TaskResult | undefined;
  resolve: (result: TaskResult) => void;
  reject: (e: Error) => void;
}

/**
 * Drives skill tasks to completion over a transport, one task at a time.
 * For each task: sends `task_invoke`, services the task's `ctx_call`s with
 * the handler passed to `invoke()`, and settles on the task's `task_result`
 * (or, with `awaitTaskExited`, on its `task_exited`). Multiple ctx calls may
 * be in flight concurrently within a task — the dispatcher correlates them
 * by the ctx_call's `id`.
 *
 * A ctx call is served only while its task is running: it must name the
 * in-flight task, and that task must not have returned its result yet.
 * Anything else — a late call from a finished task, a call naming another
 * task, a call with no task in flight — is refused and logged. There is no
 * fallback handler.
 *
 * The transport outlives tasks: after a task settles the dispatcher is ready
 * for the next `invoke()`. `close()` is the boundary.
 */
export class Dispatcher {
  #transport: RpcTransport;
  #awaitTaskExited: boolean;
  #task: InFlightTask | null = null;
  #closed = false;

  constructor(opts: DispatcherOptions) {
    this.#transport = opts.transport;
    this.#awaitTaskExited = opts.awaitTaskExited;
    this.#transport.onMessage((raw) => this.#onMessage(raw));
    this.#transport.onError?.((err) => this.#onTransportError(err));
  }

  #onTransportError(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const task = this.#task;
    this.#task = null;
    log.warn({ err: err.message }, "transport reported fatal error — rejecting pending task");
    // The transport already closed itself by reporting fatal.
    task?.reject(new Error(`dispatcher: transport error: ${err.message}`));
  }

  /**
   * Send a `task_invoke` and resolve when the task settles. `ctxHandler`
   * serves this task's ctx calls and nothing else.
   */
  invoke(invoke: TaskInvoke, opts: { ctxHandler: CtxHandler }): Promise<TaskResult> {
    if (this.#task) {
      throw new Error("dispatcher already has an in-flight task — one task at a time");
    }
    if (this.#closed) {
      throw new Error("dispatcher is closed");
    }
    const promise = new Promise<TaskResult>((resolve, reject) => {
      this.#task = {
        id: invoke.id,
        ctxHandler: opts.ctxHandler,
        result: undefined,
        resolve,
        reject,
      };
    });
    try {
      this.#transport.postMessage(invoke);
    } catch (e) {
      // Roll back so a subsequent `close()` doesn't reject a promise the
      // caller never observed (they got the synchronous exception instead).
      this.#task = null;
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
    const task = this.#task;
    this.#task = null;
    task?.reject(new Error(`dispatcher ${reason}`));
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
      case "task_exited":
        this.#handleTaskExited(message);
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

  /**
   * The worker named a different task than the one in flight: it is in an
   * inconsistent state. Fail the task now rather than on the wall clock.
   */
  #rejectMismatch(task: InFlightTask, kind: "task_result" | "task_exited", got: string): void {
    log.warn({ expected: task.id, got }, `${kind} id does not match in-flight task — rejecting`);
    this.#task = null;
    task.reject(new Error(`dispatcher: ${kind} id mismatch (expected ${task.id}, got ${got})`));
  }

  #handleTaskResult(message: TaskResult): void {
    const task = this.#task;
    if (!task) {
      log.warn({ id: message.id }, "received task_result with no pending task");
      return;
    }
    if (task.id !== message.id) {
      this.#rejectMismatch(task, "task_result", message.id);
      return;
    }
    if (task.result !== undefined) {
      log.warn({ id: message.id }, "duplicate task_result — keeping the first");
      return;
    }
    task.result = message;
    if (!this.#awaitTaskExited) {
      this.#task = null;
      task.resolve(message);
    }
  }

  #handleTaskExited(message: TaskExited): void {
    const task = this.#task;
    if (!this.#awaitTaskExited || !task) {
      log.warn({ id: message.id }, "received task_exited with no task awaiting it");
      return;
    }
    if (task.id !== message.id) {
      this.#rejectMismatch(task, "task_exited", message.id);
      return;
    }
    this.#task = null;
    // Without a result, the task's relay died before forwarding one; its
    // processes are gone all the same, so the worker stays reusable.
    task.resolve(
      task.result ?? {
        type: "task_result",
        id: task.id,
        ok: false,
        error: "task_exited_without_result",
      },
    );
  }

  async #handleCtxCall(call: CtxCall): Promise<void> {
    const task = this.#task;
    if (!task || task.result !== undefined || task.id !== call.taskId) {
      log.warn(
        {
          ctxId: call.id,
          method: call.method,
          taskId: call.taskId,
          running: task && task.result === undefined ? task.id : null,
        },
        "refusing ctx_call from a task that is not running",
      );
      return;
    }
    let response: CtxResult;
    try {
      const value = await task.ctxHandler.handle({ method: call.method, args: call.args });
      response = { type: "ctx_result", taskId: task.id, id: call.id, ok: true, value };
    } catch (e) {
      response = {
        type: "ctx_result",
        taskId: task.id,
        id: call.id,
        ok: false,
        ...(e instanceof CtxError
          ? { errorKind: e.kind, message: e.message }
          : { errorKind: "internal", message: e instanceof Error ? e.message : String(e) }),
      };
    }
    if (this.#task !== task || task.result !== undefined) {
      // The task finished while its call was being served; nothing is left
      // to read the reply.
      log.debug({ ctxId: call.id, taskId: task.id }, "dropping ctx_result for a finished task");
      return;
    }
    try {
      this.#transport.postMessage(response);
    } catch (e) {
      // Send failed (port closed mid-task, e.g.). Surface as a task failure
      // so `invoke()` rejects rather than hanging on the worker awaiting a
      // ctx_result that never arrives.
      const sendError = e instanceof Error ? e.message : String(e);
      log.warn({ ctxId: call.id, err: sendError }, "ctx_result send failed");
      this.#task = null;
      task.reject(new Error(`dispatcher: ctx_result send failed: ${sendError}`));
    }
  }
}
