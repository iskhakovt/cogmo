import { err, ok } from "neverthrow";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import type { CtxResult, TaskInvoke, TaskResult } from "./protocol.js";
import {
  admits,
  type Command,
  command,
  type Effect,
  type Fact,
  type Handshake,
  observe,
  type TaskRef,
  type Transition,
  type WorkerState,
  type WorkerStateKind,
} from "./worker-state.js";

/** The task on the worker in `running` / `awaiting_exit`. */
const TASK: TaskRef = { id: "t1" };
/** Another task: a stale one, or one the worker was never running. */
const OTHER: TaskRef = { id: "t2" };
/** A new task handed to the worker. */
const NEXT: TaskRef = { id: "t3" };
/** A different task object that shares the running task's id: a stale one, reusing it. */
const SAME_ID: TaskRef = { id: "t1" };

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
  dead_held: { kind: "dead", reason: "gone", held: true },
  dead: { kind: "dead", reason: "gone", held: false },
} satisfies Record<WorkerStateKind | "dead_held", WorkerState<TaskRef>>;

const COMMANDS = {
  acquire: { type: "acquire" },
  release: { type: "release" },
  invoke: { type: "invoke", task: NEXT, message: INVOKE },
} satisfies Record<string, Command<TaskRef>>;

const FACTS = {
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
  replied_own: { type: "ctx_replied", task: TASK, reply: REPLY },
  replied_other: { type: "ctx_replied", task: OTHER, reply: REPLY },
  replied_same_id: { type: "ctx_replied", task: SAME_ID, reply: REPLY },
  send_failed: { type: "send_failed", reason: "send failed" },
  deadline_own: { type: "deadline_passed", task: TASK },
  deadline_other: { type: "deadline_passed", task: OTHER },
  deadline_same_id: { type: "deadline_passed", task: SAME_ID },
  handshake_timed_out: { type: "handshake_timed_out" },
  channel_ended: { type: "channel_ended", reason: "ended" },
  close: { type: "close", reason: "closed" },
} satisfies Record<string, Fact<TaskRef>>;

type StateName = keyof typeof STATES;
type CommandName = keyof typeof COMMANDS;
type FactName = keyof typeof FACTS;
type EventName = CommandName | FactName;

/**
 * Compiles only when every command and fact type has a fixture — checked
 * by typecheck, not at runtime.
 */
type Uncovered =
  | Exclude<Command<TaskRef>["type"], (typeof COMMANDS)[CommandName]["type"]>
  | Exclude<Fact<TaskRef>["type"], (typeof FACTS)[FactName]["type"]>;
const EVERY_EVENT_COVERED: [Uncovered] extends [never] ? true : never = true;

type EffectType = Effect<TaskRef>["type"];
/** The next state's kind and the effects, in order. */
type Moves = readonly [next: WorkerStateKind, effects: ReadonlyArray<EffectType>];
/** A command may be refused; a fact never is, so its row cannot say so. */
type Row<E extends EventName> = E extends CommandName ? Moves | "refused" : Moves;

/** Starting judges its first frame: `ready` passes, anything else is refused. */
const START_FAILS: Moves = ["dead", ["started", "died", "disposable"]];
const DIES_UNDER_TASK: Moves = ["dead", ["log", "settle", "died"]];

