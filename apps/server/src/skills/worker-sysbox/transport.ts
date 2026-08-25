import type { Readable, Writable } from "node:stream";
import split2 from "split2";
import type { RpcTransport } from "../dispatcher.js";

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
 * by `split2`'s `maxLength` (it throws once the per-line buffer crosses
 * this; we surface that via `onError` so the dispatcher rejects the
 * pending task immediately instead of sitting on the wall-clock timer).
 */
// Sized against the host's 5 MiB `http.request` response cap, not against
// "protocol messages are small": a `ctx.http` body travels this pipe in
// both directions, and JSON escaping can inflate it well past its raw
// size. Matches the worker's own frame limit so neither direction is the
// narrower one.
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * NDJSON-over-streams adapter. Frames messages as one JSON object per line
 * on `stdin`, parses one JSON object per line from `stdout`. Plugs into the
 * generic `Dispatcher` used by both worker tiers.
 *
 * Tier-1 (Pyodide) uses a `MessagePort`-based transport; tier-2 (sysbox) uses
 * this one because docker exec gives us raw stdin/stdout streams.
 *
 * Inbound framing is delegated to `split2` (Node-TSC-maintained, ISC, zero
 * deps, the line splitter pino is built on). We hand it a raw splitter
 * (no JSON.parse mapper) so we can swallow malformed lines silently — a
 * stray `print()` from skill code shouldn't fatally crash the protocol.
 * Buffer overflow does fail the task, by design: it's the only condition
 * where a misbehaving worker can otherwise bleed memory.
 */
export function createNdjsonTransport(stdin: Writable, stdout: Readable): RpcTransport {
  let messageHandler: ((message: unknown) => void) | null = null;
  let errorHandler: ((err: Error) => void) | null = null;
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    splitter.destroy();
    stdin.end();
  }

  // split2 with no mapper emits one decoded string per line. We do JSON
  // parsing ourselves so a single bad line is a no-op rather than a
  // splitter `error` event that races teardown.
  const splitter = stdout.pipe(split2({ maxLength: MAX_BUFFER_BYTES }));
  splitter.on("data", (line: string) => {
    // After close(), drop any remaining stdout. The dispatcher has already
    // torn down its pending task; routing a late `task_result` /
    // `ctx_call` past it could either fire a no-op or — worse — invoke
    // the handler against a service the host has already cleaned up.
    if (closed || !messageHandler) return;
    if (line.length === 0) return;
    try {
      messageHandler(JSON.parse(line));
    } catch {
      // Non-JSON line (stray print(), stderr crossing pipes from a
      // misbehaving wheel, etc.) — drop silently. Schema validation in
      // Dispatcher catches structurally valid but wrong-shape payloads.
    }
  });
  splitter.on("error", (err: Error) => {
    if (closed) return;
    // Notify the dispatcher via the typed error channel so it rejects the
    // pending task immediately. Earlier rev of this code emitted a
    // synthetic `{ type: "fatal" }` frame — but `fatal` isn't a valid
    // worker protocol message, so the dispatcher's `WorkerMessageSchema`
    // dropped it and the task hung until the host wall-clock fired.
    errorHandler?.(new Error(`transport: ${err.message}`));
    close();
  });

  return {
    postMessage(message: unknown): void {
      if (closed) return;
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(h: (message: unknown) => void): void {
      messageHandler = h;
    },
    onError(h: (err: Error) => void): void {
      errorHandler = h;
    },
    close,
  };
}
