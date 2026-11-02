import { Worker } from "node:worker_threads";
import { match, P } from "ts-pattern";
import { INTERRUPT_MESSAGE } from "./interrupt-message.js";

/**
 * A wasm child's main thread (design/skills.md → Wasm-tier boundary, layer 1).
 * The host forks it under `--permission` and relays frames over IPC; this
 * thread runs no Python. It owns the interrupt buffer it shares with the
 * Pyodide worker thread, so the host's `interrupt` message reaches a worker
 * busy in a loop, and it exits when the host's channel closes, so a dying
 * host takes it down.
 *
 * The first IPC message is the child's `ChildInit`; it starts the worker,
 * which reads it. Every later message but `interrupt` goes to the worker, and
 * every worker message comes back over IPC.
 */

/** Exit code when the host's IPC channel closes. */
const EXIT_HOST_GONE = 3;
/** Exit code when the Pyodide worker thread crashes or exits non-zero. */
const EXIT_WORKER_FAILED = 1;
/** The Pyodide interrupt buffer's SIGINT. */
const SIGINT = 2;

const send = process.send?.bind(process);
if (send === undefined) {
  process.stderr.write("wasm child: started without an IPC channel\n");
  process.exit(EXIT_WORKER_FAILED);
}

process.on("disconnect", () => process.exit(EXIT_HOST_GONE));

const interruptBuffer = new SharedArrayBuffer(1);
let worker: Worker | undefined;
let ready = false;

process.on("message", (message: unknown) => {
  if (worker === undefined) {
    worker = startWorker(message);
    return;
  }
  if (isInterrupt(message)) {
    Atomics.store(new Uint8Array(interruptBuffer), 0, SIGINT);
    return;
  }
  worker.postMessage(message);
});

function isInterrupt(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === INTERRUPT_MESSAGE.type
  );
}

/**
 * The Pyodide worker. No `execArgv`: an explicit one drops the process's
 * permission grant, and the worker inherits `--permission`, its grants and
 * the process-wide `--disallow-code-generation-from-strings` without one.
 * The bundle emits it beside this file as `wasm-pyodide-worker.mjs`
 * (`child-bundle.ts`).
 */
function startWorker(init: unknown): Worker {
  const started = new Worker(new URL("./wasm-pyodide-worker.mjs", import.meta.url), {
    env: {},
    workerData: { init, interruptBuffer },
  });
  started.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "ready"
    ) {
      ready = true;
    }
    relay(started, message);
  });
  started.on("error", (e: Error) => fail(`pyodide worker crashed: ${e.message}`));
  started.on("exit", (code: number) => {
    if (code !== 0) fail(`pyodide worker exited (code ${code})`);
  });
  return started;
}

/**
 * Send a worker frame to the host. A frame IPC's JSON cannot carry (a Python
 * int past 2^53 arrives as a BigInt) fails the task or the ctx call that sent
 * it as a value, rather than throw out of the listener and end the child.
 */
function relay(worker: Worker, message: unknown): void {
  let reason: string;
  try {
    send?.(message);
    return;
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  // An untyped frame: the worker's protocol is not parsed on this thread.
  match(message)
    .with({ type: "task_result", id: P.string }, ({ id }) =>
      send?.({
        type: "task_result",
        id,
        ok: false,
        error: `task output is not JSON-serializable: ${reason}`,
      }),
    )
    .with({ type: "ctx_call", id: P.string, taskId: P.string }, ({ id, taskId }) =>
      worker.postMessage({
        type: "ctx_result",
        taskId,
        id,
        ok: false,
        errorKind: "invalid_args",
        message: `ctx call arguments are not JSON-serializable: ${reason}`,
      }),
    )
    .otherwise(() => fail(`could not relay a worker frame: ${reason}`));
}

/**
 * End the child over a dead worker. Before `ready` the reason goes to the host
 * as the handshake's `fatal`; after it, to stderr, and the host sees the exit.
 */
function fail(reason: string): void {
  process.stderr.write(`wasm child: ${reason}\n`);
  if (ready || send === undefined) {
    process.exit(EXIT_WORKER_FAILED);
  }
  send({ type: "fatal", error: reason }, undefined, undefined, () =>
    process.exit(EXIT_WORKER_FAILED),
  );
}
