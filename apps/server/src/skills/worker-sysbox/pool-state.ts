import * as R from "remeda";
import { match, P } from "ts-pattern";
import { describeError } from "../../util/describe-error.js";
import type { Death } from "../worker-state.js";

/**
 * The warm pool's bookkeeping as a pure state machine. `transition` takes an
 * event and returns the next state and the effects to carry out;
 * `SysboxWorkerPool` feeds it and executes them. See `design/skills.md` →
 * Warm pool.
 *
 * Every transition ends in `reconcile`, which reads only the state: it
 * grants idle workers to the head of the queue, then spawns for every
 * waiter and every worker short of `min`, less the spawns under way, room
 * permitting. No waiter is left waiting on nothing, whichever event queued
 * it: it has a spawn under way, a full pool to wait on, or — while the
 * crash-loop cap holds — a busy worker; failing that it is rejected.
 *
 * The workers stay authoritative: a `grant` holds only if the worker takes
 * the lease, and `died` and `disposable` are the worker's own report.
 */

/**
 * Early deaths in a row after which a dead worker is no longer replaced at
 * once. A death is early when the worker dies on its own, never leased,
 * within `CRASH_LOOP_WINDOW_MS` of its handshake. An image whose supervisor
 * cannot run would otherwise create and delete containers back to back; the
 * sweep still tries one spawn per interval. A task that returns with its
 * worker alive clears the count.
 */
export const CRASH_LOOP_DEATHS = 3;

/**
 * How soon after its handshake a worker must die for the death to be early.
 * A supervisor has no idle timeout, so an idle worker that dies later was
 * killed from outside (a Docker restart, the reaper), not by its image.
 */
export const CRASH_LOOP_WINDOW_MS = 60_000;

/** A worker as the machine sees it: an opaque handle with an id for logs. */
export interface WorkerRef {
  readonly workerId: string;
}

export interface PoolSizing {
  readonly min: number;
  readonly max: number;
  readonly recycleAfterTasks: number;
  readonly recycleAfterMs: number;
  readonly idleShutdownMs: number;
}

/** One worker in the pool. A dead one counts toward `max` until it is disposable. */
export interface PoolWorker<W extends WorkerRef> {
  readonly worker: W;
  /** `idle` can be granted; `leased` is held by a task; `dead` runs nothing more. */
  readonly status: "idle" | "leased" | "dead";
  /** A task it held has returned. */
  readonly served: boolean;
}

export interface PoolState<W extends WorkerRef, Q> {
  readonly sizing: PoolSizing;
  /** `disposed` is final: waiters are rejected, workers torn down, and nothing spawns. */
  readonly phase: "running" | "disposed";
  /** Every worker not yet torn down, oldest first. */
  readonly workers: ReadonlyArray<PoolWorker<W>>;
  /** Spawns under way; each counts toward `max`. */
  readonly spawning: number;
  /** Acquirers waiting for a worker, oldest first. */
  readonly queue: ReadonlyArray<Q>;
  /** Early deaths in a row; see `CRASH_LOOP_DEATHS`. */
  readonly earlyDeaths: number;
  /**
   * A spawn failed since the last spawn that succeeded and the last sweep:
   * only waiters spawn, so a sandbox that fails every spawn is retried for
   * `min` once per sweep, not in a loop.
   */
  readonly spawnFailed: boolean;
}

/** How a task left the worker it held. */
export type TaskReturn =
  /** The worker lives, and the recycle caps judge it. */
  | { kind: "alive"; taskCount: number; ageMs: number }
  | { kind: "dead" }
  /** `invoke` threw, which is a bug: the worker is retired. */
  | { kind: "threw" };

export type PoolEvent<W extends WorkerRef, Q> =
  | { type: "acquire"; waiter: Q }
  | { type: "spawned"; worker: W }
  | { type: "spawn_failed"; error: unknown }
  /** The worker refused a `grant`: it died before the pool heard. */
  | { type: "grant_refused"; worker: W; waiter: Q }
  /** The worker's `dead` resolved, when it was `ageMs` old. */
  | { type: "died"; worker: W; death: Death; ageMs: number }
  /** The worker's `disposable` resolved: it is dead and no task holds it. */
  | { type: "disposable"; worker: W }
  | { type: "task_returned"; worker: W; returned: TaskReturn }
  /** The interval sweep, with how long each worker has sat idle. */
  | { type: "sweep"; idleMs: ReadonlyMap<W, number> }
  | { type: "dispose" };

/** Why a waiter gets no worker. */
export type Rejection =
  | { kind: "disposed" }
  | { kind: "crash_loop" }
  | { kind: "spawn_failed"; error: unknown };

