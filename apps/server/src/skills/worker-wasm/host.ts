import { MessageChannel, Worker } from "node:worker_threads";
import { logger } from "../../logger.js";
import { CtxError, type CtxHandler, Dispatcher, type RpcTransport } from "../dispatcher.js";
import type { RuntimeRusage, TaskInvoke, TaskResult } from "../protocol.js";

const log = logger.child({ component: "skills.worker.wasm" });

/** Default wall-clock cap for tier-1 skills (`design/skills.md` Resource budgets). */
/**
 * Wall clock applied when a manifest declares no `resources.wall_clock_s`.
 * Exported because `ctx.http` sizes its request timeout under it — a
 * request that outlives the terminator can never surface as a catchable
 * error, so the two constants have to be read together.
 */
export const DEFAULT_WALL_CLOCK_S = 30;

/** Grace window after firing the SAB interrupt before hard-terminating the worker. */
const TERMINATE_GRACE_MS = 1000;

/** Pyodide cold start (~5s) + micropip resolve from PyPI for a moderately-deps'd skill. */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface RunOnWorkerParams {
  taskId: string;
  /** Skill name — informational only; surfaced in logs. */
  skillName: string;
  /** Source of `skill.py`. */
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds. Defaults to 30 s. */
  wallClockS?: number;
  /** Worker init cap (Pyodide load + micropip install). Defaults to 60s. */
  readyTimeoutMs?: number;
  /**
   * Pyodide package cache for the runtime's built-in package downloads.
   * Does NOT cover micropip-fetched wheels — those re-download from
   * PyPI on every worker init today. Tracked in todo.md.
   */
  packageCacheDir?: string;
  /**
   * Direct `pkg==version` specs the worker should `micropip.install`
   * before signalling `ready`. Sourced from the skill's
   * `requirements.lock` via `parseLockfilePackageSpecs` — already
   * narrowed to direct deps, hash-pinned via the lockfile contract.
   * Absent / empty array → stdlib + Pyodide built-ins only.
   *
   * Install runs via Pyodide's `micropip` (Node fetch under the hood),
   * with results cached in `packageCacheDir` when configured.
   * Pyodide-incompatible wheels surface as a `fatal` worker init
   * error — the runner re-raises as the task's `error` and the
   * worker exits.
   */
  packageSpecs?: readonly string[];
  ctxHandler: CtxHandler;
}

export interface RunOnWorkerResult {
  ok: boolean;
  /** Set when ok=true. */
  output?: unknown;
  /** Set when ok=false. */
  error?: string;
  /**
   * Per-task rusage from the runtime when present. Tier 1 (Pyodide WASM)
   * doesn't fill this — `getrusage` is process-wide and would inflate
   * under concurrent workers — but the host still propagates it when the
   * supervisor surfaces one in the future.
   */
  rusage?: RuntimeRusage;
}

/**
 * Spawn a one-shot Pyodide worker, drive it through the `Dispatcher`, and
 * return the task result. Enforces a host-side wall-clock cap: on timeout,
 * fires the SAB interrupt to interrupt cooperative Python loops; if the
 * worker doesn't surrender within `TERMINATE_GRACE_MS`, calls
 * `worker.terminate()` as the hard fallback (the documented Pyodide
 * known-limit path for tight CPU loops).
 */
