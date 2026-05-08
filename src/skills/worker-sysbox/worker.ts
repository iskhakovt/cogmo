import { logger } from "../../logger.js";
import type { ResourceLimits, SandboxClient, SandboxSession } from "../../sandbox/index.js";
import type { CtxHandler } from "../dispatcher.js";
import {
  DEFAULT_RESOURCE_LIMITS,
  type RunTaskOnSessionParams,
  type RunTaskOnSessionResult,
  runTaskOnSession,
} from "./host.js";

const log = logger.child({ component: "skills.worker.sysbox" });

export type WorkerState = "idle" | "busy" | "draining" | "disposed";

export interface SysboxSkillWorkerOptions {
  /** Stable identifier — also doubles as the sandbox `taskId` for label/lineage. */
  workerId: string;
  sandbox: SandboxClient;
  image: string;
  /** Optional per-skill overrides; merged on top of `DEFAULT_RESOURCE_LIMITS`. */
  resourceLimits?: Partial<ResourceLimits>;
  /**
   * `expiresAt` passed to the sandbox at session creation. The reaper uses
   * this as a backstop — we never want a crashed Cogmo to leave a worker
   * container alive forever. Should be ≥ recycle ceiling so the reaper
   * doesn't fight the pool's own recycle policy. The pool computes this
   * (recycle ceiling + small buffer); workers don't need to know the policy.
   */
  expiresAt: Date;
}

/**
 * One sysbox container reused across many skill tasks. Owns the underlying
 * `SandboxSession`; per-task isolation is achieved by spawning a fresh
 * `python3 -u -c <RUNNER>` exec on the same session for each invocation —
 * recycle policy at the pool level bounds drift in the shared container.
 *
 * State machine:
 *
 * ```
 *   spawn                 acquire        invoke()         release
 *  ─────► idle ──────────► busy ─────────────────► idle
 *           │                  │
 *           │   non-reusable   │
 *           │   result, or     │
 *           │   markPoisoned   │
 *           ▼                  ▼
 *         draining ───── dispose() ─────► disposed
 * ```
 *
 * Once `draining`, the worker accepts no further invocations; the pool will
 * call `dispose()` to tear down the session. `markPoisoned()` is the explicit
 * one-way trip to draining used after wall-clock kills or transport errors —
 * the underlying container may have orphan subprocesses or corrupted shared
 * state, so we don't trust it for the next task.
 */
export class SysboxSkillWorker {
  readonly workerId: string;
  #sandbox: SandboxClient;
  #session: SandboxSession;
  #state: WorkerState = "idle";
  #taskCount = 0;
  #lastUsedAtMs: number;
  #createdAtMs: number;

  private constructor(opts: { workerId: string; sandbox: SandboxClient; session: SandboxSession }) {
    this.workerId = opts.workerId;
    this.#sandbox = opts.sandbox;
    this.#session = opts.session;
    const now = Date.now();
    this.#lastUsedAtMs = now;
    this.#createdAtMs = now;
  }

  static async create(opts: SysboxSkillWorkerOptions): Promise<SysboxSkillWorker> {
    await opts.sandbox.ensureImagePresent(opts.image);

    const resourceLimits: ResourceLimits = {
      cpus: opts.resourceLimits?.cpus ?? DEFAULT_RESOURCE_LIMITS.cpus,
      memory_bytes: opts.resourceLimits?.memory_bytes ?? DEFAULT_RESOURCE_LIMITS.memory_bytes,
      pids: opts.resourceLimits?.pids ?? DEFAULT_RESOURCE_LIMITS.pids,
    };

    const session = await opts.sandbox.create({
      taskId: opts.workerId,
      image: opts.image,
      resourceLimits,
      expiresAt: opts.expiresAt,
    });

    log.debug({ workerId: opts.workerId, image: opts.image }, "skills worker spawned");
    return new SysboxSkillWorker({
      workerId: opts.workerId,
      sandbox: opts.sandbox,
      session,
    });
  }

  get state(): WorkerState {
    return this.#state;
  }

  get taskCount(): number {
    return this.#taskCount;
  }

  /** Wall-clock ms since this worker last finished (or started, if no tasks). */
  idleMs(now: number): number {
    return Math.max(0, now - this.#lastUsedAtMs);
  }

  /** Wall-clock ms since this worker was created. */
  ageMs(now: number): number {
    return Math.max(0, now - this.#createdAtMs);
  }

  /**
   * Run one task on this worker's session. Caller must hold a busy lease
   * (acquired via the pool's bookkeeping) — concurrent invocations on the
   * same worker would step on each other's `python3 -u -c` execs sharing
   * one stdin. The pool enforces single-flight via state transitions; this
   * method asserts the precondition.
   */
  async invoke(
    params: RunTaskOnSessionParams & { ctxHandler: CtxHandler },
  ): Promise<RunTaskOnSessionResult> {
    if (this.#state !== "busy") {
      throw new Error(
        `SysboxSkillWorker.invoke called in state '${this.#state}' — pool must mark busy first`,
      );
    }
    let result: RunTaskOnSessionResult;
    try {
      result = await runTaskOnSession(this.#session, params);
    } catch (e) {
      // runTaskOnSession itself catches exec errors and surfaces them as
      // ok=false, but defensive: any escape (transport.close throwing,
      // dispatcher constructor throwing) lands here. Treat as poison.
      const message = e instanceof Error ? e.message : String(e);
      this.#taskCount += 1;
      this.#lastUsedAtMs = Date.now();
      this.markPoisoned();
      return { ok: false, error: `worker_exception: ${message}`, workerReusable: false };
    }
    this.#taskCount += 1;
    this.#lastUsedAtMs = Date.now();
    if (!result.workerReusable) {
      this.markPoisoned();
    }
    return result;
  }

  /**
   * Pool-side state transition: idle → busy. Returns false if the worker
   * isn't acquirable (already busy, draining, or disposed).
   */
  tryAcquire(): boolean {
    if (this.#state !== "idle") return false;
    this.#state = "busy";
    return true;
  }

  /** Pool-side state transition: busy → idle (worker still healthy). */
  release(): void {
    if (this.#state === "busy") {
      this.#state = "idle";
    }
  }

  /**
   * One-way trip to `draining`. Idempotent. Used after a non-reusable
   * result, an explicit recycle decision (taskCount cap), or idle-shutdown.
   * The container is not torn down until `dispose()`; until then the
   * worker simply refuses new acquisitions.
   */
  markPoisoned(): void {
    if (this.#state === "disposed") return;
    this.#state = "draining";
  }

  /** Tear down the underlying session. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    await this.#sandbox.delete(this.#session).catch((e: unknown) => {
      log.warn(
        { workerId: this.workerId, err: e instanceof Error ? e.message : String(e) },
        "worker dispose: sandbox.delete failed",
      );
    });
  }
}
