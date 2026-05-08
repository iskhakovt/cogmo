import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import type { ResourceLimits, SandboxClient } from "../../sandbox/index.js";
import type { CtxHandler } from "../dispatcher.js";
import type { RunTaskOnSessionParams, RunTaskOnSessionResult } from "./host.js";
import { SysboxSkillWorker } from "./worker.js";

const log = logger.child({ component: "skills.worker.sysbox.pool" });

export interface SysboxWorkerPoolOptions {
  sandbox: SandboxClient;
  image: string;
  /** Optional per-skill overrides applied to every worker in the pool. */
  resourceLimits?: Partial<ResourceLimits>;

  /**
   * Always-warm worker count. ≥ 1 keeps interactive latency at the steady-
   * state ~300ms (fresh `python3 -u -c` exec on a live container) instead of
   * cold-start ~1-2 s (container create + boot). Pool replenishes lazily
   * back to `min` on the next invocation after a worker is drained.
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
   * drained and replaced lazily on the next invoke. Bounds drift in the
   * shared container (sys.modules accumulation, allocator fragmentation,
   * tmpfs growth) independent of per-task python-process restart.
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
  }) => Promise<WorkerHandle>;

  /** Test seam — replace the timer source. Defaults to `setInterval` / `clearInterval`. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;

  /** Test seam — replace the wall clock. */
  now?: () => number;

  /** Optional prefix for `workerId`. Defaults to `skills-worker`. */
  workerIdPrefix?: string;
}

/**
 * Minimal worker contract the pool depends on. `SysboxSkillWorker` is the
 * production implementation; tests provide a fake by setting `createWorker`
 * in the pool options.
 */
export interface WorkerHandle {
  readonly workerId: string;
  readonly state: "idle" | "busy" | "draining" | "disposed";
  readonly taskCount: number;
  idleMs(now: number): number;
  ageMs(now: number): number;
  tryAcquire(): boolean;
  release(): void;
  markPoisoned(): void;
  invoke(
    params: RunTaskOnSessionParams & { ctxHandler: CtxHandler },
  ): Promise<RunTaskOnSessionResult>;
  dispose(): Promise<void>;
}

interface PendingWaiter {
  resolve: (worker: WorkerHandle) => void;
  reject: (err: Error) => void;
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
 *  - Workers are recycled (drained + disposed + replaced lazily) when
 *    taskCount ≥ `recycleAfterTasks`, age ≥ `recycleAfterMs`, or `markPoisoned`
 *    is called by `invoke` after a non-reusable result.
 *  - An interval sweep drops idle workers above `min` after `idleShutdownMs`.
 *  - `dispose()` cancels the sweep, rejects all queued waiters, and tears
 *    down every worker. Idempotent.
 */
export class SysboxWorkerPool {
  #sandbox: SandboxClient;
  #image: string;
  #resourceLimits: Partial<ResourceLimits> | undefined;
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
  #workers: WorkerHandle[] = [];
  #queue: PendingWaiter[] = [];
  #disposed = false;
  #createWorker: NonNullable<SysboxWorkerPoolOptions["createWorker"]>;
  #setInterval: (cb: () => void, ms: number) => unknown;
  #clearInterval: (handle: unknown) => void;
  #now: () => number;
  #workerIdPrefix: string;
  #sweepHandle: unknown = null;
  /**
   * Promise of the most recent in-flight worker spawn. Lets parallel
   * `invoke`s collapse onto the same spawn instead of each starting their
   * own (which would push pool size past `max` for a tick before the
   * resolutions fire).
   */
  #pendingSpawns = 0;

