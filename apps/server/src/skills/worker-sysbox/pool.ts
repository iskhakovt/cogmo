import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import type { ResourceLimits, SandboxClient } from "../../sandbox/index.js";
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
   * sandbox. Tasks beyond `max` queue and wait for an idle worker.
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
   * drained even if they haven't hit `recycleAfterTasks`. Catches the long-
   * idle case (worker sat warm for days, libc state stale).
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
  /** Resolves with the reason once the worker can run no further task, whatever the cause. */
  readonly dead: Promise<string>;
  /** Resolves once the worker is dead and no task holds it: its container can go. */
  readonly disposable: Promise<void>;
  idleMs(now: number): number;
  ageMs(now: number): number;
  tryAcquire(): boolean;
  /** Give back what `tryAcquire` took. False if nothing was held. */
  release(): boolean;
  retire(): void;
  invoke(params: InvokeParams): Promise<InvokeResult>;
  dispose(): Promise<void>;
}

interface PendingWaiter {
  resolve: (worker: WorkerHandle) => void;
  reject: (err: Error) => void;
}

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

/**
 * Internal sentinel for `dispose()` racing an in-flight `#spawnOne()`. Caller
 * paths (eager `create()`, on-demand acquire, replacement on death) all unwind
 * uniformly: foreground awaits surface it; background `void.catch` paths
 * recognise it and stay silent. Not exported — callers see it as a thrown
 * `Error` instance, not as a typed branch in their own logic.
 */
class PoolDisposedDuringSpawnError extends Error {
  constructor() {
    super("SysboxWorkerPool: disposed during worker spawn");
    this.name = "PoolDisposedDuringSpawnError";
  }
}

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
 * Concurrency model:
 *  - `invoke` first tries to acquire an existing idle worker.
 *  - If none and the pool hasn't hit `max`, spawn a new worker and acquire it.
 *  - If at `max`, queue and wait. The next worker to release wakes the queue.
 *
 * Lifecycle:
 *  - The pool subscribes to each worker's `dead` and `disposable` as it
 *    spawns it. The moment a worker dies — its supervisor went away, a task
 *    left it unreusable, or the pool retired it — the pool spawns a
 *    replacement up to `min`, room permitting. The dead worker's container
 *    goes once it is disposable: at once, or once the task holding it
 *    returns; until then it still counts toward `max`. Its freed slot goes
 *    to a queued acquirer first.
 *  - The pool retires a worker after its task once taskCount ≥
 *    `recycleAfterTasks` or age ≥ `recycleAfterMs`.
 *  - An interval sweep retires idle workers above `min` after `idleShutdownMs`,
 *    and spawns back up to `min` when a replacement failed.
 *  - `dispose()` aborts the signal every worker was created with: a live
 *    worker's channel closes, and a spawn stops at its next step. It then
 *    cancels the sweep, rejects all queued waiters, and tears down every
 *    container. Idempotent.
 */
export class SysboxWorkerPool {
  #sandbox: SandboxClient;
  #image: string;
  #resourceLimits: Partial<ResourceLimits> | undefined;
  #depsCacheVolumeName: string | undefined;
  #opts: Required<
    Pick<
      SysboxWorkerPoolOptions,
      | "min"
      | "max"
      | "recycleAfterTasks"
      | "recycleAfterMs"
      | "idleShutdownMs"
      | "idleSweepIntervalMs"
    >
  >;
  /** Every worker whose container lives, dead ones a task still holds included. */
  #workers: WorkerHandle[] = [];
  #queue: PendingWaiter[] = [];
  /** Aborted by `dispose()`. Every worker is created with its signal. */
  #lifetime = new AbortController();
  #createWorker: NonNullable<SysboxWorkerPoolOptions["createWorker"]>;
  #setInterval: (cb: () => void, ms: number) => unknown;
  #clearInterval: (handle: unknown) => void;
  #now: () => number;
  #sweepHandle: unknown = null;
  /**
   * In-flight `#spawnOne` promises. Tracked as a count for `#acquire`'s
   * "have we already committed up to max?" math, and as a set of promises
   * so `dispose()` can wait on every spawn to settle before returning —
   * otherwise a spawn that resolves *after* `dispose()` returns would
   * dispose its own worker (via the aborted-signal check in `#runSpawn`),
   * but that teardown happens in the background and the caller's `await
   * dispose()` would have already resolved with the container still in
   * shutdown.
   */
  #pendingSpawns = 0;
  #pendingSpawnPromises = new Set<Promise<unknown>>();

