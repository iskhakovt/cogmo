import type { Readable, Writable } from "node:stream";
import type { RpcTransport } from "../dispatcher.js";

/**
 * Maximum unframed buffer size before the transport gives up. Real protocol
 * messages are small (tens of KB at most — `task_invoke.inputs` is bounded
 * by tool-call arg sizes, `task_result.output` by skill output schemas).
 * 4 MB is the safety hatch for a misbehaving worker that floods stdout
 * without newlines (e.g. a stray `print()` of a giant blob, or a wheel
 * leaking binary data into stdout instead of stderr) so the host doesn't
 * grow memory unbounded waiting for a `\n` that may never arrive.
 */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * NDJSON-over-streams adapter. Frames messages as one JSON object per line
 * on `stdin`, parses one JSON object per line from `stdout`. Plugs into the
 * generic `Dispatcher` used by both worker tiers.
 *
 * Tier-1 (Pyodide) uses a `MessagePort`-based transport; tier-2 (sysbox) uses
 * this one because docker exec gives us raw stdin/stdout streams.
 */
export function createNdjsonTransport(stdin: Writable, stdout: Readable): RpcTransport {
  let handler: ((message: unknown) => void) | null = null;
  let buffer = "";
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    stdin.end();
  }

  stdout.setEncoding("utf-8");
  stdout.on("data", (chunk: string) => {
    // After close(), drop any remaining stdout. The dispatcher has already
    // torn down its pending task; routing a late `task_result` /
    // `ctx_call` past it could either fire a no-op or — worse — invoke
    // the handler against a service the test/host has already cleaned up.
    if (closed) return;
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      // Surface as a synthetic structurally-valid `task_result` so the
      // dispatcher resolves with a typed error instead of hanging on the
      // pending task. Skill output schemas reject this trivially (no `id`
      // matches an outstanding invoke), but the dispatcher's own error
      // path covers it. Then close so we stop accumulating.
      handler?.({
        type: "fatal",
        error: `transport buffer exceeded ${MAX_BUFFER_BYTES} bytes without a newline — worker likely flooded stdout`,
      });
      buffer = "";
      close();
      return;
    }
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0 && handler) {
        try {
          handler(JSON.parse(line));
        } catch {
          // Malformed lines fall through — Dispatcher's WorkerMessageSchema
          // rejection log surfaces structural problems already. A non-JSON
          // line (e.g. an unexpected stderr leak crossing pipes, or a Python
          // print() outside the protocol) should not crash the host.
        }
      }
      newlineIdx = buffer.indexOf("\n");
    }
  });

  return {
    postMessage(message: unknown): void {
      if (closed) return;
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(h: (message: unknown) => void): void {
      handler = h;
    },
    close,
  };
}
