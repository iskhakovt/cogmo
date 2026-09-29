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
 *  - what the transport reports while the start is in flight takes effect after the start's own outcome;
 *  - the exit code is fetched before teardown, which can erase it;
 *  - output is written only before settlement, and only output while `running` restarts the idle deadline;
 *  - a start that completes or fails after settlement is torn down again, for what it acquired late;
 *  - a dispose while a teardown runs retries it if it fails, and one after a failed teardown retries it
 *    at once; neither changes the outcome.
 */

export type ExecStreamName = "stdout" | "stderr";

export type ExecOutcome = Result<ExecExit, ExecFailure>;

/** What the transport reports: output, and the end or failure of the output stream. */
export type TransportEvent =
  | { type: "output"; stream: ExecStreamName; chunk: Buffer }
  | { type: "stream_ended" }
  | { type: "stream_failed"; error: Error };

/** The teardowns of a settled run. */
export interface Teardowns {
  inFlight: number;
  /** The last one to finish failed, and no retry has started since. */
  failed: boolean;
  /** A dispose arrived while one was running: retry it if it fails. */
  retryRequested: boolean;
}

export type ExecRunState =
  /** The backend runs the command only once the caller's stdin has ended. */
  | { kind: "awaiting_stdin" }
  /** `held`: what the transport reported before the start's outcome, in order. */
  | { kind: "starting"; held: ReadonlyArray<TransportEvent> }
  /** The command runs; the idle deadline, if any, is armed. */
  | { kind: "running" }
  /** Its output has ended; the exit code, and anything the backend drains with it, is being fetched. */
  | { kind: "draining" }
  /** Final. */
  | { kind: "settled"; outcome: ExecOutcome; teardowns: Teardowns };

export type ExecEvent =
  | TransportEvent
  | { type: "stdin_ended" }
  /** Stdin a backend buffers failed before the start. */
  | { type: "stdin_failed"; error: Error }
  | { type: "started" }
  | { type: "start_failed"; error: Error }
  | { type: "exit_code"; exitCode: number }
  | { type: "exit_code_missing"; reason: string }
  /** The exit code could not be fetched. */
  | { type: "fetch_failed"; error: Error }
  | { type: "deadline"; deadline: "total" | "idle"; timeoutMs: number }
  | { type: "dispose" }
  | { type: "torn_down" }
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
/** States in which the idle deadline is armed. */
const IDLE_ARMED = ["running", "draining"] as const;
const TRANSPORT = ["output", "stream_ended", "stream_failed"] as const;

type Settled = Extract<ExecRunState, { kind: "settled" }>;

/**
 * Where a run begins: waiting for stdin when the backend buffers it,
 * starting otherwise. A run whose signal aborted already settles as
 * `disposed` and starts nothing, so there is nothing to tear down.
 */
export function begin(opts: { buffersStdin: boolean; aborted: boolean }): ExecTransition {
  if (opts.aborted) {
    const outcome: ExecOutcome = err({ kind: "disposed" });
    return step(settledWith(outcome, 0), [{ type: "end_streams" }, { type: "settle", outcome }]);
  }
  return opts.buffersStdin
    ? step({ kind: "awaiting_stdin" }, [])
    : step({ kind: "starting", held: [] }, [{ type: "start" }]);
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
      step({ kind: "starting", held: [] }, [{ type: "start" }]),
    )
    .with([{ kind: "awaiting_stdin" }, { type: "stdin_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error }), failStreams(e.error)),
    )
    .with([{ kind: "starting" }, { type: P.union(...TRANSPORT) }], ([s, e]) =>
      step({ kind: "starting", held: [...s.held, e] }, []),
    )
    .with([{ kind: "starting" }, { type: "started" }], ([s]) => replay(s.held))
    .with([{ kind: "starting" }, { type: "start_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error }), failStreams(e.error)),
    )
    .with([{ kind: "running" }, { type: "output" }], ([s, e]) =>
      step(s, [write(e), { type: "arm_idle" }]),
    )
    .with([{ kind: "draining" }, { type: "output" }], ([s, e]) => step(s, [write(e)]))
    .with([{ kind: "running" }, { type: "stream_ended" }], () =>
      step({ kind: "draining" }, [{ type: "arm_idle" }, { type: "fetch_exit" }]),
    )
    .with([{ kind: "running" }, { type: "stream_failed" }], ([, e]) =>
      settle(err({ kind: "transport_failed", error: e.error }), failStreams(e.error)),
    )
    .with([{ kind: "draining" }, { type: "fetch_failed" }], ([, e]) =>
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

/** The start's outcome is in: enter `running`, then take what the transport reported meanwhile. */
function replay(held: ReadonlyArray<TransportEvent>): ExecTransition {
  return held.reduce<ExecTransition>(
    (acc, event) => {
      const next = transition(acc.state, event);
      return step(next.state, [...acc.effects, ...next.effects]);
    },
    step({ kind: "running" }, [{ type: "launched" }, { type: "arm_idle" }]),
  );
}

/**
 * `settled` is final. What still arrives is a start that finished late,
 * which may have acquired something, a teardown's result, or a dispose.
 */
function afterSettlement(state: Settled, event: ExecEvent): ExecTransition {
  const { teardowns } = state;
  return match<ExecEvent, ExecTransition>(event)
    .with({ type: P.union("started", "start_failed") }, () => tearDownAgain(state))
    .with({ type: "torn_down" }, () => {
      const inFlight = teardowns.inFlight - 1;
      return step(
        withTeardowns(state, {
          inFlight,
          failed: false,
          retryRequested: teardowns.retryRequested && inFlight > 0,
        }),
        [],
      );
    })
    .with({ type: "teardown_failed" }, ({ error }) => {
      const log: ExecEffect = {
        type: "log",
        level: "warn",
        message: "exec teardown failed",
        fields: { err: error.message, retrying: teardowns.retryRequested },
      };
      const done = { ...teardowns, inFlight: teardowns.inFlight - 1 };
      return teardowns.retryRequested
        ? step(
            withTeardowns(state, {
              inFlight: done.inFlight + 1,
              failed: false,
              retryRequested: false,
            }),
            [log, { type: "teardown" }],
          )
        : step(withTeardowns(state, { ...done, failed: true }), [log]);
    })
    .with({ type: "dispose" }, () => {
      if (teardowns.inFlight > 0) {
        return step(withTeardowns(state, { ...teardowns, retryRequested: true }), []);
      }
      return teardowns.failed ? tearDownAgain(state) : stay(state);
    })
    .otherwise(() => stay(state));
}

function tearDownAgain(state: Settled): ExecTransition {
  const { teardowns } = state;
  return step(
    withTeardowns(state, { ...teardowns, inFlight: teardowns.inFlight + 1, failed: false }),
    [{ type: "teardown" }],
  );
}

/**
 * Enter `settled`. The caller's streams end, unless the transport broke while
 * output was flowing: then they fail with its error.
 */
function settle(
  outcome: ExecOutcome,
  streams: ExecEffect = { type: "end_streams" },
): ExecTransition {
  return step(settledWith(outcome, 1), [
    streams,
    { type: "settle", outcome },
    { type: "teardown" },
  ]);
}

function settledWith(outcome: ExecOutcome, inFlight: number): Settled {
  return {
    kind: "settled",
    outcome,
    teardowns: { inFlight, failed: false, retryRequested: false },
  };
}

function withTeardowns(state: Settled, teardowns: Teardowns): Settled {
  return { ...state, teardowns };
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
