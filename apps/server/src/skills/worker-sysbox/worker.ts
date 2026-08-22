import { logger } from "../../logger.js";
import type {
  ExecStreamingHandle,
  ResourceLimits,
  SandboxClient,
  SandboxSession,
} from "../../sandbox/index.js";
import { ensureVenvPopulated } from "../deps.js";
import { type CtxHandler, Dispatcher } from "../dispatcher.js";
import type { RuntimeRusage, TaskInvoke, TaskResult } from "../protocol.js";
import { DEFAULT_WALL_CLOCK_S } from "../wall-clock.js";
import { DEFAULT_RESOURCE_LIMITS } from "./host.js";
import { createNdjsonTransport } from "./transport.js";

/**
 * Entry point for the python supervisor. Resolves to the
 * `cogmo_skills_runtime` package's `__main__.py` (which calls
 * `supervisor.main()`). Installed into the cogmo-skills image's venv at
 * build time — the source lives in `images/skills/src/cogmo_skills_runtime/`,
 * not in this TS bundle. See `images/skills/Dockerfile`.
 */
const SUPERVISOR_CMD = ["python3", "-u", "-m", "cogmo_skills_runtime"] as const;

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
  /**
   * Named Docker volume mounted at `/skill-venvs`. Threaded to the
   * sandbox `SessionSpec.depsCacheVolume`. The pool passes the same
   * value to every worker so a venv populated by one worker is reused
   * by every other worker and survives recycle. Omit to run with a
   * container-local cache (overlay FS, lost on recycle).
   */
  depsCacheVolumeName?: string;
}

/**
 * Buffer added on top of the per-task `wallClockS` for the host-side
 * dispatcher timeout. The supervisor inside the container kills the child
 * process and emits `wall_clock_exceeded` first; this is the safety net for
 * a supervisor that itself hung (kernel pidfd weirdness, sigkill blocked by
 * a stuck syscall, etc.).
 */
const SUPERVISOR_GRACE_S = 5;

export interface InvokeParams {
  taskId: string;
  /** Skill name — informational only; surfaced in logs and labels. */
  skillName: string;
  /** Source of `skill.py`. */
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds. Defaults to 60 s. */
  wallClockS?: number;
  /**
   * Manifest's isolation declaration. Threaded through to the supervisor
   * (via `task_invoke.isolation`) so the child knows; on the host side, a
   * `recycle` task poisons the worker after completion regardless of the
   * task's success — pool replaces it on next acquire.
   */
  isolation?: "subinterpreter" | "recycle";
  /**
   * Per-skill dependency artefacts. Both fields must be set together —
   * the worker calls `ensureVenvPopulated` before invoking and threads
   * the lockfile hash into `task_invoke.lockfileHash` so the
   * supervisor can construct the ABI-qualified venv path on its side.
   * Absent (or `null` lockfile hash) means the skill declared no
   * dependencies and runs against stdlib only.
   */
  deps?: {
    /** sha256 of `requirements.lock` at the skill's `git_sha`. */
    lockfileHash: string;
    /** Raw lockfile contents — fed to `uv pip sync` via stdin. */
    lockfileContents: string;
  };
  ctxHandler: CtxHandler;
}

export interface InvokeResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /**
   * Per-task rusage from the supervisor's child. Populated for every
   * normally-completing run (`runner.py` snapshots `getrusage(RUSAGE_SELF)`
   * just before emitting `task_result`). Absent for synthesised results
   * — wall-clock kill, supervisor-hung watchdog, dispatcher transport
   * errors — since none of those paths see the child's rusage.
   */
  rusage?: RuntimeRusage;
  /**
   * True when the worker is safe to reuse for another task. False on
   * wall-clock kill, transport error, or `isolation: recycle` declaration —
   * the pool calls `markPoisoned` (already done by the worker for the
   * non-reusable cases) and replaces.
   */
  workerReusable: boolean;
}

/**
 * One sysbox container with a long-lived python supervisor process,
 * reused across many skill tasks. Owns the underlying `SandboxSession`,
 * an `ExecStreamingHandle` running the supervisor, and a single
 * `Dispatcher` that multiplexes sequential tasks over the supervisor's
 * stdin/stdout. Per-task isolation comes from the supervisor forking a
 * fresh child process per `task_invoke` (~10-30 ms COW fork from the
 * pre-imported parent); the supervisor itself stays alive across tasks
 * so common imports are paid only once.
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
 * Once `draining`, the worker accepts no further invocations; the pool
 * will call `dispose()` to close the transport (EOFs the supervisor's
 * stdin → supervisor exits cleanly) and tear down the session.
 */
