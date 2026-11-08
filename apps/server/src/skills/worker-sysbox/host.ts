import { logger } from "../../logger.js";
import type { ResourceLimits, SandboxClient } from "../../sandbox/index.js";
import { describeError } from "../../util/describe-error.js";
import type { CtxHandler } from "../dispatcher.js";
import type { DispatchGate, TaskRun } from "../protocol.js";
import { type InvokeResult, SysboxSkillWorker } from "./worker.js";

const log = logger.child({ component: "skills.worker.sysbox" });

/**
 * Default resource caps for container skills — overridden by manifest declarations.
 *
 * `pids: 1024` is generous enough for ordinary Python workloads (stdlib
 * threading + a couple of `concurrent.futures` pools + a `requests` /
 * `urllib3` connection pool clear ~50-100 threads alone; an
 * import-heavy data skill can sit at 200+ before doing real work). Tight
 * caps (we initially picked 256) risk surprising `Resource temporarily
 * unavailable` failures inside otherwise harmless skills. The real ceiling
 * is the per-task systemd slice; this is a per-container fence to catch
 * fork bombs, not a budget.
 */
// `Required<ResourceLimits>` — disk_bytes is optional on the schema but the
// skills default always sets it, so consumers can read it without a narrowing
// branch.
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  cpus: 1,
  memory_bytes: 512 * 1024 * 1024,
  pids: 1024,
  // Daytona-only — skills run a 178 MB image plus <100 MB of scratch in
  // typical workloads. 1 GiB is the platform minimum and a 3× over-
  // provision over real usage; the default 3 GiB would waste free-tier
  // storage across many simultaneous workers. Ignored by local-docker.
  disk_bytes: 1024 * 1024 * 1024,
};

/**
 * Buffer added to the per-task wall-clock cap when computing the sandbox
 * `expiresAt` reaper backstop for one-shot workers. The supervisor's
 * timer kills the child first; this gives the reaper a 30 s margin to
 * never beat us during normal operation. If the host crashes between
 * create and dispose, the reaper still collects the orphan within
 * `wallClockS + REAPER_BACKSTOP_S`.
 */
const REAPER_BACKSTOP_S = 30;

export interface RunOnSysboxContainerParams {
  taskId: string;
  run: TaskRun;
  skillName: string;
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds (`wallClockSOf`), the one `deadline_at` counts from. */
  wallClockS: number;
  resourceLimits?: Partial<ResourceLimits>;
  image: string;
  sandbox: SandboxClient;
  ctxHandler: CtxHandler;
  /**
   * Manifest's `isolation` declaration. Threaded to the supervisor for
   * symmetry with the pooled path; on a one-shot worker the supervisor
   * exits after the single task either way, so this field is a no-op
   * in practice.
   */
  isolation?: "subinterpreter" | "recycle";
  /**
   * Per-skill dependency artefacts. Same shape as the pooled path's
   * `InvokeParams.deps` — the worker calls `ensureVenvPopulated` before
   * invoking and threads the resulting venv path into the supervisor.
   * Absent for skills with no declared dependencies.
   */
  deps?: {
    lockfileHash: string;
    lockfileContents: string;
  };
  /**
   * Shared deps-cache volume name. When set, the one-shot container
   * mounts the same Docker volume that pool workers use, so a venv
   * populated on the pool is reused by this one-shot invocation
   * (and vice versa). Omitted = container-local populate, lost on
   * teardown.
   */
  depsCacheVolumeName?: string;
  /** Asked immediately before `task_invoke` is sent (`SysboxSkillWorker.invoke`). */
  dispatch: DispatchGate;
}

/**
 * Spawn a one-shot sysbox worker (with custom resource limits, typically),
 * run a single skill task to completion, and tear it down. Used by skills
 * that declare `resources.{cpu_shares,memory_mb}` overrides in their
 * manifest — the warm pool runs every worker at the default budget, so
 * resource-overriding skills bypass the pool and pay the full ~1-2s
 * container start cost per invocation. Most skills don't override and
 * ride the warm path through `SysboxWorkerPool` instead.
 *
 * Internally builds a `SysboxSkillWorker` (which spawns the supervisor),
 * invokes the task, and disposes — the supervisor handles fork-and-wait
 * + wall-clock kill the same way as the pooled path. Only difference is
 * the worker's lifetime: one task instead of N.
 */
export async function runOnSysboxContainer(
  params: RunOnSysboxContainerParams,
): Promise<InvokeResult> {
  const { wallClockS } = params;
  // expiresAt is the reaper backstop: the wall clock plus a margin. The
  // worker is disposed immediately after the single task either way.
  const ttlS = wallClockS + REAPER_BACKSTOP_S;
  const expiresAt = new Date(Date.now() + ttlS * 1000);

  let worker: SysboxSkillWorker;
  try {
    worker = await SysboxSkillWorker.create({
      workerId: params.taskId,
      sandbox: params.sandbox,
      image: params.image,
      ...(params.resourceLimits !== undefined && { resourceLimits: params.resourceLimits }),
      expiresAt,
      ...(params.depsCacheVolumeName !== undefined && {
        depsCacheVolumeName: params.depsCacheVolumeName,
      }),
    });
  } catch (e) {
    // The worker could not be created, so nothing was sent. `invoke` fails
    // a task as a value; anything it throws (its dispatch gate's database
    // failure, or a bug) propagates.
    return {
      ok: false,
      errorKind: "runtime_unavailable",
      error: describeError(e),
      workerReusable: false,
    };
  }
  try {
    // A fresh worker refuses its lease only when it died since its handshake.
    const leased = worker.tryAcquire();
    if (leased.isErr()) {
      return {
        ok: false,
        errorKind: "runtime_unavailable",
        error: `the one-shot worker died before its task: ${leased.error}`,
        workerReusable: false,
      };
    }
    return await worker.invoke({
      taskId: params.taskId,
      run: params.run,
      skillName: params.skillName,
      body: params.body,
      inputs: params.inputs,
      wallClockS,
      ...(params.isolation !== undefined && { isolation: params.isolation }),
      ...(params.deps !== undefined && { deps: params.deps }),
      ctxHandler: params.ctxHandler,
      dispatch: params.dispatch,
    });
  } finally {
    await worker.dispose().catch((e: unknown) => {
      log.warn(
        { taskId: params.taskId, err: e instanceof Error ? e.message : String(e) },
        "one-shot worker dispose failed",
      );
    });
  }
}
