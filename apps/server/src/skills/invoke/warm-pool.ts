import type { SandboxClient } from "../../sandbox/index.js";
import {
  DEFAULT_POOL_OPTIONS,
  SysboxWorkerPool,
  type SysboxWorkerPoolOptions,
} from "../worker-sysbox/pool.js";

/** The pool sizing a runner may override. */
export type WarmPoolSizing = Partial<
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

/**
 * The tier-2 warm pool, created by the first tier-2 invoke rather than at
 * boot, so boot doesn't depend on the sandbox. Concurrent first callers share
 * one start; a failed start clears it, so the next invoke retries.
 */
export class LazyWarmPool {
  #image: string;
  #depsCacheVolumeName: string | undefined;
  #sizing: WarmPoolSizing | undefined;
  #pool: SysboxWorkerPool | undefined;
  #poolPromise: Promise<SysboxWorkerPool> | undefined;
  /** Set by `shutdown()`: no pool starts after it, since nothing would dispose it. */
  #disposed = false;

  constructor(opts: {
    image: string;
    depsCacheVolumeName: string | undefined;
    sizing: WarmPoolSizing | undefined;
  }) {
    this.#image = opts.image;
    this.#depsCacheVolumeName = opts.depsCacheVolumeName;
    this.#sizing = opts.sizing;
  }

  /**
   * The pool, started on `sandbox` if it isn't yet. On success the pool is
   * kept and the in-flight start cleared; on failure the start is cleared so
   * the next caller retries — a transient sandbox failure doesn't poison the
   * runner permanently.
   */
  async ensure(sandbox: SandboxClient): Promise<SysboxWorkerPool> {
    if (this.#disposed) {
      throw new Error("SkillRunnerImpl: tier-2 pool requested after shutdown");
    }
    if (this.#pool) return this.#pool;
    if (this.#poolPromise) return this.#poolPromise;
    this.#poolPromise = (async () => {
      try {
        const pool = await SysboxWorkerPool.create({
          sandbox,
          image: this.#image,
          ...DEFAULT_POOL_OPTIONS,
          ...(this.#depsCacheVolumeName !== undefined && {
            depsCacheVolumeName: this.#depsCacheVolumeName,
          }),
          ...this.#sizing,
        });
        this.#pool = pool;
        return pool;
      } finally {
        this.#poolPromise = undefined;
      }
    })();
    return this.#poolPromise;
  }

  /**
   * Dispose the pool. Waits for a start in flight and disposes what it
   * produces; afterwards {@link ensure} throws. Idempotent.
   */
  async shutdown(): Promise<void> {
    // Set `#disposed` before awaiting in-flight init so a racing
    // `ensure()` can't kick off a fresh start after this point.
    this.#disposed = true;
    if (this.#poolPromise) {
      await this.#poolPromise.catch(() => undefined);
    }
    if (this.#pool) {
      await this.#pool.dispose();
      this.#pool = undefined;
    }
  }
}
