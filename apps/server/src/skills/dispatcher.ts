import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";
import {
  type CtxCall,
  type CtxResult,
  type HostMessage,
  type TaskInvoke,
  type WorkerMessage,
  WorkerMessageSchema,
} from "./protocol.js";
import {
  type Effect,
  type Handshake,
  type StartFailure,
  type TaskOutcome,
  transition,
  type WorkerEvent,
  type WorkerState,
  type WorkerStateKind,
} from "./worker-state.js";

const log = logger.child({ component: "skills.dispatcher" });

/**
 * One worker's channel. `messages()` yields the worker's frames, validated,
 * in arrival order. It ends when the worker closes its end or the host calls
 * `close()`, and throws when the channel fails; unless the host closed it,
 * either means the worker is gone. Iterate it once.
 */
export interface WorkerTransport {
  /** Send one frame. May throw if the channel cannot carry it; after `close()` it drops the frame. */
  send(message: HostMessage): void;
  messages(): AsyncIterable<WorkerMessage>;
  /** Stop sending and receiving. Idempotent. */
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

/** Validate a frame from a worker. Anything else is logged and dropped. */
export function parseWorkerMessage(raw: unknown): WorkerMessage | undefined {
  const parsed = WorkerMessageSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  log.warn(
    { issues: parsed.error.issues.map((i) => i.message) },
    "discarding malformed worker message",
  );
  return undefined;
}

export interface DispatcherOptions {
  transport: WorkerTransport;
  /** Judges the worker's first frame. */
  handshake: Handshake;
  /** Aborts once the worker has had long enough to complete its handshake. */
  handshakeDeadline: AbortSignal;
  /** Aborting it closes the channel. */
  signal?: AbortSignal;
  /** Bound onto every log line. */
  logContext?: Record<string, unknown>;
}

interface PendingTask {
  readonly id: string;
  readonly ctxHandler: CtxHandler;
  readonly settle: (outcome: TaskOutcome) => void;
}

/**
 * Drives one worker channel through `transition` (`worker-state.ts`): feeds
 * it the worker's frames, host commands and deadlines, and carries out the
 * effects it returns. Both tiers use it; the transport and the handshake
 * are what differ.
 */
export class Dispatcher {
  #started = Promise.withResolvers<Result<void, StartFailure>>();
  #dead = Promise.withResolvers<string>();
  /** Resolves with the reason once the channel is dead and can run no further task. */
  readonly dead = this.#dead.promise;
  #transport: WorkerTransport;
  #state: WorkerState<PendingTask>;
  #log: typeof log;
  /** Aborted on death; removes every listener the dispatcher holds. */
  #alive = new AbortController();

  private constructor(opts: DispatcherOptions) {
    this.#transport = opts.transport;
    this.#state = { kind: "starting", handshake: opts.handshake };
    this.#log = opts.logContext ? log.child(opts.logContext) : log;
  }

  /**
   * Open a worker's channel and wait for its handshake. Resolves with the
   * dispatcher once the worker is ready, or with why it never was; the
   * channel is closed by then.
   */
  static async open(opts: DispatcherOptions): Promise<Result<Dispatcher, StartFailure>> {
    const dispatcher = new Dispatcher(opts);
    dispatcher.#whenAborted(
      opts.handshakeDeadline,
      () => dispatcher.#dispatch({ type: "handshake_timed_out" }),
      dispatcher.#alive.signal,
    );
    const signal = opts.signal;
    if (signal) {
      dispatcher.#whenAborted(
        signal,
        () => dispatcher.close(describeError(signal.reason)),
        dispatcher.#alive.signal,
      );
    }
    void dispatcher.#pump();
    return (await dispatcher.#started.promise).map(() => dispatcher);
  }

  get state(): WorkerStateKind {
    return this.#state.kind;
  }

  /** Lease an idle worker for one task. False unless it is idle. */
  tryAcquire(): boolean {
    return this.#dispatch({ type: "acquire" }).isOk();
  }

  /** Return a leased worker to idle. A worker with a task on it stays held. */
  release(): void {
    this.#dispatch({ type: "release" });
  }

