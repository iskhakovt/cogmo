import { on } from "node:events";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import {
  type CtxHandler,
  Dispatcher,
  parseWorkerFrame,
  type WorkerTransport,
} from "../dispatcher.js";
import type { RuntimeRusage, TaskResult } from "../protocol.js";
import { DEFAULT_WALL_CLOCK_S, timeoutSignal } from "../wall-clock.js";
import type { StartFailure, WorkerFrame } from "../worker-state.js";

const log = logger.child({ component: "skills.worker.wasm" });

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
 * Spawn a one-shot Pyodide worker, drive its single task through a
 * `Dispatcher`, and tear it down. Enforces a host-side wall clock: when it
 * passes, fires the SAB interrupt to stop cooperative Python loops; a
 * result that lands within `TERMINATE_GRACE_MS` still counts, and after
 * that the task fails and `worker.terminate()` ends it — the documented
 * Pyodide fallback for tight CPU loops.
 */
export async function runOnWorker(params: RunOnWorkerParams): Promise<RunOnWorkerResult> {
  const readyTimeoutMs = params.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const interruptBuffer = new SharedArrayBuffer(1);

  const channel = new MessageChannel();
  const worker = new Worker(workerEntryUrl(), {
    workerData: {
      port: channel.port2,
      body: params.body,
      ...(params.packageCacheDir && { packageCacheDir: params.packageCacheDir }),
      ...(params.packageSpecs &&
        params.packageSpecs.length > 0 && {
          packageSpecs: [...params.packageSpecs],
        }),
      interruptBuffer,
    },
    transferList: [channel.port2],
  });

  try {
    const opened = await Dispatcher.open({
      transport: createPortTransport(channel.port1, worker),
      handshake: acceptWorkerReady,
      // Bounds a hung micropip install (slow PyPI, resolver dead-end); the
      // task's own deadline starts only after the handshake.
      handshakeDeadline: timeoutSignal(readyTimeoutMs),
      logContext: { taskId: params.taskId },
    });
    return await opened.match(
      (dispatcher) => runTask(dispatcher, params, interruptBuffer),
      (failure) =>
        Promise.resolve({ ok: false, error: describeStartFailure(failure, readyTimeoutMs) }),
    );
  } finally {
    await worker.terminate().catch(() => {
      /* terminate after exit is benign */
    });
  }
}

/** Run the worker's one task under the wall clock, then close its channel. */
async function runTask(
  dispatcher: Dispatcher,
  params: RunOnWorkerParams,
  interruptBuffer: SharedArrayBuffer,
): Promise<RunOnWorkerResult> {
  const wallClockS = params.wallClockS ?? DEFAULT_WALL_CLOCK_S.wasm;
  const finished = new AbortController();
  try {
    // False only if the thread died since its handshake; the invoke below
    // then fails the task as a value.
    dispatcher.tryAcquire();

    const wallClock = timeoutSignal(wallClockS * 1000);
    wallClock.addEventListener(
      "abort",
      () => {
        log.warn(
          { taskId: params.taskId, skillName: params.skillName, wallClockS },
          "wall-clock exceeded — interrupting worker",
        );
        // Cooperative interrupt: writing 2 fires SIGINT-equivalent on the
        // next JS↔WASM boundary. Pure CPU loops with no boundary won't yield;
        // the grace window + worker.terminate() is the documented fallback.
        new Uint8Array(interruptBuffer)[0] = 2;
      },
      { once: true, signal: finished.signal },
    );
    const outcome = await dispatcher.invoke(
      { type: "task_invoke", id: params.taskId, skill: params.skillName, inputs: params.inputs },
      {
        ctxHandler: params.ctxHandler,
        deadline: timeoutSignal(wallClockS * 1000 + TERMINATE_GRACE_MS),
      },
    );
    return outcome.match(
      ({ result }) => fromTaskResult(result),
      (failure) => ({
        ok: false,
        error: match(failure)
          .with({ kind: "timed_out" }, () => "wall_clock_exceeded")
          // The interrupt can kill the thread outright: a task that fails
          // once the wall clock has passed failed because of it.
          .with({ kind: "failed" }, ({ reason }) =>
            wallClock.aborted ? "wall_clock_exceeded" : reason,
          )
          .exhaustive(),
      }),
    );
  } finally {
    finished.abort();
    dispatcher.close("finished");
  }
}

/** The worker's first frame: `ready` once Pyodide has loaded, `fatal` if it could not. */
function acceptWorkerReady(first: WorkerFrame): Result<void, string> {
  return match(first)
    .with({ type: "ready" }, () => ok(undefined))
    .with({ type: "fatal" }, ({ error }) => err(`worker init failed: ${error}`))
    .with({ type: "malformed" }, ({ issues }) =>
      err(`worker sent a malformed frame before ready (${issues.join("; ")})`),
    )
    .otherwise(({ type }) => err(`worker sent ${type} before ready`));
}

function describeStartFailure(failure: StartFailure, readyTimeoutMs: number): string {
  return match(failure)
    .with({ kind: "refused" }, ({ reason }) => reason)
    .with({ kind: "timed_out" }, () => `worker_init_timeout after ${readyTimeoutMs}ms`)
    .with({ kind: "ended" }, ({ reason }) => `worker init failed: ${reason}`)
    .with({ kind: "closed" }, ({ reason }) => `worker closed before ready: ${reason}`)
    .exhaustive();
}

function fromTaskResult(result: TaskResult): RunOnWorkerResult {
  return {
    ...(result.ok ? { ok: true, output: result.output } : { ok: false, error: result.error }),
    ...(result.rusage !== undefined && { rusage: result.rusage }),
  };
}

/**
 * The worker thread's `MessagePort` as a transport. Its messages fail once
 * the thread errors or exits. The thread runs one task and is terminated
 * after it, so nothing the task started can outlive it: each `task_result`
 * comes with the task's `task_exited`.
 */
function createPortTransport(port: MessagePort, worker: Worker): WorkerTransport {
  const closed = new AbortController();
  const gone = new AbortController();
  // Also keeps late errors after teardown — Pyodide's KeyboardInterrupt
  // after the SAB interrupt, libuv handle-close races — from escaping to
  // the process as unhandled.
  worker.on("error", (e: Error) => {
    log.debug({ err: e.message }, "worker thread error");
    gone.abort(new Error(`worker crashed: ${e.message}`));
  });
  worker.once("exit", (code: number) => gone.abort(new Error(`worker exited (code ${code})`)));

  async function* messages(): AsyncGenerator<WorkerFrame> {
    try {
      for await (const [raw] of on(port, "message", {
        signal: AbortSignal.any([closed.signal, gone.signal]),
      })) {
        const frame = parseWorkerFrame(raw);
        yield frame;
        if (frame.type === "task_result") yield { type: "task_exited", id: frame.id };
      }
    } catch (e) {
      if (closed.signal.aborted) return;
      throw gone.signal.aborted ? gone.signal.reason : e;
    }
  }

  return {
    send: (message) => port.postMessage(message),
    messages,
    close(): void {
      closed.abort();
      port.close();
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
