import type { Sandbox as DaytonaSdkSandbox } from "@daytonaio/sdk";
import type {
  DaytonaSessionState,
  ExecOptions,
  ExecResult,
  ExecStreamingHandle,
  SandboxSession,
} from "../index.js";
import { startExecStreaming } from "./exec-streaming.js";

/** Buffered-exec output cap per stream — same as local-docker. */
const EXEC_BUFFER_LIMIT_BYTES = 1024 * 1024;

/**
 * Per-task session against a single Daytona sandbox. Buffered `exec()` is
 * a buffer-and-cap wrapper around `execStreaming()` so stdout/stderr come
 * back demultiplexed (Daytona's non-streaming `executeCommand` merges the
 * two into a single `result` field — no good for our `ExecResult` shape).
 */
export class DaytonaSandboxSession implements SandboxSession<DaytonaSessionState> {
  readonly state: DaytonaSessionState;
  #sdkSandbox: DaytonaSdkSandbox;

  constructor(args: { state: DaytonaSessionState; sdkSandbox: DaytonaSdkSandbox }) {
    this.state = args.state;
    this.#sdkSandbox = args.sdkSandbox;
  }

  async exec(cmd: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const start = Date.now();
    const handle = await this.execStreaming(cmd, opts);
    const stdoutBuf = new BoundedBuffer(EXEC_BUFFER_LIMIT_BYTES);
    const stderrBuf = new BoundedBuffer(EXEC_BUFFER_LIMIT_BYTES);
    handle.stdout.on("data", (chunk: Buffer | string) => stdoutBuf.push(toBuffer(chunk)));
    handle.stderr.on("data", (chunk: Buffer | string) => stderrBuf.push(toBuffer(chunk)));
    // Attach no-op `'error'` listeners so a stream `destroy(err)` from a
    // real upstream failure (network drop, daemon refused) doesn't fire
    // an unhandled `'error'` event that crashes the worker. The actual
    // error still propagates via the `wait()` rejection below — these
    // handlers exist only to absorb the per-stream notification.
    handle.stdout.on("error", () => {});
    handle.stderr.on("error", () => {});
    try {
      const { exitCode } = await handle.wait();
      return {
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
        exitCode,
        wallTimeSeconds: (Date.now() - start) / 1000,
        truncated: stdoutBuf.truncated || stderrBuf.truncated,
      };
    } finally {
      // Defensive: the streaming wrapper deletes its per-call Daytona
      // session on natural exit too, so this is usually a no-op. But
      // if `wait()` threw before the WS resolve fired (mid-stream
      // error path), the cleanup hadn't run yet — `dispose()` here
      // makes sure we never leak a session.
      await handle.dispose();
    }
  }

  async execStreaming(
    cmd: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecStreamingHandle> {
    return startExecStreaming({
      process: this.#sdkSandbox.process,
      sessionIdPrefix: `cogmo-${this.state.taskId.slice(0, 12)}`,
      cmd,
      opts,
    });
  }
}

class BoundedBuffer {
  #chunks: Buffer[] = [];
  #size = 0;
  #limit: number;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.#size >= this.#limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.#limit - this.#size;
    if (chunk.length <= remaining) {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
      return;
    }
    this.#chunks.push(chunk.subarray(0, remaining));
    this.#size = this.#limit;
    this.truncated = true;
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
}
