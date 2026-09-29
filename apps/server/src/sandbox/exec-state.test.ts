import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  begin,
  type ExecEffect,
  type ExecEvent,
  type ExecOutcome,
  type ExecRunState,
  transition,
} from "./exec-state.js";

const total: ExecEvent = { type: "deadline", deadline: "total", timeoutMs: 1_000 };
const idle: ExecEvent = { type: "deadline", deadline: "idle", timeoutMs: 500 };
const chunk = Buffer.from("x");
const output: ExecEvent = { type: "output", stream: "stdout", chunk };
const boom = new Error("boom");

const settled = (outcome: ExecOutcome, teardownFailed = false): ExecRunState => ({
  kind: "settled",
  outcome,
  teardownFailed,
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
    expect(begin(true)).toEqual({ state: { kind: "awaiting_stdin" }, effects: [] });
    expect(begin(false)).toEqual({ state: { kind: "starting" }, effects: [{ type: "start" }] });
  });

  it("walks the natural path, fetching the exit code before tearing down", () => {
    const { state, effects } = run(
      { kind: "awaiting_stdin" },
      { type: "stdin_ended" },
      { type: "started" },
      output,
      { type: "stream_ended" },
      { type: "exit_code", exitCode: 3 },
    );
    expect(state).toEqual(settled(ok({ exitCode: 3 })));
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

  it("reports a missing exit code as no_exit_code", () => {
    const { state } = run({ kind: "draining" }, { type: "exit_code_missing", reason: "gone" });
    expect(state).toEqual(settled(err({ kind: "no_exit_code", reason: "gone" })));
  });

  describe("a deadline or dispose settles at once, whatever is in flight", () => {
    const live: ReadonlyArray<ExecRunState> = [
      { kind: "awaiting_stdin" },
      { kind: "starting" },
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
    expect(transition({ kind: "starting" }, idle).effects).toEqual([]);
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
    expect(effectTypes(transition({ kind: "starting" }, output).effects)).toEqual(["write"]);
    expect(effectTypes(transition({ kind: "draining" }, output).effects)).toEqual(["write"]);
  });

  it("gives the drain a fresh idle window when the output ends", () => {
    expect(effectTypes(transition({ kind: "running" }, { type: "stream_ended" }).effects)).toEqual([
      "arm_idle",
      "fetch_exit",
    ]);
  });

  it("fails the streams only when the transport breaks while output can flow", () => {
    const failed: ExecOutcome = err({ kind: "transport_failed", error: boom });
    for (const [from, event] of [
      [{ kind: "awaiting_stdin" }, { type: "stream_failed", error: boom }],
      [{ kind: "starting" }, { type: "start_failed", error: boom }],
      [{ kind: "starting" }, { type: "stream_failed", error: boom }],
      [{ kind: "running" }, { type: "stream_failed", error: boom }],
    ] as const) {
      const next = transition(from, event);
      expect(next.state).toEqual(settled(failed));
      expect(next.effects[0]).toEqual({ type: "fail_streams", error: boom });
    }
    const draining = transition({ kind: "draining" }, { type: "stream_failed", error: boom });
    expect(draining.state).toEqual(settled(failed));
    expect(draining.effects[0]).toEqual({ type: "end_streams" });
  });

  it("launches a command whose output ended before its start returned", () => {
    const { state, effects } = run(
      { kind: "starting" },
      { type: "stream_ended" },
      { type: "started" },
      { type: "exit_code", exitCode: 0 },
    );
    expect(state).toEqual(settled(ok({ exitCode: 0 })));
    expect(effectTypes(effects)).toContain("launched");
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
        expect(transition(settled(outcome), event).effects).toEqual([{ type: "teardown" }]);
      }
    });

    it("retries a failed teardown on the next dispose, once", () => {
      const failed = transition(settled(outcome), { type: "teardown_failed", error: boom });
      expect(failed.state).toEqual(settled(outcome, true));
      expect(effectTypes(failed.effects)).toEqual(["log"]);

      const retried = run(failed.state, { type: "dispose" }, { type: "dispose" });
      expect(retried.state).toEqual(settled(outcome));
      expect(retried.effects).toEqual([{ type: "teardown" }]);
    });

    it("ignores dispose when no teardown failed", () => {
      expect(transition(settled(outcome), { type: "dispose" }).effects).toEqual([]);
    });
  });
});
