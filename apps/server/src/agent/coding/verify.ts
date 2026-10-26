/**
 * Post-hoc verify runner — slice 4.0e.
 *
 * Executes `bash -lc <verify_command>` inside the task container exactly
 * once, captures the combined stdout+stderr for storage (secrets masked,
 * truncated to `OUTPUT_CAP_BYTES`), and returns the exit code + wall time.
 *
 * No retry loop. Iterating on failure was the CLI's job during execute
 * per `design/coding-delegation.md → Self-verify clause`; this step exists
 * only to confirm the CLI's "done" claim. Pass → orchestrator proceeds to
 * push + PR (4.0f / 4.0g); fail → task is marked failed with the captured
 * output as the failure reason.
 *
 * Timeout: a single wall-clock cap (`coding_repos.verify_timeout_seconds`),
 * the exec's own `timeoutMs`. When it passes the exec settles at once and
 * its teardown stops the command as far as the backend can (see
 * `ExecStreamingHandle.dispose`); the runner returns `{ ok: false,
 * exitCode: TIMEOUT_EXIT_CODE, timedOut: true }`.
 */

import {
  type ExecStreamingHandle,
  execFailureError,
  type SandboxSession,
} from "../../sandbox/index.js";
import { redactSecretsInText, truncationSafeLength } from "../../util/redact-secrets.js";

/** Cap for the captured verify output (8 KiB). */
export const OUTPUT_CAP_BYTES = 8 * 1024;

/**
 * How far the capture reads past the cap. A credential that ends within it is
 * masked whole even when the cap cuts through it, and the slack lets the kept
 * text still fill the cap after masking shortens it and `maskCapture` drops a
 * secret the capture stopped inside.
 */
const MASK_LOOKAHEAD_BYTES = 1024;

/** Synthetic exit code returned when the verify exceeds its wall-clock budget. */
export const TIMEOUT_EXIT_CODE = 124;

export interface VerifyParams {
  container: Pick<SandboxSession, "execStreaming">;
  /** `coding_repos.verify_command` — passed verbatim to `bash -lc`. */
  verifyCommand: string;
  /** `coding_repos.verify_timeout_seconds` — wall-clock cap. */
  timeoutSeconds: number;
}

export interface VerifyResult {
  /** True iff exit code was 0 within the timeout. */
  ok: boolean;
  /** `TIMEOUT_EXIT_CODE` when timed out. */
  exitCode: number;
  /** Combined stdout+stderr, secrets masked, truncated at `OUTPUT_CAP_BYTES`. */
  output: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True iff the timeout fired before the process exited. */
  timedOut: boolean;
}

/**
 * Run the verify command until it exits or times out. Any other failure
 * (the transport broke, the exec was disposed) throws, once both output
 * streams have been drained.
 */
export async function runVerifyStreaming(params: VerifyParams): Promise<VerifyResult> {
  const { container, verifyCommand, timeoutSeconds } = params;
  // Monotonic: a wall-clock step during the run cannot make the duration
  // negative, which the `coding/task/verify-complete` schema rejects.
  const start = performance.now();

  const handle = await container.execStreaming(["bash", "-lc", verifyCommand], {
    timeoutMs: Math.max(1, timeoutSeconds * 1000),
  });
  try {
    return await captureVerify(handle, { timeoutSeconds, start });
  } finally {
    await handle.dispose();
  }
}

async function captureVerify(
  handle: ExecStreamingHandle,
  opts: { timeoutSeconds: number; start: number },
): Promise<VerifyResult> {
  const { timeoutSeconds, start } = opts;

  // One decoder per stream — TextDecoder carries streaming state for
  // multi-byte UTF-8 sequences split across chunk boundaries. Sharing one
  // decoder across stdout + stderr could splice a half-character from
  // stream A onto a chunk from stream B, corrupting the captured text.
  const stdoutDecoder = new TextDecoder("utf8");
  const stderrDecoder = new TextDecoder("utf8");
  let captured = "";
  let dropped = false;

  function record(text: string): void {
    if (dropped) return;
    const remaining = OUTPUT_CAP_BYTES + MASK_LOOKAHEAD_BYTES - captured.length;
    if (text.length <= remaining) {
      captured += text;
    } else {
      captured += text.slice(0, remaining);
      dropped = true;
    }
  }

  // Capture both streams in parallel. The streams end, or fail with the
  // transport, once the exec settles; the pumps are settled either way, so
  // the tail of the output lands in the capture and a failed stream is
  // observed as soon as it fails.
  const pumped = Promise.allSettled([
    pumpStream(handle.stdout, (chunk) => record(stdoutDecoder.decode(chunk, { stream: true }))),
    pumpStream(handle.stderr, (chunk) => record(stderrDecoder.decode(chunk, { stream: true }))),
  ]);

  const exited = await handle.exited;
  await pumped;

  const durationMs = Math.round(performance.now() - start);
  const { kept, truncated } = maskCapture(captured, dropped);
  if (exited.isErr()) {
    if (exited.error.kind !== "timed_out") throw execFailureError(exited.error);
    const note = `\n\n[verify timed out after ${timeoutSeconds}s]`;
    const output = appendNote(kept, note, truncated);
    return { ok: false, exitCode: TIMEOUT_EXIT_CODE, output, durationMs, timedOut: true };
  }

  const exitCode = exited.value.exitCode;
  return {
    ok: exitCode === 0,
    exitCode,
    output: truncated ? `${kept}\n\n[output truncated at ${OUTPUT_CAP_BYTES} bytes]` : kept,
    durationMs,
    timedOut: false,
  };
}

/**
 * The capture masked, then cut to the cap. A capture that dropped output may
 * stop inside a secret, of any length, that masking can't recognise there;
 * `truncationSafeLength` drops it whole before masking.
 */
function maskCapture(captured: string, dropped: boolean): { kept: string; truncated: boolean } {
  const complete = dropped ? captured.slice(0, truncationSafeLength(captured)) : captured;
  const masked = redactSecretsInText(complete);
  return {
    kept: masked.slice(0, OUTPUT_CAP_BYTES),
    truncated: dropped || masked.length > OUTPUT_CAP_BYTES,
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
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  for await (const chunk of stream) {
    onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
}
