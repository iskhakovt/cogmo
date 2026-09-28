import { err, ok } from "neverthrow";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import type { CtxResult, TaskInvoke, TaskResult } from "./protocol.js";
import {
  type Effect,
  type Handshake,
  type TaskRef,
  transition,
  type WorkerEvent,
  type WorkerState,
  type WorkerStateKind,
} from "./worker-state.js";

/** The task on the worker in `running` / `awaiting_exit`. */
const TASK: TaskRef = { id: "t1" };
/** Another task: a stale one, or one the worker was never running. */
const OTHER: TaskRef = { id: "t2" };
/** A new task handed to the worker. */
const NEXT: TaskRef = { id: "t3" };

const RESULT: TaskResult = { type: "task_result", id: "t1", ok: true, output: 1 };
const INVOKE: TaskInvoke = { type: "task_invoke", id: "t3", skill: "s", inputs: {} };
const REPLY: CtxResult = { type: "ctx_result", taskId: "t1", id: "c1", ok: true, value: 1 };

const acceptReady: Handshake = (first) =>
  first.type === "ready" ? ok(undefined) : err(`sent ${first.type} before ready`);

const STATES = {
  starting: { kind: "starting", handshake: acceptReady },
  idle: { kind: "idle" },
  leased: { kind: "leased" },
  running: { kind: "running", task: TASK },
  awaiting_exit: { kind: "awaiting_exit", task: TASK, result: RESULT },
  dead: { kind: "dead", reason: "gone" },
} satisfies Record<WorkerStateKind, WorkerState<TaskRef>>;

const EVENTS = {
  ready: { type: "ready" },
  supervisor_ready: { type: "supervisor_ready", protocolVersion: 2 },
  fatal: { type: "fatal", error: "boom" },
  malformed: { type: "malformed", issues: ["Invalid input"] },
  ctx_call_own: { type: "ctx_call", taskId: "t1", id: "c1", method: "now", args: {} },
  ctx_call_other: { type: "ctx_call", taskId: "t2", id: "c2", method: "now", args: {} },
  result_own: RESULT,
  result_other: { type: "task_result", id: "t2", ok: true, output: 2 },
  exited_own: { type: "task_exited", id: "t1" },
  exited_other: { type: "task_exited", id: "t2" },
  acquire: { type: "acquire" },
  release: { type: "release" },
  invoke: { type: "invoke", task: NEXT, message: INVOKE },
  replied_own: { type: "ctx_replied", task: TASK, reply: REPLY },
  replied_other: { type: "ctx_replied", task: OTHER, reply: REPLY },
  send_failed: { type: "send_failed", reason: "send failed" },
  deadline_own: { type: "deadline_passed", task: TASK },
  deadline_other: { type: "deadline_passed", task: OTHER },
  handshake_timed_out: { type: "handshake_timed_out" },
  channel_ended: { type: "channel_ended", reason: "ended" },
  close: { type: "close", reason: "closed" },
} satisfies Record<string, WorkerEvent<TaskRef>>;

type StateName = keyof typeof STATES;
type EventName = keyof typeof EVENTS;
type Row = readonly [next: WorkerStateKind, effects: ReadonlyArray<Effect<TaskRef>["type"]>];

/** Starting judges its first frame: `ready` passes, anything else is refused. */
const REFUSED: Row = ["dead", ["started", "died"]];
const DIES_WITH_TASK: Row = ["dead", ["log", "settle", "died"]];