/** Every (state, event) pair. */
const TABLE: Record<StateName, { [E in EventName]: Row<E> }> = {
  starting: {
    ready: ["idle", ["started"]],
    supervisor_ready: START_FAILS,
    fatal: START_FAILS,
    malformed: START_FAILS,
    ctx_call_own: START_FAILS,
    ctx_call_other: START_FAILS,
    result_own: START_FAILS,
    result_other: START_FAILS,
    exited_own: START_FAILS,
    exited_other: START_FAILS,
    acquire: "refused",
    release: "refused",
    invoke: "refused",
    replied_own: ["starting", ["log"]],
    replied_other: ["starting", ["log"]],
    replied_same_id: ["starting", ["log"]],
    send_failed: START_FAILS,
    deadline_own: ["starting", []],
    deadline_other: ["starting", []],
    deadline_same_id: ["starting", []],
    handshake_timed_out: START_FAILS,
    channel_ended: START_FAILS,
    close: START_FAILS,
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
    release: "refused",
    invoke: "refused",
    replied_own: ["idle", ["log"]],
    replied_other: ["idle", ["log"]],
    replied_same_id: ["idle", ["log"]],
    send_failed: ["dead", ["log", "died", "disposable"]],
    deadline_own: ["idle", []],
    deadline_other: ["idle", []],
    deadline_same_id: ["idle", []],
    handshake_timed_out: ["idle", []],
    channel_ended: ["dead", ["log", "died", "disposable"]],
    close: ["dead", ["died", "disposable"]],
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
    acquire: "refused",
    release: ["idle", []],
    invoke: ["running", ["send"]],
    replied_own: ["leased", ["log"]],
    replied_other: ["leased", ["log"]],
    replied_same_id: ["leased", ["log"]],
    send_failed: ["dead", ["log", "died"]],
    deadline_own: ["leased", []],
    deadline_other: ["leased", []],
    deadline_same_id: ["leased", []],
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
    result_other: DIES_UNDER_TASK,
    exited_own: ["leased", ["settle"]],
    exited_other: DIES_UNDER_TASK,
    acquire: "refused",
    release: "refused",
    invoke: "refused",
    replied_own: ["running", ["send"]],
    replied_other: ["running", ["log"]],
    replied_same_id: ["running", ["log"]],
    send_failed: DIES_UNDER_TASK,
    deadline_own: DIES_UNDER_TASK,
    deadline_other: ["running", []],
    deadline_same_id: ["running", []],
    handshake_timed_out: ["running", []],
    channel_ended: DIES_UNDER_TASK,
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
    result_other: DIES_UNDER_TASK,
    exited_own: ["leased", ["settle"]],
    exited_other: DIES_UNDER_TASK,
    acquire: "refused",
    release: "refused",
    invoke: "refused",
    replied_own: ["awaiting_exit", ["log"]],
    replied_other: ["awaiting_exit", ["log"]],
    replied_same_id: ["awaiting_exit", ["log"]],
    send_failed: DIES_UNDER_TASK,
    deadline_own: DIES_UNDER_TASK,
    deadline_other: ["awaiting_exit", []],
    deadline_same_id: ["awaiting_exit", []],
    handshake_timed_out: ["awaiting_exit", []],
    channel_ended: DIES_UNDER_TASK,
    close: ["dead", ["settle", "died"]],
  },
  dead_held: {
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
    acquire: "refused",
    release: ["dead", ["disposable"]],
    invoke: ["dead", ["settle"]],
    replied_own: ["dead", []],
    replied_other: ["dead", []],
    replied_same_id: ["dead", []],
    send_failed: ["dead", []],
    deadline_own: ["dead", []],
    deadline_other: ["dead", []],
    deadline_same_id: ["dead", []],
    handshake_timed_out: ["dead", []],
    channel_ended: ["dead", []],
    close: ["dead", []],
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
    acquire: "refused",
    release: "refused",
    invoke: ["dead", ["settle"]],
    replied_own: ["dead", []],
    replied_other: ["dead", []],
    replied_same_id: ["dead", []],
    send_failed: ["dead", []],
    deadline_own: ["dead", []],
    deadline_other: ["dead", []],
    deadline_same_id: ["dead", []],
    handshake_timed_out: ["dead", []],
    channel_ended: ["dead", []],
    close: ["dead", []],
  },
};

interface Pair {
  stateName: StateName;
  eventName: EventName;
  before: WorkerState<TaskRef>;
  refused: boolean;
  after: Transition<TaskRef>;
}

const PAIRS: Pair[] = R.keys(STATES).flatMap((stateName) => {
  const before: WorkerState<TaskRef> = STATES[stateName];
  const commands = R.keys(COMMANDS).map((eventName): Pair => {
    const result = command<TaskRef>(before, COMMANDS[eventName]);
    // A refused command moves nowhere: the worker stays as it was.
    const after = result.isOk() ? result.value : { state: before, effects: [] };
    return { stateName, eventName, before, refused: result.isErr(), after };
  });
  const facts = R.keys(FACTS).map(
    (eventName): Pair => ({
      stateName,
      eventName,
      before,
      refused: false,
      after: observe<TaskRef>(before, FACTS[eventName]),
    }),
  );
  return [...commands, ...facts];
});

function pairsWhere(predicate: (pair: Pair) => boolean): Array<[StateName, EventName]> {
  return PAIRS.filter(predicate).map((p) => [p.stateName, p.eventName]);
}

function emits(pair: Pair, type: EffectType): boolean {
  return pair.after.effects.some((e) => e.type === type);
}

/** The accepted transition for `cmd`; throws if it is refused. */
function commanded(state: WorkerState<TaskRef>, cmd: Command<TaskRef>): Transition<TaskRef> {
  const result = command<TaskRef>(state, cmd);
  if (result.isErr()) throw new Error(`refused: ${result.error}`);
  return result.value;
}