  private constructor(opts: SysboxWorkerPoolOptions) {
    this.#sandbox = opts.sandbox;
    this.#image = opts.image;
    this.#resourceLimits = opts.resourceLimits;
    this.#depsCacheVolumeName = opts.depsCacheVolumeName;
    this.#opts = {
      min: opts.min,
      max: opts.max,
      recycleAfterTasks: opts.recycleAfterTasks,
      recycleAfterMs: opts.recycleAfterMs,
      idleShutdownMs: opts.idleShutdownMs,
      idleSweepIntervalMs: opts.idleSweepIntervalMs,
    };
    this.#createWorker =
      opts.createWorker ??
      (async (o) =>
        SysboxSkillWorker.create({
          workerId: o.workerId,
          sandbox: o.sandbox,
          image: o.image,
          ...(o.resourceLimits !== undefined && { resourceLimits: o.resourceLimits }),
          expiresAt: o.expiresAt,
          ...(o.depsCacheVolumeName !== undefined && {
            depsCacheVolumeName: o.depsCacheVolumeName,
          }),
          signal: o.signal,
        }));
    this.#setInterval =
      opts.setInterval ??
      ((cb: () => void, ms: number): unknown => {
        const h = setInterval(cb, ms);
        h.unref?.();
        return h;
      });
    this.#clearInterval =
      opts.clearInterval ??
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
    // steady-state, not cold. Spawn failures here propagate — a misconfigured
    // pool (bad image, sandbox unreachable) should fail boot, not lurk and
    // surface on the first user invocation.
    //
    // Use `allSettled` so one rejection doesn't strand parallel spawns: if
    // spawn #2 fails after spawn #1 has already pushed its worker into
    // `#workers`, a bare `Promise.all` would rethrow before disposing #1, and
    // the caller (whose only handle to the pool was the `create()` return
    // value they never received) couldn't tear it down. Disposing on any
    // failure tears down every container that did come up before rethrowing.
    if (pool.#opts.min > 0) {
      const settled = await Promise.allSettled(
        Array.from({ length: pool.#opts.min }, () => pool.#spawnOne()),
      );
      const firstFailure = settled.find((r) => r.status === "rejected");
      if (firstFailure) {
        await pool.dispose();
        throw firstFailure.reason instanceof Error
          ? firstFailure.reason
          : new Error(String(firstFailure.reason));
      }
    }
    pool.#sweepHandle = pool.#setInterval(() => pool.#sweepIdle(), pool.#opts.idleSweepIntervalMs);
    return pool;
  }

  /**
   * Run one task. Acquires an idle worker (spawning if needed and below
   * `max`), invokes the task, releases or recycles the worker, and returns.
   */
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    if (this.#lifetime.signal.aborted) {
      throw new Error("SysboxWorkerPool: invoke after dispose");
    }
    const worker = await this.#acquire();
    try {
      return await worker.invoke(params);
    } catch (e) {
      // worker.invoke returns its failures as ok=false — this path is for
      // bugs (precondition asserts, etc.). Retire the worker.
      worker.retire();
      throw e;
    } finally {
      this.#postInvoke(worker);
    }
  }

  /** Snapshot of pool size + state for tests / logs. */
  stats(): { total: number; idle: number; busy: number; dead: number; queued: number } {
    const count = (status: WorkerStatus): number =>
      this.#workers.filter((w) => w.state === status).length;
    return {
      total: this.#workers.length,
      idle: count("idle"),
      busy: count("busy"),
      dead: count("dead"),
      queued: this.#queue.length,
    };
  }

