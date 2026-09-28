import { type EventEmitter, on } from "node:events";
import type { MessagePort } from "node:worker_threads";
import { logger } from "../../logger.js";
import { parseWorkerFrame, type WorkerTransport } from "../dispatcher.js";
import type { WorkerFrame } from "../worker-state.js";

const log = logger.child({ component: "skills.worker.wasm" });

/**
 * A Pyodide worker thread's port as a transport. `thread` carries the
 * thread's own `error` and `exit`: the messages fail once it errors or
 * exits. The thread runs one task and is terminated after it, so nothing
 * the task started can outlive it: each `task_result` comes with the
 * task's `task_exited`.
 */
export function createPortTransport(port: MessagePort, thread: EventEmitter): WorkerTransport {
  const closed = new AbortController();
  const gone = new AbortController();
  // Also keeps late errors after teardown — Pyodide's KeyboardInterrupt
  // after the SAB interrupt, libuv handle-close races — from escaping to
  // the process as unhandled.
  thread.on("error", (e: Error) => {
    log.debug({ err: e.message }, "worker thread error");
    gone.abort(new Error(`worker crashed: ${e.message}`));
  });
  thread.once("exit", (code: number) => gone.abort(new Error(`worker exited (code ${code})`)));

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