export type PoolEffect<W extends WorkerRef, Q> =
  | { type: "spawn" }
  /** Lease `worker` to `waiter`; a refusal comes back as `grant_refused`. */
  | { type: "grant"; worker: W; waiter: Q }
  | { type: "reject"; waiter: Q; rejection: Rejection }
  /** Close the worker: it dies, by the host's doing. */
  | { type: "retire"; worker: W }
  /** Give back the lease a task held. */
  | { type: "release"; worker: W }
  /** Remove the worker's container. */
  | { type: "teardown"; worker: W }
  | { type: "log"; level: "warn" | "debug"; message: string; fields: Record<string, unknown> };

export interface PoolTransition<W extends WorkerRef, Q> {
  state: PoolState<W, Q>;
  effects: ReadonlyArray<PoolEffect<W, Q>>;
}

export function emptyPool<W extends WorkerRef, Q>(sizing: PoolSizing): PoolState<W, Q> {
  return {
    sizing,
    phase: "running",
    workers: [],
    spawning: 0,
    queue: [],
    earlyDeaths: 0,
    spawnFailed: false,
  };
}

/** Take in an event: the next state and its effects, `reconcile`'s last. */
export function transition<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  event: PoolEvent<W, Q>,
): PoolTransition<W, Q> {
  const next = state.phase === "disposed" ? afterDisposal(state, event) : onEvent(state, event);
  const settled = reconcile(next.state);
  return step(settled.state, [...next.effects, ...settled.effects]);
}

/**
 * Bring the pool to rest: grant idle workers to the head of the queue, then
 * spawn for the rest, or — while the crash-loop cap holds — fail the queue
 * if no busy worker is left to wait for. Level-triggered: it reads only the
 * state, so it is idempotent.
 */
export function reconcile<W extends WorkerRef, Q>(state: PoolState<W, Q>): PoolTransition<W, Q> {
  if (state.phase === "disposed") return step(state, []);
  const granted = grantIdle(state);
  const next = crashLooping(granted.state)
    ? holdOrFail(granted.state)
    : spawnForDemand(granted.state);
  return step(next.state, [...granted.effects, ...next.effects]);
}

function onEvent<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  event: PoolEvent<W, Q>,
): PoolTransition<W, Q> {
  return match<PoolEvent<W, Q>, PoolTransition<W, Q>>(event)
    .with({ type: "acquire" }, ({ waiter }) =>
      step({ ...state, queue: [...state.queue, waiter] }, []),
    )
    .with({ type: "spawned" }, ({ worker }) =>
      step(
        {
          ...state,
          spawning: state.spawning - 1,
          spawnFailed: false,
          workers: [...state.workers, { worker, status: "idle", served: false }],
        },
        [],
      ),
    )
    .with({ type: "spawn_failed" }, ({ error }) => onSpawnFailed(state, error))
    .with({ type: "grant_refused" }, ({ worker, waiter }) =>
      step(
        { ...state, workers: markDead(state.workers, worker), queue: [waiter, ...state.queue] },
        [],
      ),
    )
    .with({ type: "died" }, ({ worker, death, ageMs }) => onDied(state, worker, death, ageMs))
    .with({ type: "disposable" }, ({ worker }) =>
      state.workers.some((w) => w.worker === worker)
        ? step({ ...state, workers: state.workers.filter((w) => w.worker !== worker) }, [
            { type: "teardown", worker },
          ])
        : step(state, []),
    )
    .with({ type: "task_returned" }, ({ worker, returned }) =>
      onTaskReturned(state, worker, returned),
    )
    .with({ type: "sweep" }, ({ idleMs }) => onSweep(state, idleMs))
    .with({ type: "dispose" }, () =>
      step({ ...state, phase: "disposed", workers: [], queue: [] }, [
        ...state.queue.map((waiter) => reject(waiter, { kind: "disposed" })),
        ...state.workers.map(({ worker }): PoolEffect<W, Q> => ({ type: "teardown", worker })),
      ]),
    )
    .exhaustive();
}

/**
 * Disposal took every waiter and worker: a waiter or a worker that arrives
 * after it is refused or torn down, and a task that returns still gives
 * back its lease.
 */