  private constructor(opts: SysboxWorkerPoolOptions) {
    this.#sandbox = opts.sandbox;
    this.#image = opts.image;
    this.#resourceLimits = opts.resourceLimits;
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
    this.#workerIdPrefix = opts.workerIdPrefix ?? "skills-worker";

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
    if (pool.#opts.min > 0) {
      await Promise.all(Array.from({ length: pool.#opts.min }, () => pool.#spawnOne()));
    }
    pool.#sweepHandle = pool.#setInterval(() => pool.#sweepIdle(), pool.#opts.idleSweepIntervalMs);
    return pool;
  }

  /**
   * Run one task. Acquires an idle worker (spawning if needed and below
   * `max`), invokes the task, releases or recycles the worker, and returns.
   */
  async invoke(
    params: RunTaskOnSessionParams & { ctxHandler: CtxHandler },
  ): Promise<RunTaskOnSessionResult> {
    if (this.#disposed) {
      throw new Error("SysboxWorkerPool: invoke after dispose");
    }
    const worker = await this.#acquire();
    try {
      const result = await worker.invoke(params);
      this.#postInvoke(worker);
      return result;
    } catch (e) {
      // worker.invoke catches its own errors and returns ok=false — this
      // path is for synchronous bugs (precondition asserts, etc.). Drain.
      worker.markPoisoned();
      this.#postInvoke(worker);
      throw e;
    }
  }

  /** Snapshot of pool size + state for tests / logs. */
  stats(): { total: number; idle: number; busy: number; draining: number; queued: number } {
    let idle = 0;
    let busy = 0;
    let draining = 0;
    for (const w of this.#workers) {
      if (w.state === "idle") idle += 1;
      else if (w.state === "busy") busy += 1;
      else if (w.state === "draining") draining += 1;
    }
    return { total: this.#workers.length, idle, busy, draining, queued: this.#queue.length };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#sweepHandle !== null) {
      this.#clearInterval(this.#sweepHandle);
      this.#sweepHandle = null;
    }
    const queued = this.#queue.splice(0, this.#queue.length);
    for (const w of queued) {
      w.reject(new Error("SysboxWorkerPool: disposed before worker available"));
    }
    const workers = this.#workers.splice(0, this.#workers.length);
    await Promise.all(workers.map((w) => w.dispose()));
  }

  // --- internals ---

  async #acquire(): Promise<WorkerHandle> {
    // Fast path: an existing idle worker.
    for (const w of this.#workers) {
      if (w.tryAcquire()) {
        return w;
      }
    }
    // Spawn if there's room. `#workers.length + #pendingSpawns` is the
    // committed pool size — counting in-flight spawns prevents a thundering
    // herd of invokes from overshooting `max` while one spawn is still
    // resolving.
    if (this.#workers.length + this.#pendingSpawns < this.#opts.max) {
      const w = await this.#spawnOne();
      // Worker was just spawned and may be in the workers list; race with
      // another acquirer is fine — tryAcquire is atomic at the state level.
      if (w.tryAcquire()) {
        return w;
      }
      // Lost the race; fall through to queue.
    }
    // At max: queue.
    return new Promise<WorkerHandle>((resolve, reject) => {
      this.#queue.push({ resolve, reject });
    });
  }

  async #spawnOne(): Promise<WorkerHandle> {
    this.#pendingSpawns += 1;
    try {
      const workerId = `${this.#workerIdPrefix}-${randomUUID().slice(0, 8)}`;
      // expiresAt = recycle ceiling + 1h margin. The reaper backstops crashed
      // Cogmo (so a worker container can't outlive its owner indefinitely)
      // but should never beat the pool's own recycle policy.
      const expiresAt = new Date(this.#now() + this.#opts.recycleAfterMs + 60 * 60 * 1000);
      const w = await this.#createWorker({
        workerId,
        sandbox: this.#sandbox,
        image: this.#image,
        ...(this.#resourceLimits !== undefined && { resourceLimits: this.#resourceLimits }),
        expiresAt,
      });
      this.#workers.push(w);
      return w;
    } finally {
      this.#pendingSpawns -= 1;
    }
  }

  #postInvoke(worker: WorkerHandle): void {
    // Promote to draining if we've crossed a recycle threshold. The worker
    // either set itself draining via markPoisoned (non-reusable result) or
    // we set it now based on age / task count.
    if (worker.state === "busy") {
      const taskCap = worker.taskCount >= this.#opts.recycleAfterTasks;
      const ageCap = worker.ageMs(this.#now()) >= this.#opts.recycleAfterMs;
      if (taskCap || ageCap) {
        log.debug(
          { workerId: worker.workerId, taskCount: worker.taskCount, taskCap, ageCap },
          "recycling worker — cap reached",
        );
        worker.markPoisoned();
      } else {
        worker.release();
      }
    }
    // Now reconcile pool state.
    if (worker.state === "draining") {
      this.#removeAndDispose(worker);
      // Replace lazily up to `min` if we dropped below.
      if (this.#workers.length + this.#pendingSpawns < this.#opts.min) {
        // Don't await — replacement happens in background; the next invoke
        // either picks up this spawn or spawns its own up to max.
        void this.#spawnOne().catch((e: unknown) => {
          log.warn(
            { err: e instanceof Error ? e.message : String(e) },
            "replacement worker spawn failed; pool below min until next invoke",
          );
        });
      }
    } else if (worker.state === "idle") {
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
  }

  #removeAndDispose(worker: WorkerHandle): void {
    const idx = this.#workers.indexOf(worker);
    if (idx >= 0) this.#workers.splice(idx, 1);
    void worker.dispose().catch((e: unknown) => {
      log.warn(
        { workerId: worker.workerId, err: e instanceof Error ? e.message : String(e) },
        "worker dispose failed during recycle",
      );
    });
    // If a queued waiter is starving and we have headroom, kick a spawn.
    if (this.#queue.length > 0 && this.#workers.length + this.#pendingSpawns < this.#opts.max) {
      void this.#spawnAndHandToQueue().catch((e: unknown) => {
        const waiter = this.#queue.shift();
        waiter?.reject(e instanceof Error ? e : new Error(String(e)));
      });
    }
  }

  async #spawnAndHandToQueue(): Promise<void> {
    const w = await this.#spawnOne();
    const waiter = this.#queue.shift();
    if (!waiter) return;
    if (w.tryAcquire()) {
      waiter.resolve(w);
    } else {
      // Lost the race to another acquirer; back into the queue.
      this.#queue.unshift(waiter);
    }
  }

  #sweepIdle(): void {
    if (this.#disposed) return;
    const now = this.#now();
    // Idle workers in excess of `min` that have sat past `idleShutdownMs`.
    const candidates = this.#workers.filter(
      (w) => w.state === "idle" && w.idleMs(now) >= this.#opts.idleShutdownMs,
    );
    // Keep at least `min` workers alive; only sweep the surplus.
    const idleCount = this.#workers.filter((w) => w.state === "idle").length;
    const surplus = Math.max(0, idleCount - this.#opts.min);
    const toSweep = candidates.slice(0, surplus);
    for (const w of toSweep) {
      log.debug({ workerId: w.workerId, idleMs: w.idleMs(now) }, "sweeping idle worker");
      w.markPoisoned();
      this.#removeAndDispose(w);
    }
  }
}
