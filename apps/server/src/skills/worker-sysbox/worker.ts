import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { logger } from "../../logger.js";
import type {
  ExecStreamingHandle,
  ResourceLimits,
  SandboxClient,
  SandboxSession,
} from "../../sandbox/index.js";
import { ensureVenvPopulated } from "../deps.js";
import { type CtxHandler, Dispatcher } from "../dispatcher.js";
import {
  type RuntimeRusage,
  SUPERVISOR_PROTOCOL_VERSION,
  type TaskInvoke,
  type TaskResult,
} from "../protocol.js";
import { DEFAULT_WALL_CLOCK_S, timeoutSignal } from "../wall-clock.js";
import type { StartFailure, TaskFailure, WorkerFrame } from "../worker-state.js";
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

/** A worker as the pool sees it: its channel's state, plus whether its container is gone. */
export type WorkerStatus = "idle" | "busy" | "dead" | "disposed";

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
  /** Aborting it stops a `create` in progress, or closes a live worker's channel. */
  signal?: AbortSignal;
}

/**
 * Buffer added on top of the per-task `wallClockS` for the host-side
 * deadline. Inside the container the task's relay enforces the wall clock;
 * the supervisor kills an unresponsive relay 2 s later (reaping it takes up
 * to 2 s) and spends up to 2 s clearing the task's processes before
 * `task_exited`. This is the safety net for a supervisor that itself hung
 * or was stopped.
 */
const SUPERVISOR_GRACE_S = 10;

/**
 * How long a freshly spawned supervisor has to announce `supervisor_ready`.
 * Python starts in well under a second.
 */
const SUPERVISOR_READY_TIMEOUT_MS = 30_000;

/** The supervisor's first frame must announce `SUPERVISOR_PROTOCOL_VERSION`. */
function acceptSupervisorReady(first: WorkerFrame): Result<void, string> {
  return match(first)
    .with({ type: "supervisor_ready", protocolVersion: SUPERVISOR_PROTOCOL_VERSION }, () =>
      ok(undefined),
    )
    .with({ type: "supervisor_ready" }, ({ protocolVersion }) =>
      err(
        `supervisor speaks protocol v${protocolVersion}; this Cogmo requires v${SUPERVISOR_PROTOCOL_VERSION} — use the skills image matching this Cogmo version`,
      ),
    )
    .with({ type: "malformed" }, ({ issues }) =>
      err(`supervisor sent a malformed frame before supervisor_ready (${issues.join("; ")})`),
    )
    .otherwise(({ type }) => err(`supervisor sent ${type} before supervisor_ready`));
}

function describeStartFailure(failure: StartFailure): string {
  return match(failure)
    .with({ kind: "refused" }, ({ reason }) => reason)
    .with(
      { kind: "timed_out" },
      () =>
        `supervisor did not announce protocol v${SUPERVISOR_PROTOCOL_VERSION} within ${SUPERVISOR_READY_TIMEOUT_MS / 1000}s; a skills image without the handshake never does`,
    )
    .with({ kind: "ended" }, ({ reason }) => `supervisor exited before announcing: ${reason}`)
    .with(
      { kind: "closed" },
      ({ reason }) => `the host closed the supervisor's channel before it announced: ${reason}`,
    )
    .exhaustive();
}

function fromTaskResult(result: TaskResult): Omit<InvokeResult, "workerReusable"> {
  return {
    ...(result.ok ? { ok: true, output: result.output } : { ok: false, error: result.error }),
    ...(result.rusage !== undefined && { rusage: result.rusage }),
  };
}

function describeTaskFailure(failure: TaskFailure): string {
  return match(failure)
    .with({ kind: "timed_out" }, () => "supervisor_unresponsive")
    .with({ kind: "failed" }, ({ reason }) => `dispatcher_error: ${reason}`)
    .with({ kind: "exited_without_result" }, () => "task_exited_without_result")
    .exhaustive();
}

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
   * (via `task_invoke.isolation`) so the task process knows; on the host side, a
   * `recycle` task retires the worker once it completes, whatever its
   * outcome, and the pool replaces it.
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
   * Per-task rusage from the task process. Populated for every
   * normally-completing run (`runner.py` snapshots `getrusage(RUSAGE_SELF)`
   * just before emitting `task_result`). Absent for synthesised results
   * — wall-clock kill, task process died, supervisor-hung watchdog,
   * transport errors — since none of those paths see the task's rusage.
   */
  rusage?: RuntimeRusage;
  /**
   * True when the worker is safe to reuse for another task: the supervisor
   * confirmed the task's processes exited and the skill did not declare
   * `isolation: recycle`. When false the worker is already dead, and the
   * pool replaces it.
   */
  workerReusable: boolean;
}

