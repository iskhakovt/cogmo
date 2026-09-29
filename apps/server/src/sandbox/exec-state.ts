import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import type { ExecExit, ExecFailure } from "./exec.js";

/**
 * One exec's lifecycle as a pure state machine, shared by every backend.
 * `transition` takes every event in every state; `ExecRun` (`exec-run.ts`)
 * feeds it and carries out the effects it returns. See design/sandbox.md →
 * Exec lifecycle.
 *
 * ```
 *  awaiting_stdin ─stdin_ended─► starting ─started─► running ─stream_ended─► draining ─exit_code─► settled
 *  any live state ─ deadline · dispose · start_failed · stream_failed ─► settled
 * ```
 *
 * Rules the table enforces:
 *  - the first event that settles the run decides its outcome, and `settled` is final;
 *  - a deadline or dispose settles at once: teardown is an effect of settling, never a step before it;
 *  - the exit code is fetched before teardown, which can erase it;
 *  - output is written only before settlement, and only output while `running` restarts the idle deadline;
 *  - a start that completes or fails after settlement is torn down again, for what it acquired late;
 *  - a failed teardown is retried by the next `dispose`, and changes no outcome.
 */

export type ExecStreamName = "stdout" | "stderr";

export type ExecOutcome = Result<ExecExit, ExecFailure>;

export type ExecRunState =
  /** The backend runs the command only once the caller's stdin has ended. */
  | { kind: "awaiting_stdin" }
  | { kind: "starting" }
  /** The command runs; the idle deadline, if any, is armed. */
  | { kind: "running" }
  /** Its output has ended; the exit code, and anything the backend drains with it, is being fetched. */
  | { kind: "draining" }
  /** Final. `teardownFailed` while the last teardown failed. */
  | { kind: "settled"; outcome: ExecOutcome; teardownFailed: boolean };

export type ExecEvent =
  | { type: "stdin_ended" }
  | { type: "started" }
  | { type: "start_failed"; error: Error }
  | { type: "output"; stream: ExecStreamName; chunk: Buffer }
  | { type: "stream_ended" }
  /** The transport failed: stdin before the start, the output stream, or the exit-code fetch. */
  | { type: "stream_failed"; error: Error }
  | { type: "exit_code"; exitCode: number }
  | { type: "exit_code_missing"; reason: string }
  | { type: "deadline"; deadline: "total" | "idle"; timeoutMs: number }
  | { type: "dispose" }
  | { type: "teardown_failed"; error: Error };

export type ExecEffect =
  | { type: "start" }
  /** The command runs: a caller waiting for it to start can have its handle. */
  | { type: "launched" }
  | { type: "write"; stream: ExecStreamName; chunk: Buffer }
  /** (Re)start the idle deadline. */
  | { type: "arm_idle" }
  | { type: "fetch_exit" }
  /** End the caller's streams: they carry all the output there will be. */
  | { type: "end_streams" }
  /** Fail the caller's streams: the transport broke while output was flowing. */
  | { type: "fail_streams"; error: Error }
  /** Report the outcome and stop every deadline. Emitted exactly once. */
  | { type: "settle"; outcome: ExecOutcome }
  /** Release what the backend holds. Best effort, bounded by its own timeout. */
  | { type: "teardown" }
  | { type: "log"; level: "warn"; message: string; fields: Record<string, unknown> };

export interface ExecTransition {
  state: ExecRunState;
  effects: ReadonlyArray<ExecEffect>;
}

const LIVE = ["awaiting_stdin", "starting", "running", "draining"] as const;
/** Live states in which the command may be producing output. */
const STREAMING = ["starting", "running"] as const;
/** States in which the idle deadline is armed. */
const IDLE_ARMED = ["running", "draining"] as const;

type Settled = Extract<ExecRunState, { kind: "settled" }>;

/** Where a run begins: waiting for stdin when the backend buffers it, starting otherwise. */
export function begin(buffersStdin: boolean): ExecTransition {
  return buffersStdin
    ? step({ kind: "awaiting_stdin" }, [])
    : step({ kind: "starting" }, [{ type: "start" }]);
}