describe("the worker machine", () => {
  it("has a fixture for every state and every event type", () => {
    // `STATES` satisfies a record over every state kind; `EVERY_EVENT_COVERED`
    // fails typecheck, not this assertion, when an event type has no fixture.
    expect(EVERY_EVENT_COVERED).toBe(true);
  });

  it.each(PAIRS)("$stateName × $eventName", ({ stateName, eventName, refused, after }) => {
    const row = TABLE[stateName][eventName];
    if (row === "refused") {
      expect(refused).toBe(true);
      return;
    }
    expect(refused).toBe(false);
    expect(after.state.kind).toBe(row[0]);
    expect(after.effects.map((e) => e.type)).toEqual(row[1]);
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
      expect(pairsWhere((p) => p.eventName === "acquire" && !p.refused)).toEqual([
        ["idle", "acquire"],
      ]);
      expect(
        pairsWhere((p) => p.before.kind !== "running" && p.after.state.kind === "running"),
      ).toEqual([["leased", "invoke"]]);
    });

    it("takes a task exactly where `admits` says: runs it when leased, fails it when dead", () => {
      const admissions = R.mapValues(STATES, (s: WorkerState<TaskRef>) =>
        admits(s).match(
          (a) => a.kind,
          () => "refused",
        ),
      );
      expect(admissions).toEqual({
        starting: "refused",
        idle: "refused",
        leased: "runs",
        running: "refused",
        awaiting_exit: "refused",
        dead_held: "fails",
        dead: "fails",
      });
      for (const p of PAIRS.filter((pair) => pair.eventName === "invoke")) {
        expect({ state: p.stateName, refused: p.refused }).toEqual({
          state: p.stateName,
          refused: admissions[p.stateName] === "refused",
        });
      }
    });

    it("keeps dead final, and announces death exactly once", () => {
      for (const p of PAIRS) {
        const died = p.after.effects.filter((e) => e.type === "died").length;
        const entered = p.before.kind !== "dead" && p.after.state.kind === "dead";
        expect(died, `${p.stateName} × ${p.eventName}`).toBe(entered ? 1 : 0);
        if (p.before.kind === "dead") expect(p.after.state.kind).toBe("dead");
      }
    });

    it("blames a death on the host exactly when the host closed the channel", () => {
      expect(
        pairsWhere((p) =>
          p.after.effects.some((e) => e.type === "died" && e.death.cause === "host"),
        ),
      ).toEqual(pairsWhere((p) => p.eventName === "close" && emits(p, "died")));
      expect(pairsWhere((p) => p.eventName === "close" && emits(p, "died"))).toHaveLength(5);
    });

    it("makes a worker disposable exactly once: when it is dead and nobody holds it", () => {
      const heldBefore = (p: Pair): boolean =>
        p.before.kind === "leased" ||
        p.before.kind === "running" ||
        p.before.kind === "awaiting_exit" ||
        (p.before.kind === "dead" && p.before.held);
      for (const p of PAIRS) {
        const becomesDisposable =
          p.after.state.kind === "dead" &&
          !p.after.state.held &&
          !(p.before.kind === "dead" && !p.before.held);
        expect(emits(p, "disposable"), `${p.stateName} × ${p.eventName}`).toBe(becomesDisposable);
        // Death keeps a held worker held: only its caller's release frees it.
        if (heldBefore(p) && p.eventName !== "release" && p.after.state.kind === "dead") {
          expect(p.after.state.held, `${p.stateName} × ${p.eventName}`).toBe(true);
        }
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
      expect(observe<TaskRef>(STATES.starting, FACTS.ready)).toEqual({
        state: { kind: "idle" },
        effects: [{ type: "started", outcome: ok(undefined) }],
      });
    });

    it("starting: a refused handshake reports why, and dies disposable", () => {
      expect(observe<TaskRef>(STATES.starting, FACTS.fatal)).toEqual({
        state: { kind: "dead", reason: "sent fatal before ready", held: false },
        effects: [
          { type: "started", outcome: err({ kind: "refused", reason: "sent fatal before ready" }) },
          { type: "died", death: { cause: "worker", reason: "sent fatal before ready" } },
          { type: "disposable" },
        ],
      });
    });

    it("starting: a timeout or a lost channel reports its own start failure", () => {
      expect(observe<TaskRef>(STATES.starting, FACTS.handshake_timed_out).effects[0]).toEqual({
        type: "started",
        outcome: err({ kind: "timed_out" }),
      });
      expect(observe<TaskRef>(STATES.starting, FACTS.channel_ended).effects[0]).toEqual({
        type: "started",
        outcome: err({ kind: "ended", reason: "ended" }),
      });
    });

    it("starting: a host close reports the start as closed, not as the worker ending", () => {
      expect(observe<TaskRef>(STATES.starting, FACTS.close).effects[0]).toEqual({
        type: "started",
        outcome: err({ kind: "closed", reason: "closed" }),
      });
    });

    it("leased: invoke sends the task and runs it", () => {
      expect(commanded(STATES.leased, COMMANDS.invoke)).toEqual({
        state: { kind: "running", task: NEXT },
        effects: [{ type: "send", message: INVOKE }],
      });
    });

    it("leased: a death keeps the worker held for its caller", () => {
      expect(observe<TaskRef>(STATES.leased, FACTS.close).state).toEqual({
        kind: "dead",
        reason: "closed",
        held: true,
      });
    });

    it("running: serves the running task's ctx call with that task", () => {
      expect(observe<TaskRef>(STATES.running, FACTS.ctx_call_own).effects).toEqual([
        { type: "serve", task: TASK, call: FACTS.ctx_call_own },
      ]);
    });

    it("running: sends a reply only for the task object on the worker, not one sharing its id", () => {
      expect(observe<TaskRef>(STATES.running, FACTS.replied_same_id).effects).toEqual([
        expect.objectContaining({ type: "log" }),
      ]);
    });

    it("running: a result holds the worker until the task exits", () => {
      expect(observe<TaskRef>(STATES.running, FACTS.result_own)).toEqual({
        state: { kind: "awaiting_exit", task: TASK, result: RESULT },
        effects: [],
      });
    });

    it("awaiting_exit: task_exited settles the result with a confirmed exit", () => {
      expect(observe<TaskRef>(STATES.awaiting_exit, FACTS.exited_own)).toEqual({
        state: { kind: "leased" },
        effects: [
          {
            type: "settle",
            task: TASK,
            outcome: { result: ok(RESULT), exit: { kind: "confirmed" } },
          },
        ],
      });
    });

    it("running: task_exited without a result settles as exited without one, exit confirmed", () => {
      expect(observe<TaskRef>(STATES.running, FACTS.exited_own).effects).toEqual([
        {
          type: "settle",
          task: TASK,
          outcome: {
            result: err({ kind: "exited_without_result" }),
            exit: { kind: "confirmed" },
          },
        },
      ]);
    });

    it("running: a deadline counts only for the task object on the worker, not its id", () => {
      expect(observe<TaskRef>(STATES.running, FACTS.deadline_same_id)).toEqual({
        state: STATES.running,
        effects: [],
      });
    });

    it("running: a passed deadline fails the task as timed out, exit unconfirmed", () => {
      expect(observe<TaskRef>(STATES.running, FACTS.deadline_own).effects).toContainEqual({
        type: "settle",
        task: TASK,
        outcome: {
          result: err({ kind: "timed_out" }),
          exit: { kind: "unconfirmed", reason: "task deadline passed" },
        },
      });
    });

    it("awaiting_exit: a lost channel keeps the result, exit unconfirmed", () => {
      expect(observe<TaskRef>(STATES.awaiting_exit, FACTS.channel_ended).effects).toContainEqual({
        type: "settle",
        task: TASK,
        outcome: { result: ok(RESULT), exit: { kind: "unconfirmed", reason: "ended" } },
      });
    });

    it("running: a result naming another task fails the task and dies", () => {
      const reason = "task_result id mismatch (expected t1, got t2)";
      const died = observe<TaskRef>(STATES.running, FACTS.result_other);
      expect(died.state).toEqual({ kind: "dead", reason, held: true });
      expect(died.effects).toContainEqual({
        type: "settle",
        task: TASK,
        outcome: {
          result: err({ kind: "failed", reason }),
          exit: { kind: "unconfirmed", reason },
        },
      });
    });

    it("dead: invoke fails the new task without sending it", () => {
      const reason = "worker is dead: gone";
      expect(commanded(STATES.dead_held, COMMANDS.invoke).effects).toEqual([
        {
          type: "settle",
          task: NEXT,
          outcome: {
            result: err({ kind: "failed", reason }),
            exit: { kind: "unconfirmed", reason },
          },
        },
      ]);
    });

    it("dead: its caller's release makes a held worker disposable", () => {
      expect(commanded(STATES.dead_held, COMMANDS.release)).toEqual({
        state: { kind: "dead", reason: "gone", held: false },
        effects: [{ type: "disposable" }],
      });
    });
  });
});