/**
 * One sysbox container with a long-lived python supervisor process,
 * reused across many skill tasks. Owns the underlying `SandboxSession`,
 * an `ExecStreamingHandle` running the supervisor, and the `Dispatcher`
 * that drives the supervisor's channel. The supervisor stays alive across
 * tasks so common imports are paid only once; each task runs in fresh
 * processes forked from it, behind a per-task relay (see `supervisor.py`).
 * `invoke()` returns only once the supervisor's `task_exited` confirms
 * every process the task started is gone, or the worker has died.
 * `create()` refuses a supervisor that does not announce
 * `SUPERVISOR_PROTOCOL_VERSION`.
 *
 * `state` is the channel's state (`worker-state.ts`) as the pool sees it:
 * `idle`; `busy` while leased or running a task; `dead`; `disposed` once
 * its container is torn down. `dead` resolves the moment it can run no
 * further task, whatever the cause; `disposable` once, dead, no caller
 * holds it any more.
 */
export class SysboxSkillWorker {
  readonly workerId: string;
  /** Resolves with the reason once the worker can run no further task. */
  readonly dead: Promise<string>;
  /** Resolves once the worker is dead and no caller holds it: its container can go. */
  readonly disposable: Promise<void>;
  #sandbox: SandboxClient;
  #session: SandboxSession;
  #exec: ExecStreamingHandle;
  #dispatcher: Dispatcher;
  #disposal: Promise<void> | undefined;
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
    this.dead = opts.dispatcher.dead;
    this.disposable = opts.dispatcher.disposable;
    const now = Date.now();
    this.#lastUsedAtMs = now;
    this.#createdAtMs = now;
  }

  /**
   * Create the container, start its supervisor and wait for its handshake.
   * An aborted `signal` stops creation at its next step, tearing down
   * whatever it had set up.
   */
  static async create(opts: SysboxSkillWorkerOptions): Promise<SysboxSkillWorker> {
    const resourceLimits: ResourceLimits = {
      cpus: opts.resourceLimits?.cpus ?? DEFAULT_RESOURCE_LIMITS.cpus,
      memory_bytes: opts.resourceLimits?.memory_bytes ?? DEFAULT_RESOURCE_LIMITS.memory_bytes,
      pids: opts.resourceLimits?.pids ?? DEFAULT_RESOURCE_LIMITS.pids,
      disk_bytes: opts.resourceLimits?.disk_bytes ?? DEFAULT_RESOURCE_LIMITS.disk_bytes,
    };

    opts.signal?.throwIfAborted();
    // Pass limits so a first warm against a custom image bakes them in.
    await opts.sandbox.ensureImagePresent(opts.image, resourceLimits);
    opts.signal?.throwIfAborted();

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
      opts.signal?.throwIfAborted();
      exec = await session.execStreaming([...SUPERVISOR_CMD], {
        attachStdin: true,
      });
    } catch (e) {
      // The container exists but its supervisor never started — tear the
      // session down so the container doesn't leak.
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
    // A failing exec fails stderr along with stdout. Stdout's failure ends
    // the channel and settles any task; stderr's must not go unhandled, or
    // it crashes the process.
    exec.stderr.on("error", (e: Error) => {
      log.warn({ workerId: opts.workerId, err: e.message }, "supervisor stderr failed");
    });

    const opened = await Dispatcher.open({
      transport: createNdjsonTransport(exec.stdin, exec.stdout),
      handshake: acceptSupervisorReady,
      handshakeDeadline: timeoutSignal(SUPERVISOR_READY_TIMEOUT_MS),
      // From here the signal closes the channel, during the handshake too.
      ...(opts.signal !== undefined && { signal: opts.signal }),
      logContext: { workerId: opts.workerId },
    });
    if (opened.isErr()) {
      await exec.dispose().catch((e: unknown) => {
        log.warn(
          { workerId: opts.workerId, err: e instanceof Error ? e.message : String(e) },
          "exec.dispose failed while cleaning up after a refused supervisor",
        );
      });
      await opts.sandbox.delete(session).catch((e: unknown) => {
        log.warn(
          { workerId: opts.workerId, err: e instanceof Error ? e.message : String(e) },
          "session.delete failed while cleaning up after a refused supervisor",
        );
      });
      throw new Error(
        `skills worker ${opts.workerId} (${opts.image}): ${describeStartFailure(opened.error)}`,
      );
    }

    log.debug({ workerId: opts.workerId, image: opts.image }, "skills worker spawned");
    return new SysboxSkillWorker({
      workerId: opts.workerId,
      sandbox: opts.sandbox,
      session,
      exec,
      dispatcher: opened.value,
    });
  }

  get state(): WorkerStatus {
    if (this.#disposal !== undefined) return "disposed";
    return match(this.#dispatcher.state)
      .returnType<WorkerStatus>()
      .with("idle", () => "idle")
      .with(P.union("starting", "leased", "running", "awaiting_exit"), () => "busy")
      .with("dead", () => "dead")
      .exhaustive();
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
   * Run one task on this worker's supervisor. The caller must hold the
   * worker's lease (`tryAcquire`): a task needs the channel to itself. A
   * worker can die after its lease is taken; its task then fails as a
   * value, with nothing populated or sent.
   */
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    const admission = this.#dispatcher.admission();
    if (admission.isErr()) {
      throw new Error(`SysboxSkillWorker.invoke: ${admission.error}`);
    }
    const wallClockS = params.wallClockS ?? DEFAULT_WALL_CLOCK_S.container;

    // Ensure the skill's venv is populated before sending the task. The
    // populator is idempotent — second-and-later calls with the same
    // lockfile hash on the same worker no-op via the `.ready` marker.
    // Failure retires the worker because uv pip sync writes into the
    // container's overlay FS; a partial populate could leave the venv
    // in an unreusable state for any future task with the same hash.
    // A worker that dies during the populate is the dispatcher's to judge:
    // it admits the task again when it is sent, and fails it as a value.
    let lockfileHash: string | undefined;
    if (params.deps && admission.value.kind === "runs") {
      const populate = await ensureVenvPopulated({
        session: this.#session,
        lockfileHash: params.deps.lockfileHash,
        lockfileContents: params.deps.lockfileContents,
        workerId: this.workerId,
      });
      if (populate.isErr()) {
        this.#taskCount += 1;
        this.#lastUsedAtMs = Date.now();
        this.retire();
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

    const { result, exit } = await this.#dispatcher.invoke(invoke, {
      ctxHandler: params.ctxHandler,
      // The relay's wall clock fires first under normal conditions and
      // reports `wall_clock_exceeded` as the task's result; this deadline
      // passes only if the supervisor itself hung.
      deadline: timeoutSignal((wallClockS + SUPERVISOR_GRACE_S) * 1000),
    });
    this.#taskCount += 1;
    this.#lastUsedAtMs = Date.now();
    // `isolation: recycle` — the manifest declared the task can't share
    // state with another task on the same supervisor.
    const recycle = params.isolation === "recycle";
    if (recycle) this.retire();

    const workerReusable = exit.kind === "confirmed" && !recycle;
    return result.match(
      (delivered) => ({ ...fromTaskResult(delivered), workerReusable }),
      (failure) => ({ ok: false, error: describeTaskFailure(failure), workerReusable }),
    );
  }

  /** Lease an idle worker for one task; errs with why any other can't be. */
  tryAcquire(): Result<void, string> {
    return this.#dispatcher.tryAcquire();
  }

  /**
   * Return a leased worker to idle once its task has exited; a dead one this
   * caller held becomes disposable. Errs with why if the caller holds nothing.
   */
  release(): Result<void, string> {
    return this.#dispatcher.release();
  }

  /**
   * Retire the worker: it takes no further task. Closes the supervisor's
   * channel (EOF on its stdin, so it exits cleanly); the container stays
   * until `dispose()`. Idempotent.
   */
  retire(): void {
    this.#dispatcher.close("retired");
  }

  /**
   * Tear down the worker. Closes the supervisor's channel, waits briefly for
   * the supervisor process to exit, and deletes the sandbox session.
   * Idempotent.
   */
  dispose(): Promise<void> {
    this.#disposal ??= this.#teardown();
    return this.#disposal;
  }

  async #teardown(): Promise<void> {
    this.#dispatcher.close("disposed");
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
