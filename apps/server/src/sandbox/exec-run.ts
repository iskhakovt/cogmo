import { finished, PassThrough, Writable } from "node:stream";
import { ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../logger.js";
import type { ExecFailure, ExecOptions, ExecStreamingHandle } from "./exec.js";
import { execFailureError, unwrapExit } from "./exec.js";
import {
  begin,
  type ExecEffect,
  type ExecEvent,
  type ExecOutcome,
  type ExecRunState,
  type ExecStreamName,
  type ExecTransition,
  transition,
} from "./exec-state.js";

const log = logger.child({ component: "sandbox.exec" });

/** How long a teardown may take before the run gives up on it. */
export const TEARDOWN_TIMEOUT_MS = 10_000;

/** Where a backend delivers what its transport carries. */
export interface ExecSink {
  output(stream: ExecStreamName, chunk: Buffer): void;
  /** The output stream ended: the command exited, or its transport closed. */
  ended(): void;
  failed(error: unknown): void;
}

/** A started command: its stdin, on a backend that streams one. */
export interface ExecStarted {
  stdin?: Writable;
}

/**
 * One exec on one backend: how to start the command, read its exit code and
 * release what it holds. `ExecRun` decides when each runs. A backend is
 * single-use and may keep state between the calls.
 */
export interface ExecBackend {
  /**
   * Whether the backend needs the caller's whole stdin before it can start
   * the command. The run then exposes a buffering `stdin` and starts once
   * it ends.
   */
  readonly buffersStdin: boolean;
  /** Bound onto the run's log lines. */
  readonly logFields: Record<string, unknown>;
  /**
   * Start the command, delivering its output, and then the end or failure
   * of its output stream, to `sink`. Resolves once the command runs, with
   * its stdin if the backend streams one. `stdin` is the buffered payload
   * when `buffersStdin`. `signal` aborts once the run has settled: a start
   * still in flight stops before its next remote step.
   */
  start(sink: ExecSink, stdin: Buffer | undefined, signal: AbortSignal): Promise<ExecStarted>;
  /** Once the output has ended: the exit code, or why there is none. */
  fetchExit(): Promise<Result<number, string>>;
  /**
   * Release what `start` acquired so far. Runs when the run settles, and
   * again for a start that finishes after it. Aborting `signal` means the
   * run has stopped waiting for it.
   */
  teardown(signal: AbortSignal): Promise<void>;
}

/**
 * Run one exec through its lifecycle (`exec-state.ts`) on `backend`.
 * Resolves with the handle once the command runs, or at once for a backend
 * that buffers stdin, whose start follows the caller's `stdin.end()`. A run
 * that settles before its handle is out rejects with what `wait()` would
 * throw.
 */
export function runExec(backend: ExecBackend, opts: ExecOptions): Promise<ExecStreamingHandle> {
  return new ExecRun(backend, opts).open();
}

class ExecRun {
  #backend: ExecBackend;
  #opts: ExecOptions;
  #state: ExecRunState;
  #log: typeof log;
  #stdout = new PassThrough();
  #stderr = new PassThrough();
  /** The buffering stdin of a backend that `buffersStdin`, or the backend's own once started. */
  #stdin: Writable | undefined;
  #stdinChunks: Buffer[] = [];
  #exited = Promise.withResolvers<ExecOutcome>();
  #launched = Promise.withResolvers<Result<void, ExecFailure>>();
  /** Aborted on settlement: stops a start in flight and drops the `signal` listener. */
  #settled = new AbortController();
  #totalTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  /** Every teardown so far; `dispose()` waits for them. */
  #teardowns: Promise<void> = Promise.resolve();
  #queue: ExecEvent[] = [];
  #processing = false;

  constructor(backend: ExecBackend, opts: ExecOptions) {
    this.#backend = backend;
    this.#opts = opts;
    this.#log = log.child(backend.logFields);
    this.#state = begin(backend.buffersStdin).state;
    // A failed exec fails both streams; the failure is reported by `exited`
    // too, so an unread stream must not crash the process.
    this.#stdout.on("error", () => {});
    this.#stderr.on("error", () => {});
  }

  async open(): Promise<ExecStreamingHandle> {
    if (this.#backend.buffersStdin) this.#stdin = this.#bufferStdin();
    const totalMs = this.#opts.timeoutMs;
    if (totalMs !== undefined) {
      this.#totalTimer = setTimeout(
        () => this.#observe({ type: "deadline", deadline: "total", timeoutMs: totalMs }),
        totalMs,
      ).unref();
    }
    this.#run(() => {
      for (const effect of begin(this.#backend.buffersStdin).effects) this.#execute(effect);
    });
    const signal = this.#opts.signal;
    if (signal?.aborted) this.#observe({ type: "dispose" });
    else {
      signal?.addEventListener("abort", () => this.#observe({ type: "dispose" }), {
        once: true,
        signal: this.#settled.signal,
      });
    }
    if (!this.#backend.buffersStdin) {
      const launched = await this.#launched.promise;
      if (launched.isErr()) throw execFailureError(launched.error);
    }
    return this.#handle();
  }

  #handle(): ExecStreamingHandle {
    const exited = this.#exited.promise;
    return {
      ...(this.#stdin !== undefined && { stdin: this.#stdin }),
      stdout: this.#stdout,
      stderr: this.#stderr,
      exited,
      wait: () => exited.then(unwrapExit),
      dispose: async () => {
        this.#observe({ type: "dispose" });
        await this.#teardowns;
      },
    };
  }

  /** Stdin a backend needs whole before it starts: kept in memory until the caller ends it. */
  #bufferStdin(): Writable {
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#stdinChunks.push(chunk);
        callback();
      },
    });
    finished(stdin, (e) => {
      this.#observe(e ? { type: "stream_failed", error: toError(e) } : { type: "stdin_ended" });
    });
    return stdin;
  }

  /**
   * Feed an event to the machine. Effects run to completion before the next
   * event, so one raised while effects run (a consumer disposing from a
   * `data` handler, say) waits its turn.
   */
  #observe(event: ExecEvent): void {
    this.#queue.push(event);
    this.#run(() => {});
  }

  /** Run `work`, then every queued event in order, unless a run is already under way. */
  #run(work: () => void): void {
    if (this.#processing) return;
    this.#processing = true;
    try {
      work();
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        this.#enter(transition(this.#state, next));
      }
    } finally {
      this.#processing = false;
    }
  }

  #enter(next: ExecTransition): void {
    this.#state = next.state;
    for (const effect of next.effects) this.#execute(effect);
  }

  #execute(effect: ExecEffect): void {
    match(effect)
      .with({ type: "start" }, () => this.#start())
      .with({ type: "launched" }, () => this.#launched.resolve(ok(undefined)))
      .with({ type: "write" }, ({ stream, chunk }) => {
        (stream === "stdout" ? this.#stdout : this.#stderr).write(chunk);
      })
      .with({ type: "arm_idle" }, () => this.#armIdle())
      .with({ type: "fetch_exit" }, () => this.#fetchExit())
      .with({ type: "end_streams" }, () => {
        this.#stdout.end();
        this.#stderr.end();
        this.#closeBufferedStdin();
      })
      .with({ type: "fail_streams" }, ({ error }) => {
        this.#stdout.destroy(error);
        this.#stderr.destroy(error);
        this.#closeBufferedStdin();
      })
      .with({ type: "settle" }, ({ outcome }) => {
        clearTimeout(this.#totalTimer);
        clearTimeout(this.#idleTimer);
        this.#settled.abort();
        this.#exited.resolve(outcome);
        this.#launched.resolve(outcome.map(() => undefined));
      })
      .with({ type: "teardown" }, () => {
        this.#teardowns = Promise.all([this.#teardowns, this.#teardown()]).then(() => undefined);
      })
      .with({ type: "log" }, ({ level, message, fields }) => this.#log[level](fields, message))
      .exhaustive();
  }

  /**
   * What the transport reports while the start is in flight is held until
   * the start's own outcome is in, so which of the two arrives first never
   * depends on microtask order.
   */
  #start(): void {
    const stdin = this.#backend.buffersStdin ? Buffer.concat(this.#stdinChunks) : undefined;
    this.#stdinChunks = [];
    let held: ExecEvent[] | undefined = [];
    const deliver = (event: ExecEvent): void => {
      if (held) held.push(event);
      else this.#observe(event);
    };
    const release = (outcome: ExecEvent): void => {
      const events = [outcome, ...(held ?? [])];
      held = undefined;
      for (const event of events) this.#observe(event);
    };
    const sink: ExecSink = {
      output: (stream, chunk) => deliver({ type: "output", stream, chunk }),
      ended: () => deliver({ type: "stream_ended" }),
      failed: (e) => deliver({ type: "stream_failed", error: toError(e) }),
    };
    this.#backend.start(sink, stdin, this.#settled.signal).then(
      (started) => {
        if (started.stdin !== undefined) this.#stdin ??= started.stdin;
        release({ type: "started" });
      },
      (e: unknown) => release({ type: "start_failed", error: toError(e) }),
    );
  }

  #armIdle(): void {
    const idleMs = this.#opts.idleTimeoutMs;
    if (idleMs === undefined) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(
      () => this.#observe({ type: "deadline", deadline: "idle", timeoutMs: idleMs }),
      idleMs,
    ).unref();
  }

  #fetchExit(): void {
    this.#backend.fetchExit().then(
      (exit) =>
        this.#observe(
          exit.match<ExecEvent>(
            (exitCode) => ({ type: "exit_code", exitCode }),
            (reason) => ({ type: "exit_code_missing", reason }),
          ),
        ),
      (e: unknown) => this.#observe({ type: "stream_failed", error: toError(e) }),
    );
  }

  /** A buffering stdin the run settled before: writes to it fail from now on. */
  #closeBufferedStdin(): void {
    if (this.#backend.buffersStdin && this.#stdin && !this.#stdin.writableFinished) {
      this.#stdin.destroy();
    }
  }

  /** One best-effort teardown, abandoned after `TEARDOWN_TIMEOUT_MS`. Never rejects. */
  async #teardown(): Promise<void> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(`teardown timed out after ${TEARDOWN_TIMEOUT_MS}ms`, "TimeoutError"),
        ),
      TEARDOWN_TIMEOUT_MS,
    ).unref();
    try {
      await untilAborted(this.#backend.teardown(deadline.signal), deadline.signal);
    } catch (e) {
      this.#observe({ type: "teardown_failed", error: toError(e) });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** `promise`, or a rejection with `signal`'s reason once it aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
