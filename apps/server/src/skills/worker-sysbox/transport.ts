import type { Readable, Writable } from "node:stream";
import { Result } from "neverthrow";
import split2 from "split2";
import { describeError } from "../../util/describe-error.js";
import { parseWorkerMessage, type WorkerTransport } from "../dispatcher.js";
import type { WorkerMessage } from "../protocol.js";

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
 * by `split2`'s `maxLength`; crossing it fails the message stream, so the
 * pending task fails at once instead of sitting on the wall-clock timer.
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
 * per line on `stdin`, one per line from `stdout`.
 *
 * Inbound framing is delegated to `split2` (Node-TSC-maintained, ISC, zero
 * deps, the line splitter pino is built on). A line that isn't JSON — a
 * stray `print()` from skill code, a wheel writing to the wrong stream — is
 * dropped silently. Buffer overflow fails the stream, by design: it's the
 * only condition where a misbehaving worker can otherwise bleed memory.
 */
export function createNdjsonTransport(stdin: Writable, stdout: Readable): WorkerTransport {
  const lines = stdout.pipe(split2({ maxLength: MAX_BUFFER_BYTES }));
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    lines.destroy();
    stdin.end();
  }

  async function* messages(): AsyncGenerator<WorkerMessage> {
    try {
      for await (const line of lines) {
        // Nothing read after close() reaches the host: its task and ctx
        // services may already be gone.
        if (closed) return;
        const message = typeof line === "string" && line.length > 0 ? toMessage(line) : undefined;
        if (message !== undefined) yield message;
      }
    } catch (e) {
      if (closed) return;
      close();
      throw new Error(`transport: ${describeError(e)}`);
    }
    if (closed) return;
    // The worker closed its output: the supervisor exited or was killed, so
    // nothing more can arrive — including a `task_exited`.
    close();
    throw new Error("transport: worker closed its output");
  }

  return {
    send(message): void {
      if (closed) return;
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    messages,
    close,
  };
}

function toMessage(line: string): WorkerMessage | undefined {
  return parseJson(line).match(parseWorkerMessage, () => undefined);
}
