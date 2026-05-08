import { logger } from "../../logger.js";
import type { ResourceLimits, SandboxClient, SandboxSession } from "../../sandbox/index.js";
import { type CtxHandler, Dispatcher } from "../dispatcher.js";
import type { TaskInvoke, TaskResult } from "../protocol.js";
import { RUNNER_PY } from "./runner.py.js";
import { createNdjsonTransport } from "./transport.js";

const log = logger.child({ component: "skills.worker.sysbox" });

/** Default wall-clock cap for tier-2 skills (`design/skills.md` Resource budgets). */
const DEFAULT_WALL_CLOCK_S = 60;

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
 * Hard bound on the combined runner + skill body source. `python3 -u -c <SRC>`
 * is one cmdline argument; Linux `ARG_MAX` is typically 128 KB-2 MB on modern
 * kernels but the safe portable ceiling is much smaller. Reject early with
 * a clear error rather than letting `docker exec` fail opaquely.
 */
const MAX_RUNNER_SOURCE_BYTES = 100_000;

/**
 * Build the full python source (runner + inlined skill body), or return a
 * size-cap error string. Hoisted so the one-shot path can pre-flight before
 * creating a container — the pool path runs the same check inside
 * `runTaskOnSession` because the cost of creating a fresh `python -c` exec on
 * an existing session is negligible compared to a container create.
 */
function buildRunnerSource(
  body: string,
): { ok: true; source: string } | { ok: false; error: string } {
  // Skill body is inlined as a Python literal at the head of the runner. JSON
  // string literals are a compatible subset of Python double-quoted string
  // literals (same backslash escapes, same \uXXXX), so JSON.stringify yields
  // a valid Python expression. Safe specifically because JSON.stringify never
  // emits the `\/` escape (legal in JSON, illegal in Python) — if the encoder
  // ever changes (or someone hand-rolls an alternative), this assumption
  // breaks silently. Long-term, if real skills push into the ARG_MAX wall,
  // we extend `task_invoke` with a `body` field and stream it — the runner
  // already routes on message type.
  const source = `__skill_body__ = ${JSON.stringify(body)}\n${RUNNER_PY}`;
  if (Buffer.byteLength(source, "utf-8") > MAX_RUNNER_SOURCE_BYTES) {
    return {
      ok: false,
      error: `runner source exceeds ${MAX_RUNNER_SOURCE_BYTES} bytes (skill body too large for tier-2 inline transport)`,
    };
  }
  return { ok: true, source };
}

/**
 * Buffer added to the per-task wall-clock cap when computing the sandbox
 * `expiresAt` reaper backstop. The host-side timer kills first; this gives
 * the reaper a 30 s margin to never beat us during normal operation. If the
 * host crashes between create and deleteByTaskId, the reaper still collects
 * the orphan within `wallClockS + REAPER_BACKSTOP_S`.
 */
const REAPER_BACKSTOP_S = 30;

export interface RunTaskOnSessionParams {
  taskId: string;
  /** Skill name — informational only; surfaced in logs and labels. */
  skillName: string;
  /** Source of `skill.py`. */
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds. Defaults to 60 s. */
  wallClockS?: number;
  ctxHandler: CtxHandler;
}

export interface RunTaskOnSessionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /**
   * True when the task completed within wall-clock and the worker is safe to
   * reuse for another task. False on wall-clock kill, transport error, or any
   * exception inside the dispatcher — the caller should treat the underlying
   * session as poisoned and recycle it.
   */
  workerReusable: boolean;
}

/**
 * Run one skill task on a pre-existing sandbox session. Spawns a fresh
 * `python -u -c <RUNNER>` exec on the session, drives it to completion via
 * NDJSON-on-stdin/stdout, and returns. Does NOT create or destroy the
 * underlying container — the caller (worker / pool) owns session lifetime.
 *
 * Recycle isolation: each call to this function gets a fresh python process
 * inside the same container, so module-level state from a prior task doesn't
 * leak. The container itself accumulates drift bounded by the pool's
 * recycle-after-N-tasks policy.
 *
 * Wall-clock kill closes the dispatcher (which closes the transport, which
 * EOFs the python process's stdin). The caller is expected to mark the worker
 * non-reusable and tear the container down — in-flight subprocesses inside
 * the container are not guaranteed to die just from the python parent
 * exiting, so the safe response to a wall-clock kill is recycle, not reuse.
 */
