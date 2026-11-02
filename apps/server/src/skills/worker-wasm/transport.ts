import { type EventEmitter, on } from "node:events";
import { logger } from "../../logger.js";
import { parseWorkerFrame, type WorkerTransport } from "../dispatcher.js";
import type { WorkerFrame } from "../worker-state.js";

const log = logger.child({ component: "skills.worker.wasm" });

/**
 * A tier-1 child's IPC channel, as a forked `ChildProcess` exposes it: its
 * `message`, `error` and `close` events, `send`, and `disconnect`. `close`
 * follows the child's exit once its stdio and channel have drained, so no
 * frame arrives after it.
 */
export interface IpcChannel extends EventEmitter {
  send(message: unknown): boolean;
  readonly connected: boolean;
  disconnect(): void;
}

/**
 * A tier-1 child's IPC channel as a transport. The messages fail once the
 * child errors, or once it has exited and its channel closed, so a frame the
 * child sent just before exiting is still read. The child runs one task and
 * is killed after it, so nothing the task started can outlive it: each
 * `task_result` comes with the task's `task_exited`.
 */
export function createIpcTransport(child: IpcChannel): WorkerTransport {
  const closed = new AbortController();
  const gone = new AbortController();
  // Also keeps late errors after teardown — a send racing the child's exit —
  // from escaping to the process as unhandled.
  child.on("error", (e: Error) => {
    log.debug({ err: e.message }, "tier-1 child channel error");
    gone.abort(new Error(`worker crashed: ${e.message}`));
  });
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) =>
    gone.abort(new Error(`worker exited (${code === null ? `signal ${signal}` : `code ${code}`})`)),
  );

  async function* messages(): AsyncGenerator<WorkerFrame> {
    try {
      for await (const [raw] of on(child, "message", {
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
    send(message): void {
      if (closed.signal.aborted) return;
      child.send(message);
    },
    messages,
    close(): void {
      closed.abort();
      if (child.connected) child.disconnect();
    },
  };
}
