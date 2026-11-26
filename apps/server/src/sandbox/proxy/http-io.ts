/**
 * HTTP plumbing for the socket proxy's edge: reading a bounded body,
 * answering a `ProxyRejection`, the headers of a forwarded request, and
 * replaying a request preamble.
 */

import * as http from "node:http";
import type * as net from "node:net";
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { describeError } from "../../util/describe-error.js";
import { malformed, type ProxyRejection, rejectionMessage, rejectionStatus } from "./rejection.js";

export function respondJson(res: http.ServerResponse, status: number, body: object): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
  });
  res.end(payload);
}

export function respondRejection(res: http.ServerResponse, rejection: ProxyRejection): void {
  respondJson(res, rejectionStatus(rejection), { message: rejectionMessage(rejection) });
}

/**
 * Answer a rejection on a raw client socket and close it, where no
 * `http.ServerResponse` is around (an upgrade).
 */
export function writeRawRejectionAndDestroy(socket: net.Socket, rejection: ProxyRejection): void {
  writeRawStatusAndDestroy(socket, rejectionStatus(rejection), rejectionMessage(rejection));
}

export function writeRawStatusAndDestroy(
  socket: net.Socket,
  status: number,
  message: string,
): void {
  const body = `${JSON.stringify({ message })}\n`;
  const reply =
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n` +
    `\r\n${body}`;
  socket.end(reply);
}

/**
 * Read the whole body, or stop at the first chunk past `maxBytes` with
 * `too_large`. The caller answers and drains the rest (`req.resume()`), so
 * the client connection closes cleanly rather than RST'ing. A body that
 * ends early, because the client hung up or the task's socket was torn
 * down, is `malformed`.
 */
export async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Result<Buffer, Extract<ProxyRejection, { kind: "too_large" | "malformed" }>>> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf: Buffer = chunk;
      total += buf.length;
      if (total > maxBytes) return err({ kind: "too_large", maxBytes });
      chunks.push(buf);
    }
  } catch (cause) {
    return err(malformed(`the request body ended early: ${describeError(cause)}`));
  }
  return ok(Buffer.concat(chunks));
}

/**
 * Headers that describe one connection rather than the request, which a
 * normal forward drops: Node frames the daemon connection itself.
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
]);

/**
 * The headers of a request whose body is piped to the daemon. A chunked
 * body stays chunked: Node frames a piped body by its `Content-Length`, and
 * a `GET` or `DELETE` with neither header would go out unframed, so the
 * daemon would read the body as the next request.
 */
export function pipedRequestHeaders(req: http.IncomingMessage): Record<string, string | string[]> {
  const headers = withoutHopByHop(req.headers);
  return req.headers["transfer-encoding"] === undefined
    ? headers
    : { ...headers, "transfer-encoding": "chunked" };
}

/** The headers of a request whose body the proxy rebuilt, framed by its length. */
export function rebuiltRequestHeaders(
  req: http.IncomingMessage,
  body: Buffer,
): Record<string, string | string[]> {
  const headers = R.omit(withoutHopByHop(req.headers), ["content-length", "expect"]);
  return { ...headers, "content-length": String(body.length) };
}

/**
 * A daemon response's headers, relayed to the client without the hop-by-hop
 * ones: the daemon's `Connection: keep-alive` describes the proxy's
 * connection to it, and would keep a client connection open that asked to
 * close.
 */
export function relayedResponseHeaders(
  upstream: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  return withoutHopByHop(upstream);
}

/**
 * A daemon response's headers for a body the proxy re-serialised: framed by
 * its length, or by Node when `length` is `null`.
 */
export function rebuiltResponseHeaders(
  upstream: http.IncomingHttpHeaders,
  length: number | null,
): Record<string, string | string[]> {
  const headers = R.omit(withoutHopByHop(upstream), ["content-length"]);
  return length === null ? headers : { ...headers, "content-length": String(length) };
}

function withoutHopByHop(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  return R.omitBy(cloneHeaders(h), (_value, name) => HOP_BY_HOP_HEADERS.has(name));
}

/**
 * An HTTP/1.1 request preamble (request line, headers, empty line) under
 * `path`, for a request the proxy replays at the byte level: one it
 * raw-pipes, upgraded or not.
 */
export function buildHttpRequestPreamble(req: http.IncomingMessage, path: string): Buffer {
  const headers = Object.entries(cloneHeaders(req.headers)).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`),
  );
  const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`, ...headers, "", ""];
  return Buffer.from(lines.join("\r\n"), "utf8");
}

/**
 * The request's path without its query, for logs: docker-modem copies a
 * create's body, `Env` values included, into the query string.
 */
export function pathOf(req: http.IncomingMessage): string {
  return (req.url ?? "/").split("?", 1)[0] ?? "/";
}

export function cloneHeaders(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(h).filter((e): e is [string, string | string[]] => e[1] !== undefined),
  );
}

/** An abort from the task's signal: an expected teardown, not a fault to log. */
export function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}