/** Every (state, event) pair: the next state and the effects, in order. */
const TABLE: Record<StateName, Record<EventName, Row>> = {
  starting: {
    ready: ["idle", ["started"]],
    supervisor_ready: REFUSED,
    fatal: REFUSED,
    malformed: REFUSED,
    ctx_call_own: REFUSED,
    ctx_call_other: REFUSED,
    result_own: REFUSED,
    result_other: REFUSED,
    exited_own: REFUSED,
    exited_other: REFUSED,
    acquire: ["starting", ["refused"]],
    release: ["starting", ["refused", "log"]],
    invoke: ["starting", ["refused"]],
    replied_own: ["starting", ["log"]],
    replied_other: ["starting", ["log"]],
    send_failed: ["dead", ["started", "died"]],
    deadline_own: ["starting", []],
    deadline_other: ["starting", []],
    handshake_timed_out: ["dead", ["started", "died"]],
    channel_ended: ["dead", ["started", "died"]],
    close: ["dead", ["started", "died"]],
  },
  idle: {
    ready: ["idle", ["log"]],
    supervisor_ready: ["idle", ["log"]],
    fatal: ["idle", ["log"]],
    malformed: ["idle", ["log"]],
    ctx_call_own: ["idle", ["log"]],
    ctx_call_other: ["idle", ["log"]],
    result_own: ["idle", ["log"]],
    result_other: ["idle", ["log"]],
    exited_own: ["idle", ["log"]],
    exited_other: ["idle", ["log"]],
    acquire: ["leased", []],
    release: ["idle", ["refused", "log"]],
    invoke: ["idle", ["refused"]],
    replied_own: ["idle", ["log"]],
    replied_other: ["idle", ["log"]],
    send_failed: ["dead", ["log", "died"]],
    deadline_own: ["idle", []],
    deadline_other: ["idle", []],
    handshake_timed_out: ["idle", []],
    channel_ended: ["dead", ["log", "died"]],
    close: ["dead", ["died"]],
  },
  leased: {
    ready: ["leased", ["log"]],
    supervisor_ready: ["leased", ["log"]],
    fatal: ["leased", ["log"]],
    malformed: ["leased", ["log"]],
    ctx_call_own: ["leased", ["log"]],
    ctx_call_other: ["leased", ["log"]],
    result_own: ["leased", ["log"]],
    result_other: ["leased", ["log"]],
    exited_own: ["leased", ["log"]],
    exited_other: ["leased", ["log"]],
    acquire: ["leased", ["refused"]],
    release: ["idle", []],
    invoke: ["running", ["send"]],
    replied_own: ["leased", ["log"]],
    replied_other: ["leased", ["log"]],
    send_failed: ["dead", ["log", "died"]],
    deadline_own: ["leased", []],
    deadline_other: ["leased", []],
    handshake_timed_out: ["leased", []],
    channel_ended: ["dead", ["log", "died"]],
    close: ["dead", ["died"]],
  },
  running: {
    ready: ["running", ["log"]],
    supervisor_ready: ["running", ["log"]],
    fatal: ["running", ["log"]],
    malformed: ["running", ["log"]],
    ctx_call_own: ["running", ["serve"]],
    ctx_call_other: ["running", ["log"]],
    result_own: ["awaiting_exit", []],
    result_other: DIES_WITH_TASK,
    exited_own: ["leased", ["settle"]],
    exited_other: DIES_WITH_TASK,
    acquire: ["running", ["refused"]],
    release: ["running", ["refused", "log"]],
    invoke: ["running", ["refused"]],
    replied_own: ["running", ["send"]],
    replied_other: ["running", ["log"]],
    send_failed: DIES_WITH_TASK,
    deadline_own: DIES_WITH_TASK,
    deadline_other: ["running", []],
    handshake_timed_out: ["running", []],
    channel_ended: DIES_WITH_TASK,
    close: ["dead", ["settle", "died"]],
  },
  awaiting_exit: {
    ready: ["awaiting_exit", ["log"]],
    supervisor_ready: ["awaiting_exit", ["log"]],
    fatal: ["awaiting_exit", ["log"]],
    malformed: ["awaiting_exit", ["log"]],
    ctx_call_own: ["awaiting_exit", ["log"]],
    ctx_call_other: ["awaiting_exit", ["log"]],
    result_own: ["awaiting_exit", ["log"]],
    result_other: DIES_WITH_TASK,
    exited_own: ["leased", ["settle"]],
    exited_other: DIES_WITH_TASK,
    acquire: ["awaiting_exit", ["refused"]],
    release: ["awaiting_exit", ["refused", "log"]],
    invoke: ["awaiting_exit", ["refused"]],
    replied_own: ["awaiting_exit", ["log"]],
    replied_other: ["awaiting_exit", ["log"]],
    send_failed: DIES_WITH_TASK,
    deadline_own: DIES_WITH_TASK,
    deadline_other: ["awaiting_exit", []],
    handshake_timed_out: ["awaiting_exit", []],
    channel_ended: DIES_WITH_TASK,
    close: ["dead", ["settle", "died"]],
  },
  dead: {
    ready: ["dead", []],
    supervisor_ready: ["dead", []],
    fatal: ["dead", []],
    malformed: ["dead", []],
    ctx_call_own: ["dead", []],
    ctx_call_other: ["dead", []],
    result_own: ["dead", []],
    result_other: ["dead", []],
    exited_own: ["dead", []],
    exited_other: ["dead", []],
    acquire: ["dead", ["refused"]],
    release: ["dead", ["refused"]],
    invoke: ["dead", ["settle"]],
    replied_own: ["dead", []],
    replied_other: ["dead", []],
    send_failed: ["dead", []],
    deadline_own: ["dead", []],
    deadline_other: ["dead", []],
    handshake_timed_out: ["dead", []],
    channel_ended: ["dead", []],
    close: ["dead", []],
  },
};