export async function runOnWorker(params: RunOnWorkerParams): Promise<RunOnWorkerResult> {
  const wallClockS = params.wallClockS ?? DEFAULT_WALL_CLOCK_S;
  const readyTimeoutMs = params.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const interruptBuffer = new SharedArrayBuffer(1);

  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const workerPort = channel.port2;

  const worker = new Worker(workerEntryUrl(), {
    workerData: {
      port: workerPort,
      body: params.body,
      ...(params.packageCacheDir && { packageCacheDir: params.packageCacheDir }),
      ...(params.packageSpecs &&
        params.packageSpecs.length > 0 && {
          packageSpecs: [...params.packageSpecs],
        }),
      interruptBuffer,
    },
    transferList: [workerPort],
  });
  // Register an `error` listener so any post-teardown unwinds (Pyodide's
  // KeyboardInterrupt after the SAB interrupt fires; libuv handle close
  // races) don't escape to the process as unhandled exceptions. The host
  // path has already returned by the time these arrive.
  worker.on("error", (e: Error) => {
    log.debug({ err: e.message, taskId: params.taskId }, "worker error during teardown");
  });

  // Wait for the worker's `ready` message before sending task_invoke.
  // Reject on `worker.error` / `worker.exit` so a synchronous Pyodide
  // load failure surfaces immediately. Reject on `readyTimeoutMs` so a
  // hung micropip install (slow PyPI, resolver dead-end) doesn't wedge
  // the worker indefinitely — the task watchdog only starts after ready.
  const ready = new Promise<void>((resolve, reject) => {
    const readyTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker_init_timeout after ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);
    const onMessage = (raw: unknown): void => {
      const msg = raw as { type?: string; error?: string };
      if (msg?.type === "ready") {
        cleanup();
        resolve();
      } else if (msg?.type === "fatal") {
        cleanup();
        reject(new Error(`worker init failed: ${msg.error ?? "unknown"}`));
      }
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(new Error(`worker init crashed: ${e.message}`));
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`worker exited before ready (code ${code})`));
    };
    function cleanup(): void {
      clearTimeout(readyTimer);
      hostPort.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    }
    hostPort.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });

  let finished = false;
  let workerTerminated = false;

  const cleanup = async (): Promise<void> => {
    if (workerTerminated) return;
    workerTerminated = true;
    hostPort.close();
    workerPort.close();
    await worker.terminate().catch(() => {
      /* terminate after exit is benign */
    });
  };

  try {
    await ready;

    // Dispatcher uses the host port; it must NOT see the ready/fatal frames,
    // so we wrap the port to filter them out. The ready handler above
    // detached itself before invoke runs.
    const transport = adaptPort(hostPort);
    const dispatcher = new Dispatcher({ transport, ctxHandler: params.ctxHandler });

    const invoke: TaskInvoke = {
      type: "task_invoke",
      id: params.taskId,
      skill: params.skillName,
      inputs: params.inputs,
    };

    const taskPromise = dispatcher.invoke(invoke);

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), wallClockS * 1000);
    });

    const winner = await Promise.race([
      taskPromise.then((r) => ({ kind: "ok" as const, r })),
      timeoutPromise,
    ]);

    if (winner === "timeout") {
      log.warn(
        { taskId: params.taskId, skillName: params.skillName, wallClockS },
        "wall-clock exceeded — interrupting worker",
      );
      // Cooperative interrupt: writing 2 fires SIGINT-equivalent on the
      // next JS↔WASM boundary. Pure CPU loops with no boundary won't yield;
      // the grace window + worker.terminate() is the documented fallback.
      new Uint8Array(interruptBuffer)[0] = 2;

      const grace = await Promise.race([
        taskPromise.then((r) => ({ kind: "ok" as const, r })),
        new Promise<"grace_expired">((resolve) =>
          setTimeout(() => resolve("grace_expired"), TERMINATE_GRACE_MS),
        ),
      ]);

      finished = true;
      dispatcher.close("timeout");
      await cleanup();

      if (grace !== "grace_expired") {
        return resultToReturn(grace.r);
      }
      return { ok: false, error: "wall_clock_exceeded" };
    }

    finished = true;
    dispatcher.close();
    await cleanup();
    return resultToReturn(winner.r);
  } catch (e) {
    if (!finished) await cleanup();
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function resultToReturn(result: TaskResult): RunOnWorkerResult {
  const base = result.ok
    ? ({ ok: true, output: result.output } as const)
    : ({ ok: false, error: result.error } as const);
  return result.rusage ? { ...base, rusage: result.rusage } : base;
}

/**
 * Adapt a Node `MessagePort` to the dispatcher's `RpcTransport` shape. The
 * dispatcher schema-validates and discards anything it doesn't recognize, so
 * stray `ready` / `fatal` frames (already consumed by the init handshake)
 * are dropped harmlessly.
 */
function adaptPort(port: import("node:worker_threads").MessagePort): RpcTransport {
  return {
    postMessage: (msg) => port.postMessage(msg),
    onMessage: (h) => port.on("message", h),
    close: () => {
      // host already calls port.close() during cleanup — this is a noop
      // here so `dispatcher.close()` doesn't double-close.
    },
  };
}

/**
 * Resolve the worker entry. tsup builds `worker-entry.ts` →
 * `dist/skills/worker-wasm/worker-entry.js` for production. In dev/tests we
 * point Node at the `boot.mjs` wrapper that registers tsx's ESM loader
 * inside the worker thread (Node 22.2+ disallows custom loaders via parent
 * `execArgv`/inheritance, so the worker has to register them itself —
 * see nodejs/node#53195).
 */
function workerEntryUrl(): URL {
  const isSource = import.meta.url.endsWith(".ts");
  return new URL(isSource ? "./boot.mjs" : "./worker-entry.js", import.meta.url);
}

export { CtxError };