  async dispose(): Promise<void> {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(new Error("SysboxWorkerPool: disposed"));
    if (this.#sweepHandle !== null) {
      this.#clearInterval(this.#sweepHandle);
      this.#sweepHandle = null;
    }
    const queued = this.#queue.splice(0, this.#queue.length);
    for (const w of queued) {
      w.reject(new Error("SysboxWorkerPool: disposed before worker available"));
    }
    // Dead workers a task still holds are here too: their containers go now.
    const workers = this.#workers.splice(0, this.#workers.length);
    // Wait on already-spawned workers in parallel with any in-flight spawns;
    // the in-flight ones stop on the aborted signal and tear down whatever
    // they had set up. Awaiting both ensures `dispose()` doesn't return
    // until every container the pool ever spawned is gone.
    const pending = Array.from(this.#pendingSpawnPromises);
    await Promise.allSettled([...workers.map((w) => w.dispose()), ...pending]);
  }

  // --- internals ---

  async #acquire(): Promise<WorkerHandle> {
    const idle = this.#acquireIdle();
    if (idle) return idle;
    // Spawn if there's room. Counting in-flight spawns prevents a
    // thundering herd of invokes from overshooting `max` while one spawn is
    // still resolving.
    if (this.#hasRoom()) {
      const w = await this.#spawnOne();
      if (w.tryAcquire()) return w;
      // Lost the race for the worker we just spawned, or it is already
      // dead. Some *other* worker may have gone idle while we awaited the
      // spawn (a parallel task finished, queue handover took ours).
      const other = this.#acquireIdle();
      if (other) return other;
    }
    return new Promise<WorkerHandle>((resolve, reject) => {
      this.#queue.push({ resolve, reject });
    });
  }

