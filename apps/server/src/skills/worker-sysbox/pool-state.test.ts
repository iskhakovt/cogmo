import { beforeAll, describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { seededRandom } from "../../test/seeded-random.js";
import type { Death } from "../worker-state.js";
import {
  CRASH_LOOP_DEATHS,
  CRASH_LOOP_WINDOW_MS,
  emptyPool,
  type PoolEffect,
  type PoolEvent,
  type PoolSizing,
  type PoolState,
  type PoolWorker,
  reconcile,
  transition,
  type WorkerRef,
} from "./pool-state.js";

type Waiter = string;
type State = PoolState<WorkerRef, Waiter>;
type Event = PoolEvent<WorkerRef, Waiter>;
type Effect = PoolEffect<WorkerRef, Waiter>;

const SIZING: PoolSizing = {
  min: 1,
  max: 3,
  recycleAfterTasks: 5,
  recycleAfterMs: 10_000,
  idleShutdownMs: 1000,
};

const W1: WorkerRef = { workerId: "w1" };
const W2: WorkerRef = { workerId: "w2" };
/** A worker that has just come up. */
const W3: WorkerRef = { workerId: "w3" };

function at(worker: WorkerRef, status: PoolWorker<WorkerRef>["status"]): PoolWorker<WorkerRef> {
  return { worker, status, served: false };
}

const EMPTY = emptyPool<WorkerRef, Waiter>(SIZING);

/** Pools at rest: `reconcile` leaves each as it is. */
const STATES = {
  warm: { ...EMPTY, workers: [at(W1, "idle")] },
  warm_pair: { ...EMPTY, workers: [at(W1, "idle"), at(W2, "idle")] },
  /** One early death short of the crash-loop cap. */
  nearly_looping: {
    ...EMPTY,
    earlyDeaths: CRASH_LOOP_DEATHS - 1,
    workers: [at(W1, "idle")],
  },
  busy: { ...EMPTY, workers: [at(W1, "leased")] },
  /** At `max`: two busy workers and a spawn for the waiter. */
  full: { ...EMPTY, workers: [at(W1, "leased"), at(W2, "leased")], spawning: 1, queue: ["q1"] },
  /** W1 died under its task, which still holds it; its replacement is under way. */
  dying: { ...EMPTY, workers: [at(W1, "dead")], spawning: 1 },
  /** A replacement failed: below `min` until a death or the sweep. */
  spawn_failed: { ...EMPTY, spawnFailed: true },
  /** At `min`, after a spawn for a waiter another worker served failed. */
  warm_spawn_failed: { ...EMPTY, workers: [at(W1, "idle")], spawnFailed: true },
  looping: {
    ...EMPTY,
    earlyDeaths: CRASH_LOOP_DEATHS,
    workers: [at(W1, "leased")],
    queue: ["q1"],
  },
  looping_empty: { ...EMPTY, earlyDeaths: CRASH_LOOP_DEATHS },
  /** A probe under way for the waiter. */
  probing: { ...EMPTY, earlyDeaths: CRASH_LOOP_DEATHS, spawning: 1, queue: ["q1"] },
  /** The probe refused the waiter's grant: its death is on the way. */
  probe_refused: {
    ...EMPTY,
    earlyDeaths: CRASH_LOOP_DEATHS,
    workers: [at(W1, "refused")],
    queue: ["q1"],
  },
  /** A spawn under way while the waiter waits for a busy worker. */
  looping_busy_spawning: {
    ...EMPTY,
    earlyDeaths: CRASH_LOOP_DEATHS,
    workers: [at(W1, "leased")],
    spawning: 1,
    queue: ["q1"],
  },
  disposed: { ...EMPTY, phase: "disposed", spawning: 1 },
} satisfies Record<string, State>;

function died(worker: WorkerRef, death: Death, ageMs: number): Event {
  return { type: "died", worker, death, ageMs };
}

const EVENTS = {
  acquire: { type: "acquire", waiter: "q2" },
  spawned: { type: "spawned", worker: W3 },
  spawn_failed: { type: "spawn_failed", error: new Error("spawn failed") },
  grant_refused: { type: "grant_refused", worker: W1, waiter: "q2" },
  died_early: died(W1, { cause: "worker", reason: "exited" }, 0),
  died_late: died(W1, { cause: "worker", reason: "exited" }, CRASH_LOOP_WINDOW_MS),
  retired: died(W1, { cause: "host", reason: "retired" }, 0),
  disposable: { type: "disposable", worker: W1 },
  returned: {
    type: "task_returned",
    worker: W1,
    returned: { kind: "alive", taskCount: 1, ageMs: 0 },
  },
  returned_at_task_cap: {
    type: "task_returned",
    worker: W1,
    returned: { kind: "alive", taskCount: SIZING.recycleAfterTasks, ageMs: 0 },
  },
  returned_at_age_cap: {
    type: "task_returned",
    worker: W1,
    returned: { kind: "alive", taskCount: 1, ageMs: SIZING.recycleAfterMs },
  },
  returned_dead: { type: "task_returned", worker: W1, returned: { kind: "dead" } },
  returned_threw: { type: "task_returned", worker: W1, returned: { kind: "threw" } },
  /** W1 has sat idle `idleShutdownMs`; the rest have not. */
  sweep: { type: "sweep", idleMs: new Map([[W1, SIZING.idleShutdownMs]]) },
  dispose: { type: "dispose" },
} satisfies Record<string, Event>;

type StateName = keyof typeof STATES;
type EventName = keyof typeof EVENTS;

/** Compiles only when every event type has a fixture — checked by typecheck. */
type Uncovered = Exclude<Event["type"], (typeof EVENTS)[EventName]["type"]>;
const EVERY_EVENT_COVERED: [Uncovered] extends [never] ? true : never = true;

/**
 * The pool at a glance: each worker with its status (`+` once a task it
 * held has returned), the queue, spawns under way and early deaths.
 */
function summary(state: State): string {
  const workers = state.workers
    .map((w) => `${w.worker.workerId}:${w.status}${w.served ? "+" : ""}`)
    .join(" ");
  return [
    workers === "" ? "-" : workers,
    `q[${state.queue.join(" ")}]`,
    `s${state.spawning}`,
    `e${state.earlyDeaths}`,
    ...(state.spawnFailed ? ["spawn failed"] : []),
    ...(state.phase === "disposed" ? ["disposed"] : []),
  ].join(" | ");
}

type Row = readonly [StateName, EventName, ReadonlyArray<Effect["type"]>, string];

/** Each event's branches, from the pools at rest above. */
const TABLE: ReadonlyArray<Row> = [
  ["warm", "acquire", ["grant"], "w1:leased | q[] | s0 | e0"],
  ["warm", "died_early", ["log", "spawn"], "w1:dead | q[] | s1 | e1"],
  ["warm", "died_late", ["log", "spawn"], "w1:dead | q[] | s1 | e0"],
  ["warm", "retired", ["log", "spawn"], "w1:dead | q[] | s1 | e0"],
  ["warm", "sweep", [], "w1:idle | q[] | s0 | e0"],
  ["warm", "dispose", ["teardown"], "- | q[] | s0 | e0 | disposed"],
  ["warm_pair", "sweep", ["log", "retire"], "w1:dead w2:idle | q[] | s0 | e0"],
  ["nearly_looping", "died_early", ["log", "log"], "w1:dead | q[] | s0 | e3"],
  ["busy", "acquire", ["spawn"], "w1:leased | q[q2] | s1 | e0"],
  ["busy", "died_early", ["log", "spawn"], "w1:dead | q[] | s1 | e0"],
  ["busy", "grant_refused", ["spawn"], "w1:refused | q[q2] | s1 | e0"],
  ["busy", "returned", ["release"], "w1:idle+ | q[] | s0 | e0"],
  [
    "busy",
    "returned_at_task_cap",
    ["log", "retire", "release", "spawn"],
    "w1:dead+ | q[] | s1 | e0",
  ],
  [
    "busy",
    "returned_at_age_cap",
    ["log", "retire", "release", "spawn"],
    "w1:dead+ | q[] | s1 | e0",
  ],
  ["busy", "returned_dead", ["release", "spawn"], "w1:dead+ | q[] | s1 | e0"],
  ["busy", "returned_threw", ["retire", "release", "spawn"], "w1:dead+ | q[] | s1 | e0"],
  ["busy", "dispose", ["teardown"], "- | q[] | s0 | e0 | disposed"],
  ["full", "acquire", [], "w1:leased w2:leased | q[q1 q2] | s1 | e0"],
  ["full", "spawned", ["grant"], "w1:leased w2:leased w3:leased | q[] | s0 | e0"],
  ["full", "spawn_failed", ["reject"], "w1:leased w2:leased | q[] | s0 | e0 | spawn failed"],
  ["full", "returned", ["release", "grant"], "w1:leased+ w2:leased | q[] | s1 | e0"],
  ["full", "returned_dead", ["release"], "w1:dead+ w2:leased | q[q1] | s1 | e0"],
  ["full", "dispose", ["reject", "teardown", "teardown"], "- | q[] | s1 | e0 | disposed"],
  ["dying", "acquire", [], "w1:dead | q[q2] | s1 | e0"],
  ["dying", "spawned", [], "w1:dead w3:idle | q[] | s0 | e0"],
  ["dying", "spawn_failed", ["log"], "w1:dead | q[] | s0 | e0 | spawn failed"],
  ["dying", "returned_dead", ["release"], "w1:dead+ | q[] | s1 | e0"],
  ["dying", "disposable", ["teardown"], "- | q[] | s1 | e0"],
  ["spawn_failed", "acquire", ["spawn"], "- | q[q2] | s1 | e0 | spawn failed"],
  ["spawn_failed", "sweep", ["spawn"], "- | q[] | s1 | e0"],
  ["warm_spawn_failed", "died_early", ["log", "spawn"], "w1:dead | q[] | s1 | e1"],
  ["looping", "acquire", [], "w1:leased | q[q1 q2] | s0 | e3"],
  ["looping", "returned", ["release", "grant"], "w1:leased+ | q[] | s0 | e0"],
  ["looping", "returned_dead", ["release", "spawn"], "w1:dead+ | q[q1] | s1 | e3"],
  ["looping", "sweep", [], "w1:leased | q[q1] | s0 | e3"],
  ["looping_empty", "acquire", ["spawn"], "- | q[q2] | s1 | e3"],
  ["looping_empty", "sweep", ["spawn"], "- | q[] | s1 | e3"],
  ["looping_empty", "died_early", [], "- | q[] | s0 | e3"],
  ["probing", "acquire", [], "- | q[q1 q2] | s1 | e3"],
  ["probing", "spawned", ["grant"], "w3:leased | q[] | s0 | e3"],
  ["probing", "spawn_failed", ["reject"], "- | q[] | s0 | e3 | spawn failed"],
  ["probe_refused", "acquire", [], "w1:refused | q[q1 q2] | s0 | e3"],
  ["probe_refused", "died_early", ["log", "reject"], "w1:dead | q[] | s0 | e4"],
  ["probe_refused", "died_late", ["log", "spawn"], "w1:dead | q[q1] | s1 | e3"],
  ["disposed", "acquire", ["reject"], "- | q[] | s1 | e0 | disposed"],
  ["disposed", "grant_refused", ["reject"], "- | q[] | s1 | e0 | disposed"],
  ["disposed", "spawned", ["teardown"], "- | q[] | s0 | e0 | disposed"],
  ["disposed", "spawn_failed", [], "- | q[] | s0 | e0 | disposed"],
  ["disposed", "returned", ["release"], "- | q[] | s1 | e0 | disposed"],
  ["disposed", "died_early", [], "- | q[] | s1 | e0 | disposed"],
  ["disposed", "disposable", [], "- | q[] | s1 | e0 | disposed"],
  ["disposed", "sweep", [], "- | q[] | s1 | e0 | disposed"],
  ["disposed", "dispose", [], "- | q[] | s1 | e0 | disposed"],
];

describe("the pool machine", () => {
  it("has a fixture for every event type", () => {
    expect(EVERY_EVENT_COVERED).toBe(true);
  });

  it.each(Object.entries(STATES))("%s is at rest", (_, state) => {
    expect(reconcile(state)).toEqual({ state, effects: [] });
  });

  it.each(TABLE)("%s × %s", (stateName, eventName, effects, after) => {
    const next = transition<WorkerRef, Waiter>(STATES[stateName], EVENTS[eventName]);
    expect({ effects: next.effects.map((e) => e.type), after: summary(next.state) }).toEqual({
      effects,
      after,
    });
    // Every transition ends at rest.
    expect(reconcile(next.state).effects).toEqual([]);
  });

  describe("effects", () => {
    it("grants idle workers to the oldest waiters, and spawns for the rest", () => {
      const state: State = { ...STATES.warm_pair, queue: ["q1", "q2", "q3"] };
      expect(reconcile(state).effects).toEqual([
        { type: "grant", worker: W1, waiter: "q1" },
        { type: "grant", worker: W2, waiter: "q2" },
        { type: "spawn" },
      ]);
    });

    it("puts a refused grant's waiter back at the head of the queue", () => {
      const next = transition<WorkerRef, Waiter>(STATES.full, {
        type: "grant_refused",
        worker: W1,
        waiter: "q0",
      });
      expect(next.state.queue).toEqual(["q0", "q1"]);
    });

    it("fails exactly one waiter with a spawn's error, and spawns for the next", () => {
      const error = new Error("spawn failed");
      const next = transition<WorkerRef, Waiter>(
        { ...STATES.full, queue: ["q1", "q2"] },
        { type: "spawn_failed", error },
      );
      expect(next.effects).toEqual([
        { type: "reject", waiter: "q1", rejection: { kind: "spawn_failed", error } },
        { type: "spawn" },
      ]);
      expect(next.state.queue).toEqual(["q2"]);
    });

    it("fails one waiter per probe that dies early, and probes for the next", () => {
      const next = transition<WorkerRef, Waiter>(
        { ...STATES.probe_refused, queue: ["q1", "q2"] },
        EVENTS.died_early,
      );
      expect(next.effects.filter((e) => e.type !== "log")).toEqual([
        { type: "reject", waiter: "q1", rejection: { kind: "crash_loop" } },
        { type: "spawn" },
      ]);
      expect(next.state.queue).toEqual(["q2"]);
    });

    it("does not count a death as early once a task the worker held has returned", () => {
      const served: State = { ...EMPTY, workers: [{ worker: W1, status: "idle", served: true }] };
      expect(transition<WorkerRef, Waiter>(served, EVENTS.died_early).state.earlyDeaths).toBe(0);
    });

    it("counts a death as early when the worker refused its first grant", () => {
      const refused = transition<WorkerRef, Waiter>(STATES.busy, EVENTS.grant_refused);
      expect(transition(refused.state, EVENTS.died_early).state.earlyDeaths).toBe(1);
    });
  });
});

// --- properties over random schedules ---

/** What a worker really is, which the pool learns only through its events. */
interface TrueWorker {
  alive: boolean;
  held: boolean;
  torn: boolean;
  born: number;
  lastUsed: number;
  tasks: number;
  disposableSent: boolean;
}

type Property =
  | "no waiter pending while there is room and nothing spawning"
  | "never more than max workers plus spawns"
  | "no teardown of a held worker"
  | "every waiter settles once workers and spawns do"
  | "a waiter is served once workers live again"
  | "the pool's view matches its workers";

interface World {
  state: State;
  now: number;
  /** Spawns the sandbox has under way. */
  spawns: number;
  workers: Map<WorkerRef, TrueWorker>;
  /** Each worker's `dead` and `disposable`, not yet delivered, in order per worker. */
  inbox: Array<{ worker: WorkerRef; event: Event }>;
  /** Workers a running task holds. */
  tasks: WorkerRef[];
  waiters: Map<Waiter, "waiting" | "granted" | "rejected">;
  broken: Map<Property, string>;
}

function real(world: World, worker: WorkerRef): TrueWorker {
  return expectDefined(world.workers.get(worker), worker.workerId);
}

function breaks(world: World, property: Property, detail: string): void {
  if (!world.broken.has(property)) world.broken.set(property, detail);
}

function kill(world: World, worker: WorkerRef, cause: Death["cause"]): void {
  const w = real(world, worker);
  if (!w.alive) return;
  w.alive = false;
  world.inbox.push({
    worker,
    event: died(worker, { cause, reason: cause }, world.now - w.born),
  });
  if (!w.held) sendDisposable(world, worker);
}

function sendDisposable(world: World, worker: WorkerRef): void {
  const w = real(world, worker);
  if (w.disposableSent) return;
  w.disposableSent = true;
  world.inbox.push({ worker, event: { type: "disposable", worker } });
}

/** Carry out one effect as the shell and a real worker would; a refused grant raises an event. */
function execute(world: World, effect: Effect): ReadonlyArray<Event> {
  switch (effect.type) {
    case "spawn":
      world.spawns += 1;
      return [];
    case "grant": {
      const w = real(world, effect.worker);
      if (!w.alive || w.held || w.torn) {
        return [{ type: "grant_refused", worker: effect.worker, waiter: effect.waiter }];
      }
      w.held = true;
      world.waiters.set(effect.waiter, "granted");
      world.tasks.push(effect.worker);
      return [];
    }
    case "reject":
      world.waiters.set(effect.waiter, "rejected");
      return [];
    case "retire":
      kill(world, effect.worker, "host");
      return [];
    case "release": {
      const w = real(world, effect.worker);
      w.held = false;
      if (!w.alive) sendDisposable(world, effect.worker);
      return [];
    }
    case "teardown": {
      const w = real(world, effect.worker);
      if (w.held && world.state.phase === "running") {
        breaks(world, "no teardown of a held worker", effect.worker.workerId);
      }
      w.torn = true;
      kill(world, effect.worker, "host");
      return [];
    }
    case "log":
      return [];
  }
}

function feed(world: World, event: Event): void {
  const next = transition(world.state, event);
  world.state = next.state;
  for (const raised of next.effects.flatMap((e) => execute(world, e))) feed(world, raised);
}

function check(world: World): void {
  const { state } = world;
  if (state.phase === "disposed") return;
  const room = state.sizing.max - state.workers.length - state.spawning;
  const at = `${summary(state)} (max ${state.sizing.max}, min ${state.sizing.min})`;
  if (room < 0) breaks(world, "never more than max workers plus spawns", at);
  if (state.queue.length > 0) {
    // While the crash-loop cap holds, a waiter may also wait for a busy
    // worker, or for the death of a probe that refused its grant.
    const looping = state.earlyDeaths >= CRASH_LOOP_DEATHS;
    const waitsOnAWorker = state.workers.some(
      (w) => w.status === "leased" || w.status === "refused",
    );
    const waitsOnNothing =
      state.workers.some((w) => w.status === "idle") ||
      (room > 0 && state.spawning === 0 && !(looping && waitsOnAWorker));
    if (waitsOnNothing) {
      breaks(world, "no waiter pending while there is room and nothing spawning", at);
    }
  }
  const untorn = [...world.workers].filter(([, w]) => !w.torn).map(([worker]) => worker);
  const viewed = state.workers.map((w) => w.worker);
  if (
    state.spawning !== world.spawns ||
    untorn.length !== viewed.length ||
    untorn.some((w) => !viewed.includes(w))
  ) {
    breaks(world, "the pool's view matches its workers", at);
  }
}

/**
 * One seeded schedule: acquires, spawns that land, fail or come up dying,
 * deaths, returning tasks, sweeps and a possible disposal, in random order,
 * with each worker's events delivered late but in order. Then everything
 * settles: spawns land alive and tasks return with their workers alive.
 */
function walk(seed: number): World {
  const random = seededRandom(seed);
  const chance = (p: number): boolean => random() < p;
  const upTo = (n: number): number => Math.floor(random() * (n + 1));
  const max = 1 + upTo(3);
  const min = upTo(max);
  const world: World = {
    state: emptyPool({ ...SIZING, min, max, recycleAfterTasks: 1 + upTo(3) }),
    now: 0,
    spawns: 0,
    workers: new Map(),
    inbox: [],
    tasks: [],
    waiters: new Map(),
    broken: new Map(),
  };
  let ids = 0;
  const loopFrom = upTo(200);
  const loopTo = loopFrom + upTo(60);

  const land = (dies: boolean, fails: boolean): void => {
    world.spawns -= 1;
    if (fails) {
      feed(world, { type: "spawn_failed", error: new Error("spawn failed") });
      return;
    }
    ids += 1;
    const worker: WorkerRef = { workerId: `w${ids}` };
    world.workers.set(worker, {
      alive: true,
      held: false,
      torn: false,
      born: world.now,
      lastUsed: world.now,
      tasks: 0,
      disposableSent: false,
    });
    const diesFirst = dies && chance(0.5);
    if (diesFirst) kill(world, worker, "worker");
    feed(world, { type: "spawned", worker });
    if (dies && !diesFirst) kill(world, worker, "worker");
  };

  const deliver = (index: number): void => {
    const picked = expectDefined(world.inbox[index], "inbox entry");
    const first = world.inbox.findIndex((e) => e.worker === picked.worker);
    const [entry] = world.inbox.splice(first, 1);
    feed(world, expectDefined(entry, "first inbox entry").event);
  };

  const finish = (index: number, alive: boolean): void => {
    const [worker] = world.tasks.splice(index, 1);
    const held = expectDefined(worker, "task");
    const w = real(world, held);
    w.tasks += 1;
    w.lastUsed = world.now;
    const threw = !alive && w.alive && chance(0.3);
    if (!alive && !threw) kill(world, held, "worker");
    feed(world, {
      type: "task_returned",
      worker: held,
      returned: threw
        ? { kind: "threw" }
        : w.alive
          ? { kind: "alive", taskCount: w.tasks, ageMs: world.now - w.born }
          : { kind: "dead" },
    });
  };

  feed(world, { type: "sweep", idleMs: new Map() });
  for (let i = 0; i < 250 && world.state.phase === "running"; i++) {
    const looping = i >= loopFrom && i < loopTo;
    const roll = random();
    if (roll < 0.18) {
      const waiter = `q${i}`;
      world.waiters.set(waiter, "waiting");
      feed(world, { type: "acquire", waiter });
    } else if (roll < 0.36 && world.spawns > 0) {
      land(looping || chance(0.1), chance(0.15));
    } else if (roll < 0.56 && world.inbox.length > 0) {
      deliver(upTo(world.inbox.length - 1));
    } else if (roll < 0.72 && world.tasks.length > 0) {
      finish(upTo(world.tasks.length - 1), chance(0.8));
    } else if (roll < 0.8) {
      const alive = [...world.workers].filter(([, w]) => w.alive).map(([worker]) => worker);
      const victim = alive[upTo(alive.length - 1)];
      if (victim !== undefined) kill(world, victim, "worker");
    } else if (roll < 0.86) {
      world.now += 1500;
      const idleMs = new Map(
        world.state.workers.map(({ worker }): [WorkerRef, number] => [
          worker,
          world.now - real(world, worker).lastUsed,
        ]),
      );
      feed(world, { type: "sweep", idleMs });
    } else if (roll < 0.995) {
      world.now += chance(0.05) ? CRASH_LOOP_WINDOW_MS + 1 : 100;
    } else {
      feed(world, { type: "dispose" });
    }
    check(world);
  }

  const settle = (): void => {
    for (let i = 0; i < 10_000; i++) {
      if (world.inbox.length > 0) deliver(0);
      else if (world.spawns > 0) land(false, false);
      else if (world.tasks.length > 0) finish(0, true);
      else break;
      check(world);
    }
  };

  settle();
  const waiting = [...world.waiters].filter(([, s]) => s === "waiting").map(([q]) => q);
  if (waiting.length > 0) {
    breaks(
      world,
      "every waiter settles once workers and spawns do",
      `${waiting.join(", ")} in ${summary(world.state)}`,
    );
  }

  if (world.state.phase === "running") {
    const before = summary(world.state);
    world.waiters.set("q-recovery", "waiting");
    feed(world, { type: "acquire", waiter: "q-recovery" });
    settle();
    if (world.waiters.get("q-recovery") !== "granted") {
      breaks(world, "a waiter is served once workers live again", before);
    }
  }
  return world;
}

describe("the pool machine over random schedules", () => {
  const SEEDS = 3000;
  const broken = new Map<Property, string[]>();

  beforeAll(() => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const [property, detail] of walk(seed).broken) {
        broken.set(property, [...(broken.get(property) ?? []), `seed ${seed}: ${detail}`]);
      }
    }
  });

  it.each<Property>([
    "no waiter pending while there is room and nothing spawning",
    "never more than max workers plus spawns",
    "no teardown of a held worker",
    "every waiter settles once workers and spawns do",
    "a waiter is served once workers live again",
    "the pool's view matches its workers",
  ])("%s", (property) => {
    expect(broken.get(property)?.slice(0, 3) ?? []).toEqual([]);
  });
});
