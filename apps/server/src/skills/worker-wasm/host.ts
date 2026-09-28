import type { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import { type CtxHandler, Dispatcher } from "../dispatcher.js";
import type { RuntimeRusage, TaskResult } from "../protocol.js";
import { DEFAULT_WALL_CLOCK_S, timeoutSignal } from "../wall-clock.js";
import type { StartFailure, WorkerFrame } from "../worker-state.js";
import { createPortTransport } from "./transport.js";

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

/** A Pyodide worker thread, as `runOnThread` drives it. */
export interface PyodideThread {
  /** The host's end of the thread's channel. */
  port: MessagePort;
  /** The thread's own `error` and `exit`. */
  events: EventEmitter;
  /** Stop cooperative Python code: the SAB interrupt. */
  interrupt(): void;
  terminate(): Promise<unknown>;
}

/**
 * Spawn a one-shot Pyodide worker, drive its single task through a
 * `Dispatcher`, and tear it down. Enforces a host-side wall clock: when it
 * passes, fires the SAB interrupt to stop cooperative Python loops; a
 * result that lands within `TERMINATE_GRACE_MS` still counts, and after
 * that the task fails and `worker.terminate()` ends it — the documented
 * Pyodide fallback for tight CPU loops.
 */
export function runOnWorker(params: RunOnWorkerParams): Promise<RunOnWorkerResult> {
  return runOnThread(spawnThread(params), params);
}

/**
 * Drive `thread` through its handshake and its one task, then terminate
 * it. `runOnWorker` hands it a Pyodide thread; tests hand it a stand-in.
 */
export async function runOnThread(
  thread: PyodideThread,
  params: RunOnWorkerParams,
): Promise<RunOnWorkerResult> {
  const readyTimeoutMs = params.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  try {
    const opened = await Dispatcher.open({
      transport: createPortTransport(thread.port, thread.events),
      handshake: acceptWorkerReady,
      // Bounds a hung micropip install (slow PyPI, resolver dead-end); the
      // task's own deadline starts only after the handshake.
      handshakeDeadline: timeoutSignal(readyTimeoutMs),
      logContext: { taskId: params.taskId },
    });
    return await opened.match(
      (dispatcher) => runTask(dispatcher, params, thread),
      (failure) =>
        Promise.resolve({ ok: false, error: describeStartFailure(failure, readyTimeoutMs) }),
    );
  } finally {
    await thread.terminate().catch(() => {
      /* terminate after exit is benign */
    });
  }
}

function spawnThread(params: RunOnWorkerParams): PyodideThread {
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
  return {
    port: channel.port1,
    events: worker,
    // Writing 2 fires SIGINT-equivalent on the next JS↔WASM boundary. Pure
    // CPU loops with no boundary won't yield; the grace window +
    // terminate() is the documented fallback.
    interrupt: () => {
      new Uint8Array(interruptBuffer)[0] = 2;
    },
    terminate: () => worker.terminate(),
  };
}

/** Run the thread's one task under the wall clock, then close its channel. */
async function runTask(
  dispatcher: Dispatcher,
  params: RunOnWorkerParams,
  thread: PyodideThread,
): Promise<RunOnWorkerResult> {
  const wallClockS = params.wallClockS ?? DEFAULT_WALL_CLOCK_S.wasm;
  const finished = new AbortController();
  try {
    // Refused only if the thread died since its handshake; the invoke below
    // then fails the task as a value.
    void dispatcher.tryAcquire();

    const wallClock = timeoutSignal(wallClockS * 1000);
    wallClock.addEventListener(
      "abort",
      () => {
        log.warn(
          { taskId: params.taskId, skillName: params.skillName, wallClockS },
          "wall-clock exceeded — interrupting worker",
        );
        thread.interrupt();
      },
      { once: true, signal: finished.signal },
    );
    const { result } = await dispatcher.invoke(
      { type: "task_invoke", id: params.taskId, skill: params.skillName, inputs: params.inputs },
      {
        ctxHandler: params.ctxHandler,
        deadline: timeoutSignal(wallClockS * 1000 + TERMINATE_GRACE_MS),
      },
    );
    return result.match(fromTaskResult, (failure) => ({
      ok: false,
      error: match(failure)
        .with({ kind: "timed_out" }, () => "wall_clock_exceeded")
        // The interrupt can kill the thread outright: a task that fails
        // once the wall clock has passed failed because of it.
        .with({ kind: "failed" }, ({ reason }) =>
          wallClock.aborted ? "wall_clock_exceeded" : reason,
        )
        .with({ kind: "exited_without_result" }, () => "task_exited_without_result")
        .exhaustive(),
    }));
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
