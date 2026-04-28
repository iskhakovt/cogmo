/**
 * Post-hoc verify runner — slice 4.0e.
 *
 * Executes `bash -lc <verify_command>` inside the task container exactly
 * once, streams stdout+stderr to the supplied executeStream (Telegram-
 * visible), captures the combined output for storage (truncated to
 * `OUTPUT_CAP_BYTES`), and returns the exit code + wall time.
 *
 * No retry loop. Iterating on failure was the CLI's job during execute
 * per `design/coding-delegation.md → Self-verify clause`; this step exists
 * only to confirm the CLI's "done" claim. Pass → orchestrator proceeds to
 * push + PR (4.0f / 4.0g); fail → task is marked failed with the captured
 * output as the failure reason.
 *
 * Timeout: a single wall-clock cap (`coding_repos.verify_timeout_seconds`).
 * On expiry the runner returns `{ ok: false, exitCode: TIMEOUT_EXIT_CODE,
 * timedOut: true }` and the orchestrator's outer `stopTask` call kills the
 * actual process inside the container — we don't try to send a signal to
 * the in-container process from here, which keeps the runner pure I/O.
 */

import type { TaskContainerHandle } from "../../sandbox/index.js";
import type { ExecuteStreamHandle } from "./orchestrator.js";

/** Cap for the persisted verify output (8 KiB). Streamed text is unaffected
 * — only the captured `output` field is truncated. */
export const OUTPUT_CAP_BYTES = 8 * 1024;

/** Synthetic exit code returned when the verify exceeds its wall-clock budget. */
export const TIMEOUT_EXIT_CODE = 124;

export interface VerifyParams {
  container: Pick<TaskContainerHandle, "exec">;
  /** `coding_repos.verify_command` — passed verbatim to `bash -lc`. */
  verifyCommand: string;
  /** `coding_repos.verify_timeout_seconds` — wall-clock cap. */
  timeoutSeconds: number;
  /** Optional Telegram-visible stream. Defaults to `NULL_EXECUTE_STREAM`-equivalent. */
  executeStream?: ExecuteStreamHandle;
}

export interface VerifyResult {
  /** True iff exit code was 0 within the timeout. */
  ok: boolean;
  /** `TIMEOUT_EXIT_CODE` when timed out. */
  exitCode: number;
  /** Combined stdout+stderr, truncated at `OUTPUT_CAP_BYTES`. */
  output: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True iff the timeout fired before the process exited. */
  timedOut: boolean;
}

/**
 * Run the verify command. Blocking until exit, timeout, or stream end.
 */
export async function runVerifyStreaming(params: VerifyParams): Promise<VerifyResult> {
  const { container, verifyCommand, timeoutSeconds, executeStream } = params;
  const start = Date.now();

  const handle = await container.exec(["bash", "-lc", verifyCommand]);

  // One decoder per stream — TextDecoder carries streaming state for
  // multi-byte UTF-8 sequences split across chunk boundaries. Sharing one
  // decoder across stdout + stderr could splice a half-character from
  // stream A onto a chunk from stream B, corrupting the captured text.
  const stdoutDecoder = new TextDecoder("utf8");
  const stderrDecoder = new TextDecoder("utf8");
  let captured = "";
  let truncated = false;

  function record(text: string): void {
    if (truncated) return;
    const remaining = OUTPUT_CAP_BYTES - captured.length;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (text.length <= remaining) {
      captured += text;
    } else {
      captured += text.slice(0, remaining);
      truncated = true;
    }
  }

  // Pipe both streams in parallel: capture into the buffer + forward to the
  // executeStream's appendText so the operator sees `pnpm test` output live.
  const stdoutDone = pumpStream(handle.stdout, async (chunk: Buffer) => {
    const text = stdoutDecoder.decode(chunk, { stream: true });
    record(text);
    if (executeStream) {
      await executeStream.appendText(text).catch(() => {});
    }
  });
  const stderrDone = pumpStream(handle.stderr, async (chunk: Buffer) => {
    const text = stderrDecoder.decode(chunk, { stream: true });
    record(text);
    if (executeStream) {
      await executeStream.appendText(text).catch(() => {});
    }
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ kind: "timeout" }),
      Math.max(1, timeoutSeconds * 1000),
    );
  });

  const waitPromise = handle.wait().then((r) => ({ kind: "exit" as const, exitCode: r.exitCode }));

  const winner = await Promise.race([waitPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  // Drain whatever the streams already buffered. We don't wait for `wait()`
  // on the timeout branch — the process is still running but the orchestrator
  // will tear the container down via `stopTask`, which cascades the kill.
  await Promise.race([
    Promise.all([stdoutDone, stderrDone]),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);

  const durationMs = Date.now() - start;
  if (winner.kind === "timeout") {
    if (truncated || captured.length > 0) {
      // mark truncated output explicitly when present; otherwise leave it
      // empty so the operator-facing message reads cleanly.
    }
    const note = `\n\n[verify timed out after ${timeoutSeconds}s]`;
    const output = appendNote(captured, note, truncated);
    return { ok: false, exitCode: TIMEOUT_EXIT_CODE, output, durationMs, timedOut: true };
  }

  const exitCode = winner.exitCode;
  return {
    ok: exitCode === 0,
    exitCode,
    output: truncated ? `${captured}\n\n[output truncated at ${OUTPUT_CAP_BYTES} bytes]` : captured,
    durationMs,
    timedOut: false,
  };
}

function appendNote(captured: string, note: string, truncated: boolean): string {
  if (truncated) {
    return `${captured}\n\n[output truncated at ${OUTPUT_CAP_BYTES} bytes]${note}`;
  }
  return `${captured}${note}`;
}

async function pumpStream(
  stream: NodeJS.ReadableStream,
  onChunk: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    await onChunk(buf);
  }
}
