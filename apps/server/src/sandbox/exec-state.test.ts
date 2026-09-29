import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  begin,
  type ExecEffect,
  type ExecEvent,
  type ExecOutcome,
  type ExecRunState,
  type Teardowns,
  transition,
} from "./exec-state.js";

const total: ExecEvent = { type: "deadline", deadline: "total", timeoutMs: 1_000 };
const idle: ExecEvent = { type: "deadline", deadline: "idle", timeoutMs: 500 };
const chunk = Buffer.from("x");
const output: ExecEvent = { type: "output", stream: "stdout", chunk };
const boom = new Error("boom");
const starting: ExecRunState = { kind: "starting", held: [] };

const settled = (outcome: ExecOutcome, teardowns: Partial<Teardowns> = {}): ExecRunState => ({
  kind: "settled",
  outcome,
  teardowns: { inFlight: 1, failed: false, retryRequested: false, ...teardowns },
});

/** Feed `events` from `state`, collecting every effect. */
function run(
  state: ExecRunState,
  ...events: ReadonlyArray<ExecEvent>
): { state: ExecRunState; effects: ExecEffect[] } {
  return events.reduce<{ state: ExecRunState; effects: ExecEffect[] }>(
    (acc, event) => {
      const next = transition(acc.state, event);
      return { state: next.state, effects: [...acc.effects, ...next.effects] };
    },
    { state, effects: [] },
  );
}

const effectTypes = (effects: ReadonlyArray<ExecEffect>): string[] => effects.map((e) => e.type);