export class SysboxSkillWorker {
  readonly workerId: string;
  #sandbox: SandboxClient;
  #session: SandboxSession;
  #exec: ExecStreamingHandle;
  #dispatcher: Dispatcher;
  #state: WorkerState = "idle";
  #taskCount = 0;
  #lastUsedAtMs: number;
  #createdAtMs: number;

  private constructor(opts: {
    workerId: string;
    sandbox: SandboxClient;
    session: SandboxSession;
    exec: ExecStreamingHandle;
    dispatcher: Dispatcher;
  }) {
    this.workerId = opts.workerId;
    this.#sandbox = opts.sandbox;
    this.#session = opts.session;
    this.#exec = opts.exec;
    this.#dispatcher = opts.dispatcher;
    const now = Date.now();
    this.#lastUsedAtMs = now;
    this.#createdAtMs = now;
  }

  static async create(opts: SysboxSkillWorkerOptions): Promise<SysboxSkillWorker> {
    const resourceLimits: ResourceLimits = {
      cpus: opts.resourceLimits?.cpus ?? DEFAULT_RESOURCE_LIMITS.cpus,
      memory_bytes: opts.resourceLimits?.memory_bytes ?? DEFAULT_RESOURCE_LIMITS.memory_bytes,
      pids: opts.resourceLimits?.pids ?? DEFAULT_RESOURCE_LIMITS.pids,
      disk_bytes: opts.resourceLimits?.disk_bytes ?? DEFAULT_RESOURCE_LIMITS.disk_bytes,
    };

    // Pass limits so a first warm against a custom image bakes them in.
    await opts.sandbox.ensureImagePresent(opts.image, resourceLimits);

    const session = await opts.sandbox.create({
      taskId: opts.workerId,
      image: opts.image,
      resourceLimits,
      expiresAt: opts.expiresAt,
      ...(opts.depsCacheVolumeName !== undefined && {
        depsCacheVolume: { volumeName: opts.depsCacheVolumeName },
      }),
    });

    let exec: ExecStreamingHandle;
    try {
      exec = await session.execStreaming([...SUPERVISOR_CMD], {
        attachStdin: true,
      });
    } catch (e) {
      // Container created but supervisor couldn't launch — tear the session
      // down so the container doesn't leak.
      await opts.sandbox.delete(session).catch((err: unknown) => {
        log.warn(
          { workerId: opts.workerId, err: err instanceof Error ? err.message : String(err) },
          "session.delete failed while cleaning up after failed exec",
        );
      });
      throw e;
    }
    if (!exec.stdin) {
      // attachStdin: true — unreachable at runtime, satisfies the type narrow.
      await opts.sandbox.delete(session).catch(() => {});
      throw new Error("exec returned without stdin despite attachStdin=true");
    }

    // Drain stderr to the host log — supervisor prints, traceback, etc.
    exec.stderr.setEncoding("utf-8");
    exec.stderr.on("data", (chunk: string) => {
      log.debug({ workerId: opts.workerId }, chunk.trimEnd());
    });

    const transport = createNdjsonTransport(exec.stdin, exec.stdout);
    // No constructor default ctxHandler — every `invoke()` passes a
    // per-task handler. If a missed pass-through ever triggers a ctx_call
    // arriving with no handler, the dispatcher rejects the pending task
    // with a clear error (see Dispatcher#handleCtxCall).
    const dispatcher = new Dispatcher({ transport });

    log.debug({ workerId: opts.workerId, image: opts.image }, "skills worker spawned");
    return new SysboxSkillWorker({
      workerId: opts.workerId,
      sandbox: opts.sandbox,
      session,
      exec,
      dispatcher,
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
   * Run one task on this worker's supervisor. Caller must hold a busy lease
   * (acquired via the pool's bookkeeping) — concurrent invocations would
   * step on each other's NDJSON frames sharing one stdin/stdout. The pool
   * enforces single-flight via state transitions; this method asserts the
   * precondition.
   */
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    if (this.#state !== "busy") {
      throw new Error(
        `SysboxSkillWorker.invoke called in state '${this.#state}' — pool must mark busy first`,
      );
    }
    const wallClockS = params.wallClockS ?? DEFAULT_WALL_CLOCK_S.container;

    // Ensure the skill's venv is populated before sending the task. The
    // populator is idempotent — second-and-later calls with the same
    // lockfile hash on the same worker no-op via the `.ready` marker.
    // Failure poisons the worker because uv pip sync writes into the
    // container's overlay FS; a partial populate could leave the venv
    // in an unreusable state for any future task with the same hash.
    let lockfileHash: string | undefined;
    if (params.deps) {
      const populate = await ensureVenvPopulated({
        session: this.#session,
        lockfileHash: params.deps.lockfileHash,
        lockfileContents: params.deps.lockfileContents,
        workerId: this.workerId,
      });
      if (populate.isErr()) {
        this.#taskCount += 1;
        this.#lastUsedAtMs = Date.now();
        this.markPoisoned();
        return {
          ok: false,
          error: `skill_venv_${populate.error.kind}: ${populate.error.message}`,
          workerReusable: false,
        };
      }
      lockfileHash = params.deps.lockfileHash;
    }

    const invoke: TaskInvoke = {
      type: "task_invoke",
      id: params.taskId,
      skill: params.skillName,
      inputs: params.inputs,
      body: params.body,
      ...(params.isolation !== undefined && { isolation: params.isolation }),
      ...(lockfileHash !== undefined && { lockfileHash }),
      wallClockS,
    };

    // `dispatcher.invoke` returns `Promise<TaskResult>` — that's what the
    // protocol guarantees and what the dispatcher's `#handleTaskResult`
    // resolves with. Tracking the type through the race keeps `winner.r`
    // typed as `TaskResult` so the discriminated union narrows on `.ok`
    // without a cast.
    let taskPromise: Promise<TaskResult>;
    try {
      taskPromise = this.#dispatcher.invoke(invoke, { ctxHandler: params.ctxHandler });
    } catch (e) {
      // Synchronous failure (dispatcher closed, transport write threw).
      this.#taskCount += 1;
      this.#lastUsedAtMs = Date.now();
      this.markPoisoned();
      return {
        ok: false,
        error: `worker_dispatch_failed: ${e instanceof Error ? e.message : String(e)}`,
        workerReusable: false,
      };
    }

    // Host-side safety-net timeout. The supervisor's own per-task timer
    // fires first under normal conditions and emits `wall_clock_exceeded`
    // via task_result; this hits only if the supervisor itself hung.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve("timeout"),
        (wallClockS + SUPERVISOR_GRACE_S) * 1000,
      );
    });
    const wrappedTask = taskPromise.then(
      (r) => ({ kind: "ok" as const, r }),
      (err: unknown) => ({ kind: "err" as const, err }),
    );
    const winner = await Promise.race([wrappedTask, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    this.#taskCount += 1;
    this.#lastUsedAtMs = Date.now();

    if (winner === "timeout") {
      log.warn(
        { workerId: this.workerId, taskId: params.taskId, wallClockS },
        "host-side supervisor watchdog fired — supervisor hung; recycling worker",
      );
      this.markPoisoned();
      return { ok: false, error: "supervisor_unresponsive", workerReusable: false };
    }

    if (winner.kind === "err") {
      const message = winner.err instanceof Error ? winner.err.message : String(winner.err);
      this.markPoisoned();
      return { ok: false, error: `dispatcher_error: ${message}`, workerReusable: false };
    }

    const taskResult = winner.r;
    // `isolation: recycle` poisons the worker after the task regardless of
    // success — the manifest declared it can't share state with another
    // task on the same supervisor.
    if (params.isolation === "recycle") {
      this.markPoisoned();
    }
    return {
      ...(taskResult.ok
        ? { ok: true as const, output: taskResult.output }
        : { ok: false as const, error: taskResult.error }),
      ...(taskResult.rusage !== undefined && { rusage: taskResult.rusage }),
      workerReusable: this.#state === "busy",
    };
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
   * result, an explicit recycle decision (taskCount cap, isolation:recycle),
   * or idle-shutdown. The container is not torn down until `dispose()`;
   * until then the worker simply refuses new acquisitions.
   */
  markPoisoned(): void {
    if (this.#state === "disposed") return;
    this.#state = "draining";
  }

  /**
   * Tear down the worker. Closes the dispatcher (which EOFs the
   * supervisor's stdin → supervisor exits its main loop cleanly), waits
   * briefly for the supervisor process to exit, and deletes the sandbox
   * session. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    try {
      this.#dispatcher.close();
    } catch (e) {
      log.warn(
        { workerId: this.workerId, err: e instanceof Error ? e.message : String(e) },
        "dispatcher close threw during dispose",
      );
    }
    // Wait for the supervisor to actually exit so we know the python
    // process is gone before we delete the session — otherwise the
    // delete races teardown of an in-flight syscall. Bounded by the
    // exec's own dispose timeout (the sandbox layer enforces ~5s).
    try {
      await this.#exec.dispose();
    } catch (e) {
      log.debug(
        { workerId: this.workerId, err: e instanceof Error ? e.message : String(e) },
        "exec dispose error during worker disposal",
      );
    }
    await this.#sandbox.delete(this.#session).catch((e: unknown) => {
      log.warn(
        { workerId: this.workerId, err: e instanceof Error ? e.message : String(e) },
        "worker dispose: sandbox.delete failed",
      );
    });
  }
}