function afterDisposal<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  event: PoolEvent<W, Q>,
): PoolTransition<W, Q> {
  return match<PoolEvent<W, Q>, PoolTransition<W, Q>>(event)
    .with({ type: P.union("acquire", "grant_refused") }, ({ waiter }) =>
      step(state, [reject(waiter, { kind: "disposed" })]),
    )
    .with({ type: "spawned" }, ({ worker }) =>
      step({ ...state, spawning: state.spawning - 1 }, [{ type: "teardown", worker }]),
    )
    .with({ type: "spawn_failed" }, () => step({ ...state, spawning: state.spawning - 1 }, []))
    .with({ type: "task_returned" }, ({ worker }) => step(state, [{ type: "release", worker }]))
    .with({ type: P.union("died", "disposable", "sweep", "dispose") }, () => step(state, []))
    .exhaustive();
}

/**
 * A failed spawn fails the head of the queue, which would otherwise wait on
 * a worker that is never coming; `reconcile` then spawns for the next one.
 */
function onSpawnFailed<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  error: unknown,
): PoolTransition<W, Q> {
  const next = { ...state, spawning: state.spawning - 1, spawnFailed: true };
  const [waiter, ...queue] = state.queue;
  if (waiter === undefined) {
    return step(next, [
      log("warn", "worker spawn failed; the pool stays below min until the next sweep", {
        err: describeError(error),
      }),
    ]);
  }
  return step({ ...next, queue }, [reject(waiter, { kind: "spawn_failed", error })]);
}

function onDied<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  worker: W,
  death: Death,
  ageMs: number,
): PoolTransition<W, Q> {
  const entry = state.workers.find((w) => w.worker === worker);
  if (entry === undefined) return step(state, []);
  const early =
    death.cause === "worker" &&
    entry.status !== "leased" &&
    !entry.served &&
    ageMs < CRASH_LOOP_WINDOW_MS;
  const earlyDeaths = early ? state.earlyDeaths + 1 : state.earlyDeaths;
  return step({ ...state, earlyDeaths, workers: markDead(state.workers, worker) }, [
    log("debug", "worker died", { workerId: worker.workerId, ...death }),
    ...(early && earlyDeaths === CRASH_LOOP_DEATHS
      ? [
          log(
            "warn",
            "workers keep dying before their first task — replacing them on the sweep only",
            {
              deaths: earlyDeaths,
              reason: death.reason,
            },
          ),
        ]
      : []),
  ]);
}

/**
 * A task gave its worker back. A worker that lives shows the image runs,
 * which clears the early deaths; at a recycle cap it is retired first. The
 * age cap is judged only here: the sweep never goes below `min`, so a worker
 * within `min` that ages out idle lives until its next task, and the reaper
 * backstops a crashed host.
 */
function onTaskReturned<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  worker: W,
  returned: TaskReturn,
): PoolTransition<W, Q> {
  const release: PoolEffect<W, Q> = { type: "release", worker };
  return match<TaskReturn, PoolTransition<W, Q>>(returned)
    .with({ kind: "alive" }, ({ taskCount, ageMs }) => {
      const taskCap = taskCount >= state.sizing.recycleAfterTasks;
      const ageCap = ageMs >= state.sizing.recycleAfterMs;
      const recycled = taskCap || ageCap;
      return step(
        {
          ...state,
          earlyDeaths: 0,
          workers: returnedTo(state.workers, worker, recycled ? "dead" : "idle"),
        },
        recycled
          ? [
              log("debug", "recycling worker — cap reached", {
                workerId: worker.workerId,
                taskCount,
                taskCap,
                ageCap,
              }),
              { type: "retire", worker },
              release,
            ]
          : [release],
      );
    })
    .with({ kind: "dead" }, () =>
      step({ ...state, workers: returnedTo(state.workers, worker, "dead") }, [release]),
    )
    .with({ kind: "threw" }, () =>
      step({ ...state, workers: returnedTo(state.workers, worker, "dead") }, [
        { type: "retire", worker },
        release,
      ]),
    )
    .exhaustive();
}

/**
 * Retire idle workers above `min` that have sat past `idleShutdownMs`, and
 * lift a failed spawn's hold on replacing workers up to `min`. While the
 * crash-loop cap holds, spawn one worker toward `min`: the sweep is the only
 * replacement then.
 */
function onSweep<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  idleMs: ReadonlyMap<W, number>,
): PoolTransition<W, Q> {
  const idle = state.workers.filter((w) => w.status === "idle");
  const swept = idle
    .filter((w) => (idleMs.get(w.worker) ?? 0) >= state.sizing.idleShutdownMs)
    .slice(0, Math.max(0, idle.length - state.sizing.min))
    .map((w) => w.worker);
  const retired = {
    ...state,
    spawnFailed: false,
    workers: R.reduce(swept, (workers, worker) => markDead(workers, worker), state.workers),
  };
  const probe = crashLooping(retired) && deficit(retired) > retired.spawning && room(retired) > 0;
  return step(probe ? { ...retired, spawning: retired.spawning + 1 } : retired, [
    ...swept.flatMap(
      (worker): ReadonlyArray<PoolEffect<W, Q>> => [
        log("debug", "sweeping idle worker", {
          workerId: worker.workerId,
          idleMs: idleMs.get(worker),
        }),
        { type: "retire", worker },
      ],
    ),
    ...(probe ? [SPAWN] : []),
  ]);
}

