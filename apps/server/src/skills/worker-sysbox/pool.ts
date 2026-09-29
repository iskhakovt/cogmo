import { randomUUID } from "node:crypto";
import { err, ok, Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { ResourceLimits, SandboxClient } from "../../sandbox/index.js";
import { describeError } from "../../util/describe-error.js";
import type { Death } from "../worker-state.js";
import {
  emptyPool,
  type PoolEffect,
  type PoolEvent,
  type PoolState,
  type PoolTransition,
  type Rejection,
  type TaskReturn,
  transition,
} from "./pool-state.js";
import {
  type InvokeParams,
  type InvokeResult,
  SysboxSkillWorker,
  type WorkerStatus,
} from "./worker.js";

const log = logger.child({ component: "skills.worker.sysbox.pool" });

export interface SysboxWorkerPoolOptions {
  sandbox: SandboxClient;
  image: string;
  /** Optional per-skill overrides applied to every worker in the pool. */
  resourceLimits?: Partial<ResourceLimits>;
  /**
   * Named Docker volume mounted at `/skill-venvs` on every worker. Same
   * value passed to all workers in the pool so a venv populated by
   * worker A is reused by worker B and survives recycle. Omit to run
   * without a persisted cache — each worker then populates its venvs
   * into its container overlay FS (and loses them on recycle).
   */
  depsCacheVolumeName?: string;

  /**
   * Always-warm worker count. ≥ 1 keeps interactive latency at the steady-
   * state ~300ms (fresh `python3 -u -c` exec on a live container) instead of
   * cold-start ~1-2 s (container create + boot). The pool replaces a
   * worker as soon as it dies, back up to `min`.
   */
  min: number;
  /**
   * Hard ceiling on concurrent workers. Personal-scale skill invocation
   * almost never hits this; it exists so a runaway loop can't fork-bomb the
   * sandbox. Tasks beyond `max` queue and wait for an idle worker. A worker
   * stops counting once its teardown starts, so while teardowns run the
   * sandbox can hold more than `max` containers.
   */
  max: number;
  /**
   * Recycle policy. After a worker has run `recycleAfterTasks` tasks it's
   * retired and replaced. Bounds drift in the shared container (sys.modules
   * accumulation, allocator fragmentation, tmpfs growth) independent of
   * per-task python-process restart.
   */
  recycleAfterTasks: number;
  /**
   * Wall-clock ceiling on a worker's age. Workers older than this are
   * retired when their next task returns, even if they haven't hit
   * `recycleAfterTasks`. Catches the long-idle case (worker sat warm for
   * days, libc state stale).
   */
  recycleAfterMs: number;
  /**
   * Workers idle longer than this are torn down (down to `min`). Sweep runs
   * on `idleSweepIntervalMs` cadence.
   */
  idleShutdownMs: number;
  idleSweepIntervalMs: number;

  /**
   * Test seam — replace the worker factory. Production wiring uses the
   * default which calls `SysboxSkillWorker.create`.
   */
  createWorker?: (opts: {
    workerId: string;
    sandbox: SandboxClient;
    image: string;
    resourceLimits?: Partial<ResourceLimits>;
    expiresAt: Date;
    depsCacheVolumeName?: string;
    /** Aborted when the pool is disposed; the worker dies with it. */
    signal: AbortSignal;
  }) => Promise<WorkerHandle>;

  /** Test seam — replace the timer source. Defaults to `setInterval` / `clearInterval`. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;

  /** Test seam — replace the wall clock. */
  now?: () => number;
}

/**
 * Minimal worker contract the pool depends on. `SysboxSkillWorker` is the
 * production implementation; tests provide a fake by setting `createWorker`
 * in the pool options.
 */
export interface WorkerHandle {
  readonly workerId: string;
  readonly state: WorkerStatus;
  readonly taskCount: number;
  /** Resolves once the worker can run no further task, with who ended it and why. */
  readonly dead: Promise<Death>;
  /** Resolves once the worker is dead and no task holds it: its container can go. */
  readonly disposable: Promise<void>;
  idleMs(now: number): number;
  ageMs(now: number): number;
  /** Lease the worker for one task; errs with why it can't be. */
  tryAcquire(): Result<void, string>;
  /** Give back what `tryAcquire` took; errs with why if nothing was held. */
  release(): Result<void, string>;
  retire(): void;
  invoke(params: InvokeParams): Promise<InvokeResult>;
  dispose(): Promise<void>;
}

interface PendingWaiter {
  resolve: (worker: WorkerHandle) => void;
  reject: (err: Error) => void;
}

type Event = PoolEvent<WorkerHandle, PendingWaiter>;

/**
 * Margin between the pool's wall-clock recycle ceiling and the sandbox
 * reaper's `expiresAt`. Sized so the pool's own recycle policy fires first
 * during normal operation; the reaper is the safety net for crashed Cogmo,
 * not part of the steady-state lifecycle. Symmetric in intent with
 * `REAPER_BACKSTOP_S` in `host.ts` (per-task one-shots use a 30 s margin
 * because they're short-lived; pool workers ride the recycle ceiling so
 * the margin is hours, not seconds).
 */
const REAPER_BACKSTOP_MS = 60 * 60 * 1000;

export const DEFAULT_POOL_OPTIONS = {
  min: 1,
  max: 3,
  recycleAfterTasks: 500,
  recycleAfterMs: 24 * 60 * 60 * 1000,
  idleShutdownMs: 30 * 60 * 1000,
  idleSweepIntervalMs: 60 * 1000,
} satisfies Pick<
  SysboxWorkerPoolOptions,
  "min" | "max" | "recycleAfterTasks" | "recycleAfterMs" | "idleShutdownMs" | "idleSweepIntervalMs"
>;

/**
 * Pool of warm sysbox containers shared across skill invocations. See
 * `design/skills.md` `## Warm pool`.
 *
 * The shell around the pool machine (`pool-state.ts`): it feeds the machine
 * acquires, spawn outcomes, each worker's `dead` and `disposable`, returning
 * tasks, sweeps and disposal, and carries out the effects it returns —
 * spawn, grant, reject, retire, release, tear down. Every decision is the
 * machine's; the shell only asks the workers and reports their answers.
 *
 * `dispose()` aborts the signal every worker was created with: a live
 * worker's channel closes, and a spawn stops at its next step. It rejects
 * every queued acquire, tears down every container, and returns once every
 * spawn and teardown, those already under way included, has finished.
 * Idempotent.
 */
export class SysboxWorkerPool {
  #sandbox: SandboxClient;
  #image: string;
  #resourceLimits: Partial<ResourceLimits> | undefined;
  #depsCacheVolumeName: string | undefined;
  #idleSweepIntervalMs: number;
  #state: PoolState<WorkerHandle, PendingWaiter>;
  /** Spawns under way, each settling once the machine has taken its outcome. */
  #spawns = new Set<Promise<Result<void, unknown>>>();
  /** Container teardowns under way. */
  #teardowns = new Set<Promise<void>>();
  /** Aborted by `dispose()`. Every worker is created with its signal. */
  #lifetime = new AbortController();
  #disposal: Promise<void> | undefined;
  #createWorker: NonNullable<SysboxWorkerPoolOptions["createWorker"]>;
  #setInterval: (cb: () => void, ms: number) => unknown;
  #clearInterval: (handle: unknown) => void;
  #now: () => number;
  #sweepHandle: unknown = null;

  private constructor(opts: SysboxWorkerPoolOptions) {
    this.#sandbox = opts.sandbox;
    this.#image = opts.image;
    this.#resourceLimits = opts.resourceLimits;
    this.#depsCacheVolumeName = opts.depsCacheVolumeName;
    this.#idleSweepIntervalMs = opts.idleSweepIntervalMs;
    this.#state = emptyPool({
      min: opts.min,
      max: opts.max,
      recycleAfterTasks: opts.recycleAfterTasks,
      recycleAfterMs: opts.recycleAfterMs,
      idleShutdownMs: opts.idleShutdownMs,
    });
    this.#createWorker = opts.createWorker ?? SysboxSkillWorker.create;
    this.#setInterval =
      opts.setInterval ??
      ((cb: () => void, ms: number): unknown => {
        const h = setInterval(cb, ms);
        h.unref?.();
        return h;
      });
    this.#clearInterval =
      opts.clearInterval ??
      // Paired with the default `setInterval` above, whose handle this gets
      // back; the seam types it `unknown` so a test's timer can use any token.
      ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>));
    this.#now = opts.now ?? Date.now;

    if (opts.min < 0 || opts.max < 1 || opts.max < opts.min) {
      throw new Error(
        `invalid pool sizing: min=${opts.min} max=${opts.max} (need 0 ≤ min ≤ max, max ≥ 1)`,
      );
    }
  }

  static async create(opts: SysboxWorkerPoolOptions): Promise<SysboxWorkerPool> {
    const pool = new SysboxWorkerPool(opts);
    // Spawn the always-warm `min` workers eagerly so first-invoke latency is
    // steady-state, not cold. A failed spawn fails boot — a misconfigured
    // pool (bad image, sandbox unreachable) should not lurk until the first
    // invocation — once every spawn has settled, and after disposing the
    // pool, so no container that did come up outlives it.
    pool.#feed({ type: "boot" });
    const booted = Result.combine(await Promise.all(pool.#spawns));
    if (booted.isErr()) {
      await pool.dispose();
      throw booted.error instanceof Error ? booted.error : new Error(String(booted.error));
    }
    pool.#feed({ type: "booted" });
    pool.#sweepHandle = pool.#setInterval(() => pool.#sweep(), pool.#idleSweepIntervalMs);
    return pool;
  }

  /**
   * Run one task. Acquires a worker — idle, spawned for it below `max`, or
   * freed while it queued — invokes the task, and gives the worker back.
   */
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    if (this.#state.phase === "disposed") {
      throw new Error("SysboxWorkerPool: invoke after dispose");
    }
    const worker = await this.#acquire();
    // `worker.invoke` returns a task's failures as `ok: false`; a throw is a bug.
    let returned: TaskReturn = { kind: "threw" };
    try {
      const result = await worker.invoke(params);
      returned =
        worker.state === "busy"
          ? { kind: "alive", taskCount: worker.taskCount, ageMs: worker.ageMs(this.#now()) }
          : { kind: "dead" };
      return result;
    } finally {
      this.#feed({ type: "task_returned", worker, returned });
    }
  }

  /** Snapshot of pool size + state for tests / logs. */
  stats(): { total: number; idle: number; busy: number; dead: number; queued: number } {
    const workers = this.#state.workers.map((w) => w.worker);
    const count = (status: WorkerStatus): number =>
      workers.filter((w) => w.state === status).length;
    return {
      total: workers.length,
      idle: count("idle"),
      busy: count("busy"),
      dead: count("dead"),
      queued: this.#state.queue.length,
    };
  }

  /** Every call returns the one disposal. */
  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    this.#lifetime.abort(new Error("SysboxWorkerPool: disposed"));
    if (this.#sweepHandle !== null) {
      this.#clearInterval(this.#sweepHandle);
      this.#sweepHandle = null;
    }
    this.#feed({ type: "dispose" });
    // A spawn that lands now is torn down, so wait until neither is left.
    while (this.#spawns.size + this.#teardowns.size > 0) {
      await Promise.allSettled([...this.#spawns, ...this.#teardowns]);
    }
  }

  // --- internals ---

  #acquire(): Promise<WorkerHandle> {
    const { promise, resolve, reject } = Promise.withResolvers<WorkerHandle>();
    this.#feed({ type: "acquire", waiter: { resolve, reject } });
    return promise;
  }

  #sweep(): void {
    const now = this.#now();
    const idleMs = new Map(
      this.#state.workers.map(({ worker }): [WorkerHandle, number] => [worker, worker.idleMs(now)]),
    );
    this.#feed({ type: "sweep", idleMs });
  }

  #feed(event: Event): void {
    this.#enter(transition(this.#state, event));
  }

  /** Move to the next state and carry out its effects, in order; events they raise follow. */
  #enter(next: PoolTransition<WorkerHandle, PendingWaiter>): void {
    this.#state = next.state;
    const raised = next.effects.flatMap((effect) => this.#execute(effect));
    for (const event of raised) this.#feed(event);
  }

  #execute(effect: PoolEffect<WorkerHandle, PendingWaiter>): ReadonlyArray<Event> {
    return match(effect)
      .returnType<ReadonlyArray<Event>>()
      .with({ type: "spawn" }, () => {
        this.#spawn();
        return [];
      })
      .with({ type: "grant" }, ({ worker, waiter }) => this.#grant(worker, waiter))
      .with({ type: "reject" }, ({ waiter, rejection }) => {
        waiter.reject(rejectionError(rejection));
        return [];
      })
      .with({ type: "retire" }, ({ worker }) => {
        worker.retire();
        return [];
      })
      .with({ type: "release" }, ({ worker }) => {
        const released = worker.release();
        if (released.isErr()) {
          log.warn({ workerId: worker.workerId, reason: released.error }, "worker release refused");
        }
        return [];
      })
      .with({ type: "teardown" }, ({ worker }) => {
        this.#teardown(worker);
        return [];
      })
      .with({ type: "log" }, ({ level, message, fields }) => {
        log[level](fields, message);
        return [];
      })
      .exhaustive();
  }

  /**
   * Create a worker and report how it went. The pool hears of the worker's
   * death and disposability from the moment it takes the worker in.
   */
  #spawn(): void {
    const spawn: Promise<Result<void, unknown>> = this.#createOne()
      .then(
        (worker): Result<void, unknown> => {
          void worker.dead.then((death) =>
            this.#feed({ type: "died", worker, death, ageMs: worker.ageMs(this.#now()) }),
          );
          void worker.disposable.then(() => this.#feed({ type: "disposable", worker }));
          this.#feed({ type: "spawned", worker });
          return ok(undefined);
        },
        (error: unknown): Result<void, unknown> => {
          this.#feed({ type: "spawn_failed", error });
          return err(error);
        },
      )
      .finally(() => {
        this.#spawns.delete(spawn);
      });
    this.#spawns.add(spawn);
  }

  async #createOne(): Promise<WorkerHandle> {
    // workerId doubles as the sandbox `taskId`, which the cgroup-parent
    // helper validates as a UUID (defence-in-depth — the id is forwarded
    // into `HostConfig.CgroupParent`'s systemd unit name). Plain
    // `randomUUID()` so logs / lineage labels carry a real id, and the
    // sandbox layer accepts it without fixing up the slice name.
    return this.#createWorker({
      workerId: randomUUID(),
      sandbox: this.#sandbox,
      image: this.#image,
      ...(this.#resourceLimits !== undefined && { resourceLimits: this.#resourceLimits }),
      expiresAt: new Date(this.#now() + this.#state.sizing.recycleAfterMs + REAPER_BACKSTOP_MS),
      ...(this.#depsCacheVolumeName !== undefined && {
        depsCacheVolumeName: this.#depsCacheVolumeName,
      }),
      signal: this.#lifetime.signal,
    });
  }

  /** Lease `worker` to `waiter` if the worker takes the lease; its refusal goes back to the machine. */
  #grant(worker: WorkerHandle, waiter: PendingWaiter): ReadonlyArray<Event> {
    const lease = worker.tryAcquire();
    if (lease.isErr()) {
      log.debug({ workerId: worker.workerId, reason: lease.error }, "worker refused its lease");
      return [{ type: "grant_refused", worker, waiter }];
    }
    waiter.resolve(worker);
    return [];
  }

  #teardown(worker: WorkerHandle): void {
    const teardown: Promise<void> = worker
      .dispose()
      .catch((e: unknown) => {
        log.warn({ workerId: worker.workerId, err: describeError(e) }, "worker teardown failed");
      })
      .finally(() => {
        this.#teardowns.delete(teardown);
      });
    this.#teardowns.add(teardown);
  }
}

function rejectionError(rejection: Rejection): Error {
  return match(rejection)
    .returnType<Error>()
    .with(
      { kind: "disposed" },
      () => new Error("SysboxWorkerPool: disposed before worker available"),
    )
    .with(
      { kind: "crash_loop" },
      () => new Error("skills workers keep dying before their first task"),
    )
    .with({ kind: "spawn_failed" }, ({ error }) =>
      error instanceof Error ? error : new Error(String(error)),
    )
    .exhaustive();
}