export function transition(state: ExecRunState, event: ExecEvent): ExecTransition {
  return match<[ExecRunState, ExecEvent], ExecTransition>([state, event])
    .with([{ kind: "settled" }, P._], ([s, e]) => afterSettlement(s, e))
    .with([{ kind: P.union(...LIVE) }, { type: "dispose" }], () =>
      settle(err({ kind: "disposed" })),
    )
    .with([{ kind: P.union(...LIVE) }, { type: "deadline", deadline: "total" }], ([, e]) =>
      settle(err({ kind: "timed_out", deadline: "total", timeoutMs: e.timeoutMs })),
    )
    .with([{ kind: P.union(...IDLE_ARMED) }, { type: "deadline", deadline: "idle" }], ([, e]) =>
      settle(err({ kind: "timed_out", deadline: "idle", timeoutMs: e.timeoutMs })),
    )
    .with([{ kind: "awaiting_stdin" }, { type: "stdin_ended" }], () =>
      step({ kind: "starting" }, [{ type: "start" }]),
    )
    .with([{ kind: "awaiting_stdin" }, { type: "stream_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error }), failStreams(e.error)),
    )
    .with([{ kind: "starting" }, { type: "started" }], () =>
      step({ kind: "running" }, [{ type: "launched" }, { type: "arm_idle" }]),
    )
    .with([{ kind: "draining" }, { type: "started" }], ([s]) => step(s, [{ type: "launched" }]))
    .with([{ kind: "starting" }, { type: "start_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error }), failStreams(e.error)),
    )
    .with([{ kind: "draining" }, { type: "start_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error })),
    )
    .with([{ kind: P.union("starting", "draining") }, { type: "output" }], ([s, e]) =>
      step(s, [write(e)]),
    )
    .with([{ kind: "running" }, { type: "output" }], ([s, e]) =>
      step(s, [write(e), { type: "arm_idle" }]),
    )
    .with([{ kind: P.union(...STREAMING) }, { type: "stream_ended" }], () =>
      step({ kind: "draining" }, [{ type: "arm_idle" }, { type: "fetch_exit" }]),
    )
    .with([{ kind: P.union(...STREAMING) }, { type: "stream_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error }), failStreams(e.error)),
    )
    .with([{ kind: "draining" }, { type: "stream_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error })),
    )
    .with([{ kind: "draining" }, { type: "exit_code" }], ([, e]) =>
      settle(ok({ exitCode: e.exitCode })),
    )
    .with([{ kind: "draining" }, { type: "exit_code_missing" }], ([, e]) =>
      settle(err({ kind: "no_exit_code", reason: e.reason })),
    )
    .with([{ kind: P.union(...LIVE) }, P._], ([s]) => stay(s))
    .exhaustive();
}

/**
 * `settled` is final. What still arrives is a start that finished late,
 * which may have acquired something, or a teardown's result.
 */
function afterSettlement(state: Settled, event: ExecEvent): ExecTransition {
  return match<ExecEvent, ExecTransition>(event)
    .with({ type: P.union("started", "start_failed") }, () => step(state, [{ type: "teardown" }]))
    .with({ type: "teardown_failed" }, ({ error }) =>
      step({ ...state, teardownFailed: true }, [
        {
          type: "log",
          level: "warn",
          message: "exec teardown failed",
          fields: { err: error.message },
        },
      ]),
    )
    .with({ type: "dispose" }, () =>
      state.teardownFailed
        ? step({ ...state, teardownFailed: false }, [{ type: "teardown" }])
        : stay(state),
    )
    .otherwise(() => stay(state));
}

/**
 * Enter `settled`. The caller's streams end, unless the transport broke while
 * output was flowing: then they fail with its error.
 */
function settle(
  outcome: ExecOutcome,
  streams: ExecEffect = { type: "end_streams" },
): ExecTransition {
  return step({ kind: "settled", outcome, teardownFailed: false }, [
    streams,
    { type: "settle", outcome },
    { type: "teardown" },
  ]);
}

function failStreams(error: Error): ExecEffect {
  return { type: "fail_streams", error };
}

function write(event: Extract<ExecEvent, { type: "output" }>): ExecEffect {
  return { type: "write", stream: event.stream, chunk: event.chunk };
}

function step(state: ExecRunState, effects: ReadonlyArray<ExecEffect>): ExecTransition {
  return { state, effects };
}

function stay(state: ExecRunState): ExecTransition {
  return step(state, []);
}