// --- reconcile ---

/** Pair idle workers with the queue, oldest waiter first. */
function grantIdle<W extends WorkerRef, Q>(state: PoolState<W, Q>): PoolTransition<W, Q> {
  const idle = state.workers.filter((w) => w.status === "idle").map((w) => w.worker);
  const grants = R.zip(idle, state.queue);
  const leased = new Set(grants.map(([worker]) => worker));
  return step(
    {
      ...state,
      workers: state.workers.map((w) => (leased.has(w.worker) ? { ...w, status: "leased" } : w)),
      queue: state.queue.slice(grants.length),
    },
    grants.map(([worker, waiter]): PoolEffect<W, Q> => ({ type: "grant", worker, waiter })),
  );
}

/**
 * Spawn for every waiter and every worker still short of `min`, less the
 * spawns under way, room permitting. A waiter's worker counts toward `min`
 * once granted, so one spawn serves both.
 */
function spawnForDemand<W extends WorkerRef, Q>(state: PoolState<W, Q>): PoolTransition<W, Q> {
  const wanted = state.queue.length + (state.spawnFailed ? 0 : deficit(state)) - state.spawning;
  const spawns = Math.max(0, Math.min(wanted, room(state)));
  return step(
    { ...state, spawning: state.spawning + spawns },
    R.times(spawns, () => SPAWN),
  );
}

/**
 * While the crash-loop cap holds, nothing spawns for a waiter, since a spawn
 * would only die too: the queue waits for a busy worker, or fails if none is
 * busy.
 */
function holdOrFail<W extends WorkerRef, Q>(state: PoolState<W, Q>): PoolTransition<W, Q> {
  if (state.queue.length === 0 || state.workers.some((w) => w.status === "leased")) {
    return step(state, []);
  }
  return step(
    { ...state, queue: [] },
    state.queue.map((waiter) => reject(waiter, { kind: "crash_loop" })),
  );
}

// --- helpers ---

function crashLooping<W extends WorkerRef, Q>(state: PoolState<W, Q>): boolean {
  return state.earlyDeaths >= CRASH_LOOP_DEATHS;
}

/** Workers short of `min`, counting the live ones and one per waiter. */
function deficit<W extends WorkerRef, Q>(state: PoolState<W, Q>): number {
  const live = state.workers.filter((w) => w.status !== "dead").length;
  return Math.max(0, state.sizing.min - live - state.queue.length);
}

/** Slots below `max`, counting spawns under way and every worker not yet torn down. */
function room<W extends WorkerRef, Q>(state: PoolState<W, Q>): number {
  return state.sizing.max - state.workers.length - state.spawning;
}

function markDead<W extends WorkerRef>(
  workers: ReadonlyArray<PoolWorker<W>>,
  worker: W,
): ReadonlyArray<PoolWorker<W>> {
  return workers.map((w) => (w.worker === worker ? { ...w, status: "dead" } : w));
}

/** The worker's task returned: it goes `status`, unless it is dead already. */
function returnedTo<W extends WorkerRef>(
  workers: ReadonlyArray<PoolWorker<W>>,
  worker: W,
  status: "idle" | "dead",
): ReadonlyArray<PoolWorker<W>> {
  return workers.map((w) =>
    w.worker === worker
      ? { worker, status: w.status === "dead" ? "dead" : status, served: true }
      : w,
  );
}

/** Effects that name no worker, so they fit any machine. */
type RejectEffect<Q> = Extract<PoolEffect<never, Q>, { type: "reject" }>;
type LogEffect = Extract<PoolEffect<never, never>, { type: "log" }>;
const SPAWN = { type: "spawn" } as const;

function reject<Q>(waiter: Q, rejection: Rejection): RejectEffect<Q> {
  return { type: "reject", waiter, rejection };
}

function log(
  level: LogEffect["level"],
  message: string,
  fields: Record<string, unknown>,
): LogEffect {
  return { type: "log", level, message, fields };
}

function step<W extends WorkerRef, Q>(
  state: PoolState<W, Q>,
  effects: ReadonlyArray<PoolEffect<W, Q>>,
): PoolTransition<W, Q> {
  return { state, effects };
}