const PAIRS = R.keys(STATES).flatMap((stateName) =>
  R.keys(EVENTS).map((eventName) => ({
    stateName,
    eventName,
    before: STATES[stateName],
    after: transition<TaskRef>(STATES[stateName], EVENTS[eventName]),
  })),
);

function pairsWhere(
  predicate: (pair: (typeof PAIRS)[number]) => boolean,
): Array<[StateName, EventName]> {
  return PAIRS.filter(predicate).map((p) => [p.stateName, p.eventName]);
}

function emits(pair: (typeof PAIRS)[number], type: Effect<TaskRef>["type"]): boolean {
  return pair.after.effects.some((e) => e.type === type);
}

describe("transition", () => {
  it("covers every (state, event) pair", () => {
    expect(PAIRS).toHaveLength(R.keys(STATES).length * R.keys(EVENTS).length);
  });

  it.each(PAIRS)("$stateName × $eventName", ({ stateName, eventName, after }) => {
    const [next, effects] = TABLE[stateName][eventName];
    expect(after.state.kind).toBe(next);
    expect(after.effects.map((e) => e.type)).toEqual(effects);
  });

  describe("invariants over every pair", () => {
    it("serves a ctx call only in running, and only one naming the running task", () => {
      expect(pairsWhere((p) => emits(p, "serve"))).toEqual([["running", "ctx_call_own"]]);
    });

    it("sends only a leased worker's task and the running task's replies", () => {
      expect(pairsWhere((p) => emits(p, "send"))).toEqual([
        ["leased", "invoke"],
        ["running", "replied_own"],
      ]);
    });

    it("gives a worker with a task on it back only on that task's own task_exited", () => {
      expect(
        pairsWhere(
          (p) =>
            (p.before.kind === "running" || p.before.kind === "awaiting_exit") &&
            (p.after.state.kind === "leased" || p.after.state.kind === "idle"),
        ),
      ).toEqual([
        ["running", "exited_own"],
        ["awaiting_exit", "exited_own"],
      ]);
    });

    it("reaches idle only through the handshake or a release", () => {
      expect(pairsWhere((p) => p.before.kind !== "idle" && p.after.state.kind === "idle")).toEqual([
        ["starting", "ready"],
        ["leased", "release"],
      ]);
    });

    it("acquires only an idle worker and starts a task only on a leased one", () => {
      expect(pairsWhere((p) => p.eventName === "acquire" && !emits(p, "refused"))).toEqual([
        ["idle", "acquire"],
      ]);
      expect(
        pairsWhere((p) => p.before.kind !== "running" && p.after.state.kind === "running"),
      ).toEqual([["leased", "invoke"]]);
    });

    it("keeps dead final, and announces death exactly once", () => {
      for (const p of PAIRS) {
        const died = p.after.effects.filter((e) => e.type === "died").length;
        const entered = p.before.kind !== "dead" && p.after.state.kind === "dead";
        expect(died, `${p.stateName} × ${p.eventName}`).toBe(entered ? 1 : 0);
        if (p.before.kind === "dead") expect(p.after.state).toBe(p.before);
      }
    });

    it("settles the task on the worker whenever the worker dies under it", () => {
      const dying = PAIRS.filter(
        (p) =>
          (p.before.kind === "running" || p.before.kind === "awaiting_exit") &&
          p.after.state.kind === "dead",
      );
      expect(dying.length).toBeGreaterThan(0);
      for (const p of dying) {
        expect(
          p.after.effects.filter((e) => e.type === "settle"),
          `${p.stateName} × ${p.eventName}`,
        ).toEqual([expect.objectContaining({ task: TASK })]);
      }
    });
  });

  describe("effects", () => {
    it("starting: an accepted handshake reports the worker started", () => {
      expect(transition(STATES.starting, EVENTS.ready)).toEqual({
        state: { kind: "idle" },
        effects: [{ type: "started", outcome: ok(undefined) }],
      });
    });

    it("starting: a refused handshake reports why, and dies", () => {
      expect(transition(STATES.starting, EVENTS.fatal)).toEqual({
        state: { kind: "dead", reason: "sent fatal before ready" },
        effects: [
          { type: "started", outcome: err({ kind: "refused", reason: "sent fatal before ready" }) },
          { type: "died", reason: "sent fatal before ready" },
        ],
      });
    });

    it("starting: a timeout or a lost channel reports its own start failure", () => {
      expect(transition(STATES.starting, EVENTS.handshake_timed_out).effects[0]).toEqual({
        type: "started",
        outcome: err({ kind: "timed_out" }),
      });
      expect(transition(STATES.starting, EVENTS.channel_ended).effects[0]).toEqual({
        type: "started",
        outcome: err({ kind: "ended", reason: "ended" }),
      });
    });

    it("starting: a host close reports the start as closed, not as the worker ending", () => {
      expect(transition(STATES.starting, EVENTS.close).effects[0]).toEqual({
        type: "started",
        outcome: err({ kind: "closed", reason: "closed" }),
      });
    });

    it("leased: invoke sends the task and runs it", () => {
      expect(transition<TaskRef>(STATES.leased, EVENTS.invoke)).toEqual({
        state: { kind: "running", task: NEXT },
        effects: [{ type: "send", message: INVOKE }],
      });
    });

    it("running: serves the running task's ctx call with that task", () => {
      expect(transition<TaskRef>(STATES.running, EVENTS.ctx_call_own).effects).toEqual([
        { type: "serve", task: TASK, call: EVENTS.ctx_call_own },
      ]);
    });

    it("running: sends a reply only for the task object on the worker, not one sharing its id", () => {
      const sameId: TaskRef = { id: TASK.id };
      expect(
        transition<TaskRef>(STATES.running, { type: "ctx_replied", task: sameId, reply: REPLY })
          .effects,
      ).toEqual([expect.objectContaining({ type: "log" })]);
    });

    it("running: a result holds the worker until the task exits", () => {
      expect(transition<TaskRef>(STATES.running, EVENTS.result_own)).toEqual({
        state: { kind: "awaiting_exit", task: TASK, result: RESULT },
        effects: [],
      });
    });

    it("awaiting_exit: task_exited settles the result with a confirmed exit", () => {
      expect(transition<TaskRef>(STATES.awaiting_exit, EVENTS.exited_own)).toEqual({
        state: { kind: "leased" },
        effects: [
          {
            type: "settle",
            task: TASK,
            outcome: ok({ result: RESULT, exit: { kind: "confirmed" } }),
          },
        ],
      });
    });

    it("running: task_exited without a result settles a synthesised failure", () => {
      expect(transition<TaskRef>(STATES.running, EVENTS.exited_own).effects).toEqual([
        {
          type: "settle",
          task: TASK,
          outcome: ok({
            result: {
              type: "task_result",
              id: "t1",
              ok: false,
              error: "task_exited_without_result",
            },
            exit: { kind: "confirmed" },
          }),
        },
      ]);
    });

    it("running: a passed deadline fails the task as timed out", () => {
      expect(transition<TaskRef>(STATES.running, EVENTS.deadline_own).effects).toContainEqual({
        type: "settle",
        task: TASK,
        outcome: err({ kind: "timed_out" }),
      });
    });

    it("awaiting_exit: a lost channel keeps the result, exit unconfirmed", () => {
      expect(
        transition<TaskRef>(STATES.awaiting_exit, EVENTS.channel_ended).effects,
      ).toContainEqual({
        type: "settle",
        task: TASK,
        outcome: ok({ result: RESULT, exit: { kind: "unconfirmed", reason: "ended" } }),
      });
    });

    it("running: a result naming another task fails the task and dies", () => {
      const next = transition<TaskRef>(STATES.running, EVENTS.result_other);
      expect(next.state).toEqual({
        kind: "dead",
        reason: "task_result id mismatch (expected t1, got t2)",
      });
      expect(next.effects).toContainEqual({
        type: "settle",
        task: TASK,
        outcome: err({ kind: "failed", reason: "task_result id mismatch (expected t1, got t2)" }),
      });
    });

    it("dead: invoke fails the new task without sending it", () => {
      expect(transition<TaskRef>(STATES.dead, EVENTS.invoke).effects).toEqual([
        {
          type: "settle",
          task: NEXT,
          outcome: err({ kind: "failed", reason: "worker is dead: gone" }),
        },
      ]);
    });
  });
});
