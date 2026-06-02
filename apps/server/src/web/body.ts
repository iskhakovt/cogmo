import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Cap on a request body the UI server reads into memory. Login + chat bodies are
 * tiny (`{ token }`, `{ text }`); the cap stops an unauthenticated or
 * lying-Content-Length request from exhausting memory with an unbounded stream.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Thrown by `readJsonBody` when the body exceeds `MAX_BODY_BYTES`. Callers reply 413. */
export class PayloadTooLargeError extends Error {}

/**
 * Read and JSON-parse a request body, bounded by `MAX_BODY_BYTES`. Rejects an
 * honestly-declared oversized body before reading a byte; the streaming cap
 * backstops chunked / lying Content-Length. Throwing unwinds the read (the
 * `for await` iterator's return() ends the request stream) so the handler can
 * reply 413 — we never call `req.destroy()`, which would tear down the socket
 * before the response flushes. A malformed body surfaces as a `SyntaxError`
 * from `JSON.parse`; callers map it to 400.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    // Node's Readable async-iterator element type is `any`; a request body in
    // binary mode always yields Buffers, so narrow cast-free.
    if (!Buffer.isBuffer(chunk)) continue;
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Reply to a `readJsonBody` failure. A 413 sets `Connection: close`: the
 * streaming-cap path throws mid-read, after consuming has begun, so the unread
 * remainder of the body stays in the socket buffer — Node only auto-drains a
 * request it never started reading, so on a keep-alive socket those bytes would
 * desync the next request. Closing the connection sidesteps that (the response
 * still flushes first). A parse failure is a plain 400.
 */
export function sendBodyError(res: ServerResponse, err: unknown): void {
  if (err instanceof PayloadTooLargeError) {
    res.writeHead(413, { "Content-Type": "text/plain", Connection: "close" });
    res.end("Payload Too Large");
    return;
  }
  res.writeHead(400, { "Content-Type": "text/plain" });
  res.end("Bad Request");
}
