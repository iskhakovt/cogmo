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

/** What `wait()` throws for a `timed_out` exec. */
export class ExecTimeoutError extends Error {
  readonly kind: "total" | "idle";
  readonly timeoutMs: number;
  constructor(kind: "total" | "idle", timeoutMs: number) {
    super(
      kind === "total"
        ? `exec exceeded wall-clock timeout ${timeoutMs}ms`
        : `exec exceeded idle timeout ${timeoutMs}ms with no stdout/stderr activity`,
    );
    this.name = "ExecTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

/** What `wait()` throws for a `disposed` exec. */
export class ExecDisposedError extends Error {
  constructor() {
    super("exec was disposed");
    this.name = "ExecDisposedError";
  }
}

/**
 * The error `wait()` throws for a failure: `ExecTimeoutError`,
 * `ExecDisposedError`, the transport's own error, or an `Error` naming why
 * there is no exit code.
 */
export function execFailureError(failure: ExecFailure): Error {
  return match(failure)
    .returnType<Error>()
    .with({ kind: "timed_out" }, (f) => new ExecTimeoutError(f.deadline, f.timeoutMs))
    .with({ kind: "disposed" }, () => new ExecDisposedError())
    .with({ kind: "transport_failed" }, (f) => f.error)
    .with({ kind: "no_exit_code" }, (f) => new Error(f.reason))
    .exhaustive();
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
 * `dispose()` tears the exec down by closing its transport (Docker: the
 * hijacked socket; Daytona: `deleteSession` / the PTY kill); it sends no
 * signal. Idempotent. Resolves once the teardown has finished or given up.
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
