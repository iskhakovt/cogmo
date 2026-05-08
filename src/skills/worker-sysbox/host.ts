import { logger } from "../../logger.js";
import type {
  LocalDockerSessionState,
  ResourceLimits,
  SandboxClient,
} from "../../sandbox/index.js";
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
const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
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

export interface RunOnSysboxContainerParams {
  taskId: string;
  /** Skill name — informational only; surfaced in logs and labels. */
  skillName: string;
  /** Source of `skill.py`. */
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds. Defaults to 60 s. */
  wallClockS?: number;
  /** Per-skill memory / cpu / pid overrides. Defaults applied per field. */
  resourceLimits?: Partial<ResourceLimits>;
  /** Container image — typically `python:3.14-slim` or a Cogmo-baked equivalent. */
  image: string;
  sandbox: SandboxClient<LocalDockerSessionState>;
  ctxHandler: CtxHandler;
}

export interface RunOnSysboxContainerResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/**
 * Spawn a one-shot sysbox container, drive a single skill task to completion
 * over NDJSON-on-stdin/stdout, and tear the container down. Mirrors the
 * tier-1 `runOnWorker` shape exactly — same dispatcher, same ctx handler,
 * different transport + runtime.
 *
 * Lifecycle:
 *  1. Ensure the container image is present (lazy pull).
 *  2. `createTaskContainer` (no worktree, no home volume — skills don't need them).
 *  3. `exec python3 -u -c <RUNNER>` with stdin attached for RPC.
 *  4. `Dispatcher.invoke` → host services every `ctx_call` mid-task.
 *  5. Wall-clock kill via `stopTask` if the timer fires before `task_result`.
 *  6. `stopTask` on the way out, success or fail.
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

  // Skill body is inlined as a Python literal at the head of the runner. JSON
  // string literals are a compatible subset of Python double-quoted string
  // literals (same backslash escapes, same \uXXXX), so JSON.stringify yields
  // a valid Python expression. Safe specifically because JSON.stringify never
  // emits the `\/` escape (legal in JSON, illegal in Python) — if the encoder
  // ever changes (or someone hand-rolls an alternative), this assumption
  // breaks silently. Long-term, if real skills push into the ARG_MAX wall,
  // we extend `task_invoke` with a `body` field and stream it — the runner
  // already routes on message type.
  const fullSource = `__skill_body__ = ${JSON.stringify(params.body)}\n${RUNNER_PY}`;
  if (Buffer.byteLength(fullSource, "utf-8") > MAX_RUNNER_SOURCE_BYTES) {
    return {
      ok: false,
      error: `runner source exceeds ${MAX_RUNNER_SOURCE_BYTES} bytes (skill body too large for tier-2 inline transport)`,
    };
  }

  // Reaper TTL is a backstop — host-side timer below kills first. Add a
  // 30 s buffer so the reaper never beats us during normal operation; if
  // the host crashes between create and deleteByTaskId, the reaper still
  // collects the orphan within wallClockS + 30 s.
  const expiresAt = new Date(Date.now() + (wallClockS + 30) * 1000);

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
      expiresAt,
    });

    const exec = await session.execStreaming(["python3", "-u", "-c", fullSource], {
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
    const taskPromise = dispatcher.invoke(invoke);

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
        "wall-clock exceeded — stopping container",
      );
      dispatcher.close("timeout");
      await stop();
      return { ok: false, error: "wall_clock_exceeded" };
    }

    dispatcher.close();
    if (winner.kind === "err") {
      const message = winner.err instanceof Error ? winner.err.message : String(winner.err);
      return { ok: false, error: message };
    }
    return resultToReturn(winner.r);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await stop();
  }
}

function resultToReturn(result: TaskResult): RunOnSysboxContainerResult {
  return result.ok ? { ok: true, output: result.output } : { ok: false, error: result.error };
}