  /** Lease the first idle worker, if any. */
  #acquireIdle(): WorkerHandle | undefined {
    for (const w of this.#workers) {
      if (w.tryAcquire()) return w;
    }
    return undefined;
  }

  /** Below `max`, counting in-flight spawns and every live container. */
  #hasRoom(): boolean {
    return this.#workers.length + this.#pendingSpawns < this.#opts.max;
  }

  #spawnOne(): Promise<WorkerHandle> {
    if (this.#lifetime.signal.aborted) {
      return Promise.reject(new PoolDisposedDuringSpawnError());
    }
    const promise = this.#runSpawn();
    this.#pendingSpawnPromises.add(promise);
    void promise
      .catch(() => {})
      .finally(() => {
        this.#pendingSpawnPromises.delete(promise);
      });
    return promise;
  }

  async #runSpawn(): Promise<WorkerHandle> {
    this.#pendingSpawns += 1;
    try {
      // workerId doubles as the sandbox `taskId`, which the cgroup-parent
      // helper validates as a UUID (defence-in-depth — the id is forwarded
      // into `HostConfig.CgroupParent`'s systemd unit name). Plain
      // `randomUUID()` so logs / lineage labels carry a real id, and the
      // sandbox layer accepts it without fixing up the slice name.
      const workerId = randomUUID();
      const expiresAt = new Date(this.#now() + this.#opts.recycleAfterMs + REAPER_BACKSTOP_MS);
      const w = await this.#createWorker({
        workerId,
        sandbox: this.#sandbox,
        image: this.#image,
        ...(this.#resourceLimits !== undefined && { resourceLimits: this.#resourceLimits }),
        expiresAt,
        ...(this.#depsCacheVolumeName !== undefined && {
          depsCacheVolumeName: this.#depsCacheVolumeName,
        }),
        signal: this.#lifetime.signal,
      }).catch((e: unknown) => {
        // A spawn that disposal cut short fails as one, like any other.
        throw this.#lifetime.signal.aborted ? new PoolDisposedDuringSpawnError() : e;
      });
      // `createWorker` is async; `dispose()` may have run while we were
      // awaiting it. Pushing the new worker into `#workers` now would leak
      // its container — `dispose()` already iterated and won't see it. Tear
      // down the new worker and surface a typed disposed-error so the
      // caller's invoke / queued waiter rejects cleanly.
      if (this.#lifetime.signal.aborted) {
        await w.dispose().catch((e: unknown) => {
          log.warn(
            { workerId, err: e instanceof Error ? e.message : String(e) },
            "post-dispose orphan worker dispose failed",
          );
        });
        throw new PoolDisposedDuringSpawnError();
      }
      this.#workers.push(w);
      void w.dead.then((reason) => this.#onDead(w, reason));
      void w.disposable.then(() => this.#onDisposable(w));
      return w;
    } finally {
      this.#pendingSpawns -= 1;
    }
  }

  /**
   * Give a worker back once its task returns: retired first at a recycle
   * threshold, then released — a live worker goes idle and passes to a
   * queued waiter, a dead one becomes disposable. The age check fires only
   * on task return — a workers-of-min that ages past recycleAfterMs with no
   * active tasks is *not* swept by `#sweepIdle` (sweep refuses to drop below
   * `min`), so it lives until the next invocation. That's intentional: idle
   * staleness doesn't grow without active work; the reaper backstops the
   * pathological "crashed and never came back" case.
   */
  #postInvoke(worker: WorkerHandle): void {
    if (worker.state === "busy") {
      const taskCap = worker.taskCount >= this.#opts.recycleAfterTasks;
      const ageCap = worker.ageMs(this.#now()) >= this.#opts.recycleAfterMs;
      if (taskCap || ageCap) {
        log.debug(
          { workerId: worker.workerId, taskCount: worker.taskCount, taskCap, ageCap },
          "recycling worker — cap reached",
        );
        worker.retire();
      }
    }
    if (!worker.release()) {
      log.warn({ workerId: worker.workerId }, "released a worker no task held");
    }
    if (worker.state !== "idle") return;
    // Hand the just-released worker to a queued waiter, if any.
    const waiter = this.#queue.shift();
    if (waiter) {
      if (worker.tryAcquire()) {
        waiter.resolve(worker);
      } else {
        // Shouldn't happen — we just released it. Re-queue defensively.
        this.#queue.unshift(waiter);
      }
    }
  }

  /**
   * Replace a worker the moment it dies. Its container stays, still
   * counted toward `max`, until `disposable` — while a task holds it, the
   * task may still be using it.
   */
  #onDead(worker: WorkerHandle, reason: string): void {
    if (this.#lifetime.signal.aborted) return;
    log.debug({ workerId: worker.workerId, reason }, "worker died");
    this.#replenishToMin();
  }

  /** Tear a dead worker down once no task holds it, and fill the slot it frees. */
  #onDisposable(worker: WorkerHandle): void {
    // After `dispose()`, which tears every worker down itself.
    if (this.#lifetime.signal.aborted) return;
    const idx = this.#workers.indexOf(worker);
    if (idx >= 0) this.#workers.splice(idx, 1);
    void worker.dispose().catch((e: unknown) => {
      log.warn(
        { workerId: worker.workerId, err: e instanceof Error ? e.message : String(e) },
        "worker dispose failed during recycle",
      );
    });
    this.#serveQueue();
    this.#replenishToMin();
  }

  #replenishToMin(): void {
    if (this.#lifetime.signal.aborted) return;
    const live = this.#workers.filter((w) => w.state !== "dead").length;
    if (live + this.#pendingSpawns < this.#opts.min && this.#hasRoom()) {
      // An acquire that queued meanwhile gets the new worker; with nobody
      // queued it stays idle.
      this.#spawnForQueue();
    }
  }

  /** A queued acquirer and room to spawn for it: spawn. */
  #serveQueue(): void {
    if (!this.#lifetime.signal.aborted && this.#queue.length > 0 && this.#hasRoom()) {
      this.#spawnForQueue();
    }
  }

  /**
   * Spawn a worker in the background and hand it to the head of the queue,
   * or leave it idle. A spawn that fails fails the head waiter, which would
   * otherwise wait on a worker that is never coming.
   */
  #spawnForQueue(): void {
    void this.#spawnOne().then(
      (w) => {
        const waiter = this.#queue.shift();
        if (!waiter) return;
        if (w.tryAcquire()) {
          waiter.resolve(w);
        } else {
          // Lost the race to another acquirer, or already dead: back into
          // the queue, served when a worker frees or its slot does.
          this.#queue.unshift(waiter);
        }
      },
      (e: unknown) => {
        if (e instanceof PoolDisposedDuringSpawnError) return;
        const waiter = this.#queue.shift();
        if (waiter) {
          waiter.reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "replacement worker spawn failed; pool below min until the next sweep or invoke",
        );
      },
    );
  }

  /**
   * Retire idle workers above `min` that have sat past `idleShutdownMs` —
   * each dies on retirement, and is torn down as it becomes disposable —
   * and spawn back up to `min`, retrying a replacement that failed.
   */
  #sweepIdle(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#replenishToMin();
    const now = this.#now();
    const candidates = this.#workers.filter(
      (w) => w.state === "idle" && w.idleMs(now) >= this.#opts.idleShutdownMs,
    );
    // Keep at least `min` workers alive; only sweep the surplus.
    const idleCount = this.#workers.filter((w) => w.state === "idle").length;
    const surplus = Math.max(0, idleCount - this.#opts.min);
    for (const w of candidates.slice(0, surplus)) {
      log.debug({ workerId: w.workerId, idleMs: w.idleMs(now) }, "sweeping idle worker");
      w.retire();
    }
  }
}
