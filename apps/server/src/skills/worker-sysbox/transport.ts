import { on } from "node:events";
import { pipeline, type Readable, type Writable } from "node:stream";
import { Result } from "neverthrow";
import split2 from "split2";
import { describeError } from "../../util/describe-error.js";
import { parseWorkerFrame, type WorkerTransport } from "../dispatcher.js";
import type { WorkerFrame } from "../worker-state.js";

/**
 * Maximum unframed buffer size before the transport gives up. Real protocol
 * messages are small (tens of KB at most — `task_invoke.inputs` is bounded
 * by tool-call arg sizes, `task_result.output` by skill output schemas —
 * though a `ctx.http` response body travels here too, up to the host's
 * 5 MiB cap plus JSON escaping).
 * The limit is the safety hatch for a misbehaving worker that floods stdout
 * without newlines (e.g. a stray `print()` of a giant blob, or a wheel
 * leaking binary data into stdout instead of stderr) so the host doesn't
 * grow memory unbounded waiting for a `\n` that may never arrive. Enforced
 * by `split2`'s `maxLength`; crossing it fails the message stream, and with
 * it the pending task.
 */
// Sized against the host's 5 MiB `http.request` response cap, not against
// "protocol messages are small": a `ctx.http` body travels this pipe in
// both directions, and JSON escaping can inflate it well past its raw
// size. Matches the worker's own frame limit so neither direction is the
// narrower one.
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const parseJson = Result.fromThrowable(
  (line: string): unknown => JSON.parse(line),
  () => "not JSON",
);

/**
 * NDJSON-over-streams transport for the Tier 2 supervisor: one JSON object
 * per line on `stdin`, one per line from `stdout`. The message stream ends
 * when the supervisor closes its output or the host calls `close()`, and
 * fails on a stream error or a buffer overflow.
 *
 * Inbound framing is delegated to `split2` (Node-TSC-maintained, ISC, zero
 * deps, the line splitter pino is built on). A line that isn't JSON — a
 * stray `print()` from skill code, a wheel writing to the wrong stream — is
 * dropped silently. Buffer overflow fails the stream, by design: it's the
 * only condition where a misbehaving worker can otherwise bleed memory.
 */
export function createNdjsonTransport(stdin: Writable, stdout: Readable): WorkerTransport {
  const closed = new AbortController();
  const lines = split2({ maxLength: MAX_BUFFER_BYTES });
  // Unlike `pipe`, `pipeline` carries an error on `stdout` itself into
  // `lines`, where the message stream reports it; its callback has nothing
  // left to do.
  pipeline(stdout, lines, () => {});
  // Nothing read after close() reaches the host: its task and ctx services
  // may already be gone.
  closed.signal.addEventListener(
    "abort",
    () => {
      lines.destroy();
      stdin.end();
    },
    { once: true },
  );

  async function* messages(): AsyncGenerator<WorkerFrame> {
    try {
      // `on` yields every line split2 produced before failing, and only then
      // throws — a frame ahead of an overflow in the same write arrives.
      for await (const [line] of on(lines, "data", { close: ["end"], signal: closed.signal })) {
        const frame = typeof line === "string" && line.length > 0 ? toFrame(line) : undefined;
        if (frame !== undefined) yield frame;
      }
    } catch (e) {
      // The abort is the host's own close, not a failure.
      if (closed.signal.aborted) return;
      throw new Error(`transport: ${describeError(e)}`);
    }
  }

  return {
    send(message): void {
      if (closed.signal.aborted) return;
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    messages,
    close: () => closed.abort(),
  };
}

function toFrame(line: string): WorkerFrame | undefined {
  return parseJson(line).match(parseWorkerFrame, () => undefined);
}
