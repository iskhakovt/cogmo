import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";
import {
  type CtxCall,
  type CtxResult,
  type HostMessage,
  type TaskInvoke,
  WorkerMessageSchema,
} from "./protocol.js";
import {
  type Admission,
  admits,
  type Command,
  command,
  type Effect,
  type Fact,
  type Handshake,
  observe,
  type StartFailure,
  type TaskOutcome,
  type Transition,
  type WorkerFrame,
  type WorkerState,
  type WorkerStateKind,
} from "./worker-state.js";

const log = logger.child({ component: "skills.dispatcher" });

/**
 * One worker's channel. `messages()` yields the worker's frames in arrival
 * order, each validated: a worker message, or a malformed frame. It ends
 * when the worker closes its end or the host calls `close()`, and throws
 * when the channel fails; unless the host closed it, either means the
 * worker is gone. Iterate it once.
 */
export interface WorkerTransport {
  /** Send one frame. May throw if the channel cannot carry it; after `close()` it drops the frame. */
  send(message: HostMessage): void;
  messages(): AsyncIterable<WorkerFrame>;
  /** Stop sending and receiving. Idempotent. */
  close(): void;
}

/**
 * Host-side handler for `ctx_call` RPCs the worker emits mid-task. Implemented
 * by `DefaultCtxHandler` — see `src/skills/ctx-handler.ts`.
 */
export interface CtxHandler {
  /**
   * Resolve a single ctx_call with the call's value, or throw a `CtxError`
   * to surface a typed Python exception in the worker.
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

/** Validate a frame from a worker. The machine decides what a malformed one means. */
export function parseWorkerFrame(raw: unknown): WorkerFrame {
  const parsed = WorkerMessageSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : { type: "malformed", issues: parsed.error.issues.map((i) => i.message) };
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
 * Drives one worker channel through its machine (`worker-state.ts`): puts
 * host commands to `command` and the worker's frames, deadlines and channel
 * facts to `observe`, and carries out the effects they return. Both tiers
 * use it; the transport and the handshake are what differ.
 */
export class Dispatcher {
  #started = Promise.withResolvers<Result<void, StartFailure>>();
  #dead = Promise.withResolvers<string>();
  #disposable = Promise.withResolvers<void>();
  /** Resolves with the reason once the channel is dead and can run no further task. */
  readonly dead = this.#dead.promise;
  /** Resolves once the channel is dead and no caller holds it. */
  readonly disposable = this.#disposable.promise;
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
      () => dispatcher.#observe({ type: "handshake_timed_out" }),
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

  /** Whether the worker takes a task now, and how; see `admits`. */
  admission(): Result<Admission, string> {
    return admits(this.#state);
  }

  /** Lease an idle worker for one task. False unless it is idle. */
  tryAcquire(): boolean {
    return this.#command({ type: "acquire" }).isOk();
  }

  /**
   * Give back a worker this caller holds: a leased one goes idle, a dead one
   * becomes disposable. False otherwise — a task on it keeps it held.
   */
  release(): boolean {
    return this.#command({ type: "release" }).isOk();
  }

  /**
   * Send a task to a leased worker; `ctxHandler` serves this task's ctx calls
   * and no other's. Settles once the task's exit is confirmed or the channel
   * dies, and never rejects. Throws if the worker is live but not leased,
   * which is a caller bug; on a dead worker the task fails as a value.
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
    const accepted = this.#command({ type: "invoke", task, message });
    if (accepted.isErr()) throw new Error(`dispatcher: ${accepted.error}`);
    this.#whenAborted(
      opts.deadline,
      () => this.#observe({ type: "deadline_passed", task }),
      settled.signal,
    );
    return outcome.promise;
  }

  /** Close the channel. A task on it settles with `reason`. Idempotent. */
  close(reason: string): void {
    this.#observe({ type: "close", reason });
  }

  /**
   * Feed the worker's frames to the machine until the stream stops. A stream
   * that ends is the worker closing its output (after a host close the
   * machine is already dead and ignores it); one that throws names its own
   * reason.
   */
  async #pump(): Promise<void> {
    const reason = await this.#drain().then(() => "worker closed its output", describeError);
    this.#observe({ type: "channel_ended", reason });
  }

  async #drain(): Promise<void> {
    for await (const frame of this.#transport.messages()) this.#observe(frame);
  }

  /** Carry out a host command, or err with why the state refuses it. */
  #command(cmd: Command<PendingTask>): Result<void, string> {
    const next = command(this.#state, cmd);
    if (next.isErr()) return err(next.error);
    this.#enter(next.value);
    return ok(undefined);
  }

  #observe(fact: Fact<PendingTask>): void {
    this.#enter(observe(this.#state, fact));
  }

  /** Move to the next state and carry out its effects, in order; facts they raise follow. */
  #enter(next: Transition<PendingTask>): void {
    this.#state = next.state;
    const raised = next.effects.flatMap((effect) => this.#execute(effect));
    for (const followUp of raised) this.#observe(followUp);
  }

  #execute(effect: Effect<PendingTask>): ReadonlyArray<Fact<PendingTask>> {
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
      .with({ type: "disposable" }, () => {
        this.#disposable.resolve();
        return [];
      })
      .with({ type: "log" }, ({ level, message, fields }) => {
        this.#log[level](fields, message);
        return [];
      })
      .exhaustive();
  }

  #send(message: HostMessage): ReadonlyArray<Fact<PendingTask>> {
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
        this.#observe({ type: "ctx_replied", task, reply });
      });
  }

  /** Call `fn` once `signal` aborts, unless `until` aborts first. */
  #whenAborted(signal: AbortSignal, fn: () => void, until: AbortSignal): void {
    if (until.aborted) return;
    if (signal.aborted) fn();
    else signal.addEventListener("abort", fn, { once: true, signal: until });
  }
}
