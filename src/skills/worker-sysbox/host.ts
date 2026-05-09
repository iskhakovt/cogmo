import { logger } from "../../logger.js";
import type { ResourceLimits, SandboxClient } from "../../sandbox/index.js";
import type { CtxHandler } from "../dispatcher.js";
import { type InvokeResult, SysboxSkillWorker } from "./worker.js";

const log = logger.child({ component: "skills.worker.sysbox" });

/**
 * Default resource caps for tier-2 skills — overridden by manifest declarations.
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
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpus: 1,
  memory_bytes: 512 * 1024 * 1024,
  pids: 1024,
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
  skillName: string;
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds. Defaults to the worker's default (60s). */
  wallClockS?: number;
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
  const wallClockS = params.wallClockS;
  // expiresAt is the reaper backstop. Take the wall-clock plus margin if
  // declared; otherwise fall back to a generous default — the worker is
  // disposed immediately after the single task either way.
  const ttlS = (wallClockS ?? 60) + REAPER_BACKSTOP_S;
  const expiresAt = new Date(Date.now() + ttlS * 1000);

  let worker: SysboxSkillWorker | undefined;
  try {
    worker = await SysboxSkillWorker.create({
      workerId: params.taskId,
      sandbox: params.sandbox,
      image: params.image,
      ...(params.resourceLimits !== undefined && { resourceLimits: params.resourceLimits }),
      expiresAt,
    });
    if (!worker.tryAcquire()) {
      // Brand-new worker should always be idle; this is a programmer error.
      throw new Error("invariant: fresh worker not acquirable");
    }
    return await worker.invoke({
      taskId: params.taskId,
      skillName: params.skillName,
      body: params.body,
      inputs: params.inputs,
      ...(wallClockS !== undefined && { wallClockS }),
      ...(params.isolation !== undefined && { isolation: params.isolation }),
      ctxHandler: params.ctxHandler,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      workerReusable: false,
    };
  } finally {
    if (worker) {
      await worker.dispose().catch((e: unknown) => {
        log.warn(
          { taskId: params.taskId, err: e instanceof Error ? e.message : String(e) },
          "one-shot worker dispose failed",
        );
      });
    }
  }
}