  /**
   * Send a task to a leased worker; `ctxHandler` serves this task's ctx calls
   * and no other's. Settles once the task's exit is confirmed or the channel
   * dies, and never rejects. Throws if the worker is not leased, which is a
   * caller bug.
   */
  invoke(
    message: TaskInvoke,
    opts: { ctxHandler: CtxHandler; deadline: AbortSignal },
  ): Promise<TaskOutcome> {
    const outcome = Promise.withResolvers<TaskOutcome>();
    /** Aborted when the task settles, which it does on every path, death included. */
    const settled = new AbortController();
    const task: PendingTask = {
      id: message.id,
      ctxHandler: opts.ctxHandler,
      settle: (result) => {
        settled.abort();
        outcome.resolve(result);
      },
    };
    const accepted = this.#dispatch({ type: "invoke", task, message });
    if (accepted.isErr()) throw new Error(`dispatcher: ${accepted.error}`);
    this.#whenAborted(
      opts.deadline,
      () => this.#dispatch({ type: "deadline_passed", task }),
      settled.signal,
    );
    return outcome.promise;
  }

  /** Close the channel. A task on it settles with `reason`. Idempotent. */
  close(reason: string): void {
    this.#dispatch({ type: "close", reason });
  }

  /**
   * Feed the worker's frames to the machine until the stream stops. A stream
   * that ends is the worker closing its output (after a host close the
   * machine is already dead and ignores it); one that throws names its own
   * reason.
   */
  async #pump(): Promise<void> {
    const reason = await this.#drain().then(() => "worker closed its output", describeError);
    this.#dispatch({ type: "channel_ended", reason });
  }

  async #drain(): Promise<void> {
    for await (const message of this.#transport.messages()) this.#dispatch(message);
  }

  /**
   * Run `event` through the machine and carry out its effects. Errs with
   * the reason when the event is a host command the state refuses.
   */
  #dispatch(event: WorkerEvent<PendingTask>): Result<void, string> {
    const { state, effects } = transition(this.#state, event);
    this.#state = state;
    // Effects run in order; events they raise go through the machine after.
    const raised: WorkerEvent<PendingTask>[] = [];
    for (const effect of effects) raised.push(...this.#execute(effect));
    for (const next of raised) this.#dispatch(next);
    const refusal = effects.find((e) => e.type === "refused");
    return refusal ? err(refusal.reason) : ok(undefined);
  }

  #execute(effect: Effect<PendingTask>): ReadonlyArray<WorkerEvent<PendingTask>> {
    return match(effect)
      .with({ type: "send" }, ({ message }) => this.#send(message))
      .with({ type: "serve" }, ({ task, call }) => {
        this.#serve(task, call);
        return [];
      })
      .with({ type: "settle" }, ({ task, outcome }) => {
        task.settle(outcome);
        return [];
      })
      .with({ type: "started" }, ({ outcome }) => {
        this.#started.resolve(outcome);
        return [];
      })
      .with({ type: "died" }, ({ reason }) => {
        this.#alive.abort();
        this.#transport.close();
        this.#dead.resolve(reason);
        return [];
      })
      .with({ type: "log" }, ({ level, message, fields }) => {
        this.#log[level](fields, message);
        return [];
      })
      .with({ type: "refused" }, () => [])
      .exhaustive();
  }

  #send(message: HostMessage): ReadonlyArray<WorkerEvent<PendingTask>> {
    try {
      this.#transport.send(message);
      return [];
    } catch (e) {
      return [{ type: "send_failed", reason: `${message.type} send failed: ${describeError(e)}` }];
    }
  }

  /**
   * Serve one ctx call. The awaitable lives on the worker side, blocked on
   * the matching `ctx_result`; a handler that throws answers with
   * `ok: false`. The reply goes back through the machine, which sends it
   * only if the task is still running.
   */
  #serve(task: PendingTask, call: CtxCall): void {
    const frame = { type: "ctx_result", taskId: task.id, id: call.id } as const;
    void Promise.resolve()
      .then(() => task.ctxHandler.handle({ method: call.method, args: call.args }))
      .then(
        (value): CtxResult => ({ ...frame, ok: true, value }),
        (e: unknown): CtxResult => ({
          ...frame,
          ok: false,
          ...(e instanceof CtxError
            ? { errorKind: e.kind, message: e.message }
            : { errorKind: "internal", message: describeError(e) }),
        }),
      )
      .then((reply) => {
        this.#dispatch({ type: "ctx_replied", task, reply });
      });
  }

  /** Call `fn` once `signal` aborts, unless `until` aborts first. */
  #whenAborted(signal: AbortSignal, fn: () => void, until: AbortSignal): void {
    if (until.aborted) return;
    if (signal.aborted) fn();
    else signal.addEventListener("abort", fn, { once: true, signal: until });
  }
}
