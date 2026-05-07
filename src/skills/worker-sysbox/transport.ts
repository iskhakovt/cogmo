import type { Readable, Writable } from "node:stream";
import type { RpcTransport } from "../dispatcher.js";

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

  stdout.setEncoding("utf-8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
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
    close(): void {
      if (closed) return;
      closed = true;
      stdin.end();
    },
  };
}