export async function runTaskOnSession(
  session: SandboxSession,
  params: RunTaskOnSessionParams,
): Promise<RunTaskOnSessionResult> {
  const wallClockS = params.wallClockS ?? DEFAULT_WALL_CLOCK_S;

  const built = buildRunnerSource(params.body);
  if (!built.ok) {
    return { ok: false, error: built.error, workerReusable: true };
  }

  const exec = await session.execStreaming(["python3", "-u", "-c", built.source], {
    attachStdin: true,
  });
  if (!exec.stdin) {
    // attachStdin: true was set so this is unreachable; satisfy the type
    // narrow without a non-null assertion.
    throw new Error("exec returned without stdin despite attachStdin=true");
  }

  // Drain stderr to the host log — skill prints, traceback, etc. Help
  // diagnosis; not part of the protocol.
  exec.stderr.setEncoding("utf-8");
  exec.stderr.on("data", (chunk: string) => {
    log.debug({ taskId: params.taskId, skillName: params.skillName }, chunk.trimEnd());
  });

  const transport = createNdjsonTransport(exec.stdin, exec.stdout);
  const dispatcher = new Dispatcher({ transport, ctxHandler: params.ctxHandler });

  const invoke: TaskInvoke = {
    type: "task_invoke",
    id: params.taskId,
    skill: params.skillName,
    inputs: params.inputs,
  };
  let taskPromise: Promise<TaskResult>;
  try {
    taskPromise = dispatcher.invoke(invoke);
  } catch (e) {
    dispatcher.close();
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      workerReusable: false,
    };
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), wallClockS * 1000);
  });

  // Use the two-arg `.then` so the wrapped promise has a rejection
  // handler attached BEFORE the race starts. When the timeout wins, we
  // call `dispatcher.close("timeout")` which rejects `taskPromise`; if
  // there were no handler the rejection would float past the race and
  // surface as an unhandled rejection (Node 22+ logs/exits on these).
  const wrappedTask = taskPromise.then(
    (r) => ({ kind: "ok" as const, r }),
    (err: unknown) => ({ kind: "err" as const, err }),
  );
  const winner = await Promise.race([wrappedTask, timeoutPromise]);
  // Always release the timer — when the task wins the race, the unfired
  // timeout would otherwise keep the event loop alive until wallClockS
  // elapses, blocking process shutdown and leaking handles in tests.
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (winner === "timeout") {
    log.warn(
      { taskId: params.taskId, skillName: params.skillName, wallClockS },
      "wall-clock exceeded — closing dispatcher; caller should recycle worker",
    );
    dispatcher.close("timeout");
    return { ok: false, error: "wall_clock_exceeded", workerReusable: false };
  }

  dispatcher.close();
  if (winner.kind === "err") {
    const message = winner.err instanceof Error ? winner.err.message : String(winner.err);
    return { ok: false, error: message, workerReusable: false };
  }
  return resultToReturn(winner.r);
}

/**
 * Compute the sandbox `expiresAt` for a one-shot session that runs a single
 * task with `wallClockS` budget. Used by the legacy non-pooled path; the pool
 * computes its own expiresAt from the worker's idle TTL.
 */
export function expiresAtForOneShot(wallClockS: number): Date {
  return new Date(Date.now() + (wallClockS + REAPER_BACKSTOP_S) * 1000);
}

export interface RunOnSysboxContainerParams {
  taskId: string;
  skillName: string;
  body: string;
  inputs: unknown;
  wallClockS?: number;
  resourceLimits?: Partial<ResourceLimits>;
  image: string;
  sandbox: SandboxClient;
  ctxHandler: CtxHandler;
}

export interface RunOnSysboxContainerResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/**
 * Spawn a one-shot sysbox container, drive a single skill task to completion,
 * and tear the container down. Used when no worker pool is wired in (tests,
 * tools without a long-lived runner). Production wiring uses the pool — see
 * `worker-sysbox/pool.ts`.
 */
export async function runOnSysboxContainer(
  params: RunOnSysboxContainerParams,
): Promise<RunOnSysboxContainerResult> {
  const wallClockS = params.wallClockS ?? DEFAULT_WALL_CLOCK_S;
  const resourceLimits: ResourceLimits = {
    cpus: params.resourceLimits?.cpus ?? DEFAULT_RESOURCE_LIMITS.cpus,
    memory_bytes: params.resourceLimits?.memory_bytes ?? DEFAULT_RESOURCE_LIMITS.memory_bytes,
    pids: params.resourceLimits?.pids ?? DEFAULT_RESOURCE_LIMITS.pids,
  };

  // Pre-flight the source size before paying for image-pull + container
  // create. The same check inside `runTaskOnSession` covers the pool path,
  // but here it would happen after `sandbox.create` — wasted work.
  const built = buildRunnerSource(params.body);
  if (!built.ok) {
    return { ok: false, error: built.error };
  }

  let stoppedByHost = false;
  const stop = async (): Promise<void> => {
    if (stoppedByHost) return;
    stoppedByHost = true;
    await params.sandbox.deleteByTaskId(params.taskId).catch((e: unknown) => {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), taskId: params.taskId },
        "deleteByTaskId failed during cleanup",
      );
    });
  };

  try {
    await params.sandbox.ensureImagePresent(params.image);

    const session = await params.sandbox.create({
      taskId: params.taskId,
      image: params.image,
      resourceLimits,
      expiresAt: expiresAtForOneShot(wallClockS),
    });

    const r = await runTaskOnSession(session, {
      taskId: params.taskId,
      skillName: params.skillName,
      body: params.body,
      inputs: params.inputs,
      ...(params.wallClockS !== undefined && { wallClockS: params.wallClockS }),
      ctxHandler: params.ctxHandler,
    });
    return r.ok
      ? { ok: true, ...(r.output !== undefined && { output: r.output }) }
      : { ok: false, ...(r.error !== undefined && { error: r.error }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await stop();
  }
}

function resultToReturn(result: TaskResult): RunTaskOnSessionResult {
  return result.ok
    ? { ok: true, output: result.output, workerReusable: true }
    : { ok: false, error: result.error, workerReusable: true };
}
