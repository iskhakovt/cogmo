import type { Readable, Writable } from "node:stream";
import type { Result } from "neverthrow";
import { match } from "ts-pattern";

/**
 * The exec contract every sandbox backend implements. See design/sandbox.md
 * → Exec lifecycle.
 */

export interface ExecOptions {
  workingDir?: string;
  user?: string;
  env?: Readonly<Record<string, string>>;
  /** When true, `stdin` is exposed on the returned streaming handle. */
  attachStdin?: boolean;
  /**
   * Total wall-clock cap, from the `execStreaming()` call. When it passes, the
   * exec settles as `timed_out` and the backend tears it down. Omitted = no cap.
   */
  timeoutMs?: number;
  /**
   * No-output cap. Arms once the command runs, restarts on every
   * stdout/stderr chunk, and restarts once more when the output ends, to
   * bound fetching the exit code. Catches a transport that holds open but
   * sends nothing. Omitted = no cap.
   */
  idleTimeoutMs?: number;
  /** Aborting it disposes the exec. */
  signal?: AbortSignal;
}

export interface ExecExit {
  exitCode: number;
}

/** Why an exec reported no exit code. */
export type ExecFailure =
  | { kind: "timed_out"; deadline: "total" | "idle"; timeoutMs: number }
  /** `dispose()` was called, or `ExecOptions.signal` aborted. */
  | { kind: "disposed" }
  /** The transport failed: starting the command, streaming its output, or fetching its exit code. */
  | { kind: "transport_failed"; error: Error }
  /** The output ended, but the backend has no exit code for it. */
  | { kind: "no_exit_code"; reason: string };

/** A failure the exec lifecycle itself decided, rather than its transport. */
export type ExecLifecycleFailure = Exclude<ExecFailure, { kind: "transport_failed" }>;

/** What `wait()` throws for a failure the lifecycle decided; `failure` says which. */
export class ExecError extends Error {
  readonly failure: ExecLifecycleFailure;
  constructor(failure: ExecLifecycleFailure) {
    super(describeExecFailure(failure));
    this.name = "ExecError";
    this.failure = failure;
  }
}

function describeExecFailure(failure: ExecLifecycleFailure): string {
  return match(failure)
    .with(
      { kind: "timed_out", deadline: "total" },
      (f) => `exec exceeded wall-clock timeout ${f.timeoutMs}ms`,
    )
    .with(
      { kind: "timed_out", deadline: "idle" },
      (f) => `exec exceeded idle timeout ${f.timeoutMs}ms with no stdout/stderr activity`,
    )
    .with({ kind: "disposed" }, () => "exec was disposed")
    .with({ kind: "no_exit_code" }, (f) => f.reason)
    .exhaustive();
}

/**
 * The error `wait()` throws for a failure: the transport's own error, which
 * keeps its SDK's type, or an `ExecError` carrying the lifecycle's failure.
 */
export function execFailureError(failure: ExecFailure): Error {
  return failure.kind === "transport_failed" ? failure.error : new ExecError(failure);
}

/** The exit, or the failure thrown as `execFailureError` describes. */
export function unwrapExit(result: Result<ExecExit, ExecFailure>): ExecExit {
  if (result.isErr()) throw execFailureError(result.error);
  return result.value;
}

/**
 * Buffered exec result. `stdout` / `stderr` are read fully into memory —
 * intended for short, bounded commands. Backends cap buffered output at
 * `SANDBOX_EXEC_BUFFER_LIMIT` (default 1 MiB per stream); when a command
 * exceeds the cap, `truncated` is set and the stream contents are clipped
 * to the cap. Consumers expecting larger output use `execStreaming`.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  wallTimeSeconds: number;
  truncated: boolean;
}

/**
 * Streaming exec handle. `stdout` / `stderr` are demultiplexed Readables (no
 * inline framing, per-chunk not per-line). They end when the exec settles,
 * and fail with the transport's error only when the transport breaks while
 * output is flowing; either way `exited` carries the outcome, so an unread
 * stream never crashes the process.
 *
 * `exited` settles exactly once and never rejects. A deadline, `dispose()` or
 * an aborted `signal` settles it at once: tearing the backend down is a side
 * effect that runs after, and never delays it. `wait()` is its throwing form
 * (see `unwrapExit`).
 *
 * `dispose()` tears the exec down. Local-Docker stops the command's process
 * group (TERM, then KILL) from a second exec and closes the attach socket;
 * the Daytona PTY kills its process; a Daytona session command has its
 * session deleted, which the SDK does not document as stopping the
 * command's processes. Idempotent. Resolves once every teardown it caused
 * has finished or given up.
 *
 * The caller either consumes `stdout`/`stderr` to EOF or calls `dispose()`;
 * otherwise the backend may hold the connection open.
 */
export interface ExecStreamingHandle {
  stdin?: Writable;
  stdout: Readable;
  stderr: Readable;
  readonly exited: Promise<Result<ExecExit, ExecFailure>>;
  wait(): Promise<ExecExit>;
  dispose(): Promise<void>;
}