describe("exec lifecycle", () => {
  it("begins waiting for stdin when the backend buffers it, starting otherwise", () => {
    expect(begin({ buffersStdin: true, aborted: false })).toEqual({
      state: { kind: "awaiting_stdin" },
      effects: [],
    });
    expect(begin({ buffersStdin: false, aborted: false })).toEqual({
      state: starting,
      effects: [{ type: "start" }],
    });
  });

  it("settles a run whose signal aborted already as disposed, starting and tearing down nothing", () => {
    for (const buffersStdin of [true, false]) {
      const outcome: ExecOutcome = err({ kind: "disposed" });
      expect(begin({ buffersStdin, aborted: true })).toEqual({
        state: settled(outcome, { inFlight: 0 }),
        effects: [{ type: "end_streams" }, { type: "settle", outcome }],
      });
    }
  });

  it("walks the natural path, fetching the exit code before tearing down", () => {
    const { state, effects } = run(
      { kind: "awaiting_stdin" },
      { type: "stdin_ended" },
      { type: "started" },
      output,
      { type: "stream_ended" },
      { type: "exit_code", exitCode: 3 },
      { type: "torn_down" },
    );
    expect(state).toEqual(settled(ok({ exitCode: 3 }), { inFlight: 0 }));
    expect(effectTypes(effects)).toEqual([
      "start",
      "launched",
      "arm_idle",
      "write",
      "arm_idle",
      "arm_idle",
      "fetch_exit",
      "end_streams",
      "settle",
      "teardown",
    ]);
  });

  it("reports a missing exit code as no_exit_code, and a failed fetch as a transport failure", () => {
    expect(
      transition({ kind: "draining" }, { type: "exit_code_missing", reason: "gone" }).state,
    ).toEqual(settled(err({ kind: "no_exit_code", reason: "gone" })));
    const fetchFailed = transition({ kind: "draining" }, { type: "fetch_failed", error: boom });
    expect(fetchFailed.state).toEqual(settled(err({ kind: "transport_failed", error: boom })));
    // The output ended cleanly before the fetch failed.
    expect(fetchFailed.effects[0]).toEqual({ type: "end_streams" });
  });

  describe("a deadline or dispose settles at once, whatever is in flight", () => {
    const live: ReadonlyArray<ExecRunState> = [
      { kind: "awaiting_stdin" },
      starting,
      { kind: "starting", held: [output] },
      { kind: "running" },
      { kind: "draining" },
    ];
    const cases: ReadonlyArray<readonly [ExecEvent, ExecOutcome]> = [
      [total, err({ kind: "timed_out", deadline: "total", timeoutMs: 1_000 })],
      [{ type: "dispose" }, err({ kind: "disposed" })],
    ];
    for (const from of live) {
      it(`from ${from.kind}`, () => {
        for (const [event, outcome] of cases) {
          const next = transition(from, event);
          expect(next.state).toEqual(settled(outcome));
          expect(next.effects).toEqual([
            { type: "end_streams" },
            { type: "settle", outcome },
            { type: "teardown" },
          ]);
        }
      });
    }
  });

  it("counts the idle deadline only once it is armed", () => {
    expect(transition({ kind: "awaiting_stdin" }, idle).effects).toEqual([]);
    expect(transition(starting, idle).effects).toEqual([]);
    for (const from of [{ kind: "running" }, { kind: "draining" }] as const) {
      expect(transition(from, idle).state).toEqual(
        settled(err({ kind: "timed_out", deadline: "idle", timeoutMs: 500 })),
      );
    }
  });

  it("restarts the idle deadline on output only while running", () => {
    expect(effectTypes(transition({ kind: "running" }, output).effects)).toEqual([
      "write",
      "arm_idle",
    ]);
    expect(effectTypes(transition({ kind: "draining" }, output).effects)).toEqual(["write"]);
  });

  it("gives the drain a fresh idle window when the output ends", () => {
    expect(effectTypes(transition({ kind: "running" }, { type: "stream_ended" }).effects)).toEqual([
      "arm_idle",
      "fetch_exit",
    ]);
  });

  describe("what the transport reports while the start is in flight", () => {
    const held: ReadonlyArray<ExecEvent> = [output, { type: "stream_ended" }];

    it("is held, with no effect, until the start's outcome", () => {
      const { state, effects } = run(starting, ...held);
      expect(state).toEqual({ kind: "starting", held });
      expect(effects).toEqual([]);
    });

    it("takes effect in order after the start, as if it had come while running", () => {
      const { state, effects } = run(starting, ...held, { type: "started" });
      expect(state).toEqual({ kind: "draining" });
      expect(effects).toEqual([
        { type: "launched" },
        { type: "arm_idle" },
        { type: "write", stream: "stdout", chunk },
        { type: "arm_idle" },
        { type: "arm_idle" },
        { type: "fetch_exit" },
      ]);
    });

    it("settles as the transport's failure after the start", () => {
      const { state, effects } = run(
        starting,
        { type: "stream_failed", error: boom },
        { type: "started" },
      );
      expect(state).toEqual(settled(err({ kind: "transport_failed", error: boom })));
      expect(effectTypes(effects)).toEqual([
        "launched",
        "arm_idle",
        "fail_streams",
        "settle",
        "teardown",
      ]);
    });

    it("is dropped when the start fails", () => {
      const { state, effects } = run(starting, ...held, { type: "start_failed", error: boom });
      expect(state).toEqual(settled(err({ kind: "transport_failed", error: boom })));
      expect(effects).toEqual([
        { type: "fail_streams", error: boom },
        { type: "settle", outcome: err({ kind: "transport_failed", error: boom }) },
        { type: "teardown" },
      ]);
    });
  });

  it("fails the streams only when the transport breaks while output can flow", () => {
    const failed: ExecOutcome = err({ kind: "transport_failed", error: boom });
    for (const [from, event] of [
      [{ kind: "awaiting_stdin" }, { type: "stdin_failed", error: boom }],
      [starting, { type: "start_failed", error: boom }],
      [{ kind: "running" }, { type: "stream_failed", error: boom }],
    ] as const) {
      const next = transition(from, event);
      expect(next.state).toEqual(settled(failed));
      expect(next.effects[0]).toEqual({ type: "fail_streams", error: boom });
    }
  });

  describe("once settled", () => {
    const outcome: ExecOutcome = err({ kind: "disposed" });

    it("keeps the first outcome and drops output", () => {
      for (const event of [
        total,
        idle,
        output,
        { type: "stream_ended" },
        { type: "stream_failed", error: boom },
        { type: "fetch_failed", error: boom },
        { type: "exit_code", exitCode: 0 },
        { type: "exit_code_missing", reason: "gone" },
        { type: "stdin_ended" },
      ] as const) {
        expect(transition(settled(outcome), event)).toEqual({
          state: settled(outcome),
          effects: [],
        });
      }
    });

    it("tears down again for a start that finished late", () => {
      for (const event of [{ type: "started" }, { type: "start_failed", error: boom }] as const) {
        expect(transition(settled(outcome), event)).toEqual({
          state: settled(outcome, { inFlight: 2 }),
          effects: [{ type: "teardown" }],
        });
      }
    });

    it("retries a teardown that failed on the next dispose, once", () => {
      const failed = transition(settled(outcome), { type: "teardown_failed", error: boom });
      expect(failed.state).toEqual(settled(outcome, { inFlight: 0, failed: true }));
      expect(effectTypes(failed.effects)).toEqual(["log"]);

      const retried = run(failed.state, { type: "dispose" }, { type: "dispose" });
      expect(retried.state).toEqual(settled(outcome, { inFlight: 1, retryRequested: true }));
      expect(retried.effects).toEqual([{ type: "teardown" }]);
    });

    it("retries a teardown that fails after a dispose arrived while it ran", () => {
      const requested = transition(settled(outcome), { type: "dispose" });
      expect(requested).toEqual({ state: settled(outcome, { retryRequested: true }), effects: [] });

      const failed = transition(requested.state, { type: "teardown_failed", error: boom });
      expect(failed.state).toEqual(settled(outcome));
      expect(effectTypes(failed.effects)).toEqual(["log", "teardown"]);
    });

    it("drops a requested retry when the teardown succeeds", () => {
      const { state, effects } = run(settled(outcome), { type: "dispose" }, { type: "torn_down" });
      expect(state).toEqual(settled(outcome, { inFlight: 0 }));
      expect(effects).toEqual([]);
      expect(transition(state, { type: "dispose" }).effects).toEqual([]);
    });

    it("ignores dispose once every teardown has succeeded", () => {
      const done = transition(settled(outcome), { type: "torn_down" }).state;
      expect(transition(done, { type: "dispose" })).toEqual({ state: done, effects: [] });
    });
  });
});
