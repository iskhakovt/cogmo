import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { logger } from "../../logger.js";
import { CtxError, type CtxHandler, Dispatcher, type RpcTransport } from "../dispatcher.js";
import type { TaskInvoke, TaskResult } from "../protocol.js";

const log = logger.child({ component: "skills.worker.wasm" });

/** Default wall-clock cap for tier-1 skills (`design/skills.md` Resource budgets). */
const DEFAULT_WALL_CLOCK_S = 30;

/** Grace window after firing the SAB interrupt before hard-terminating the worker. */
const TERMINATE_GRACE_MS = 1000;

export interface RunOnWorkerParams {
  taskId: string;
  /** Skill name — informational only; surfaced in logs. */
  skillName: string;
  /** Source of `skill.py`. */
  body: string;
  inputs: unknown;
  /** Wall-clock cap in seconds. Defaults to 30 s. */
  wallClockS?: number;
  /** Pyodide package cache directory for warm starts. */
  packageCacheDir?: string;
  ctxHandler: CtxHandler;
}

export interface RunOnWorkerResult {
  ok: boolean;
  /** Set when ok=true. */
  output?: unknown;
  /** Set when ok=false. */
  error?: string;
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
  const interruptBuffer = new SharedArrayBuffer(1);

  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const workerPort = channel.port2;

  const worker = new Worker(workerEntryUrl(), {
    workerData: {
      port: workerPort,
      body: params.body,
      ...(params.packageCacheDir && { packageCacheDir: params.packageCacheDir }),
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
  const ready = new Promise<void>((resolve, reject) => {
    const handler = (raw: unknown): void => {
      const msg = raw as { type?: string; error?: string };
      if (msg?.type === "ready") {
        hostPort.off("message", handler);
        resolve();
      } else if (msg?.type === "fatal") {
        hostPort.off("message", handler);
        reject(new Error(`worker init failed: ${msg.error ?? "unknown"}`));
      }
    };
    hostPort.on("message", handler);
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
  return result.ok ? { ok: true, output: result.output } : { ok: false, error: result.error };
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
