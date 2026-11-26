/**
 * HTTP plumbing for the socket proxy's edge: the request limits, reading a
 * bounded body, answering a `ProxyRejection`, the headers of a forwarded
 * request or upgrade, and writing a raw response.
 */

import * as http from "node:http";
import type { Duplex } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { describeError } from "../../util/describe-error.js";
import { malformed, type ProxyRejection, rejectionMessage, rejectionStatus } from "./rejection.js";

/**
 * Hard cap on a body the proxy buffers: a container create, an exec create
 * or a network connect or disconnect, which it rebuilds, and an upgrade's,
 * which it forwards with the upgrade. Docker's daemon doesn't enforce a
 * small limit either, but without this cap a hostile caller could ask the
 * proxy to allocate gigabytes. 1 MiB is far above any real container spec —
 * published images don't exceed a few KB of JSON.
 */
export const MAX_BUFFERED_BODY_BYTES = 1 * 1024 * 1024;

/**
 * The headers the server takes per request; a real Docker client sends
 * about ten. Node's parser fails a request past the count
 * (`HPE_HEADER_OVERFLOW`, from `TrackHeaderPair` in `node_http_parser.cc`),
 * which `clientError` answers 431. A request with exactly the count is
 * refused 431 too (`atHeaderLimit`), before any daemon connection: Node's
 * JS side cuts a longer header list short (`parserOnHeadersComplete`), so
 * whichever side enforces the count, a forward never frames its body by a
 * header view Node cut short.
 */
export const MAX_HEADERS = 100;

/** Whether the request carries as many headers as the server collects (`MAX_HEADERS`). */
export function atHeaderLimit(req: http.IncomingMessage): boolean {
  return req.rawHeaders.length / 2 >= MAX_HEADERS;
}

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
 * `http.ServerResponse` is around (an upgrade, or a request Node's parser
 * failed).
 */
export function writeRawRejectionAndDestroy(socket: Duplex, rejection: ProxyRejection): void {
  writeRawStatusAndDestroy(socket, rejectionStatus(rejection), rejectionMessage(rejection));
}

export function writeRawStatusAndDestroy(socket: Duplex, status: number, message: string): void {
  const body = Buffer.from(`${JSON.stringify({ message })}\n`, "utf8");
  writeRawAndDestroy(
    socket,
    Buffer.concat([
      rawResponseHead(status, http.STATUS_CODES[status] ?? "", [
        "Content-Type: application/json",
        `Content-Length: ${body.length}`,
        "Connection: close",
      ]),
      body,
    ]),
  );
}

/**
 * Write a whole raw answer and close the socket. A half-open connection
 * stays open while the client keeps its side open, so the socket is
 * released once the answer is flushed.
 */
export function writeRawAndDestroy(socket: Duplex, reply: Buffer): void {
  socket.end(reply, () => socket.destroy());
}

/**
 * An HTTP/1.1 response head: the status line, `lines` (each `name: value`)
 * and the empty line. Node holds each header octet as one latin1
 * character; latin1 writes them back as they came.
 */
export function rawResponseHead(
  status: number,
  message: string,
  lines: ReadonlyArray<string>,
): Buffer {
  return Buffer.from([`HTTP/1.1 ${status} ${message}`, ...lines, "", ""].join("\r\n"), "latin1");
}

/** A header record as `name: value` lines, one per value. */
export function headerLines(headers: Readonly<Record<string, string | string[]>>): string[] {
  return Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`),
  );
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
 * An upgrade's body. Node emits the upgrade once the headers are in and
 * goes on parsing the body into the request; but when the client stops
 * sending before the body is complete, the request neither ends nor
 * errors, so the client socket's end counts as the body ending early. The
 * checks before this are async, so that end may already have happened.
 */
export async function readUpgradeBody(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  maxBytes: number,
): Promise<Result<Buffer, Extract<ProxyRejection, { kind: "too_large" | "malformed" }>>> {
  if (req.complete) return readBody(req, maxBytes);
  const { promise: endedEarly, resolve } = Promise.withResolvers<void>();
  const onEnd = () => resolve();
  clientSocket.once("end", onEnd);
  clientSocket.once("close", onEnd);
  if (clientSocket.readableEnded || clientSocket.destroyed) onEnd();
  try {
    return await Promise.race([
      readBody(req, maxBytes),
      endedEarly.then(() => err(malformed("the request body ended early"))),
    ]);
  } finally {
    clientSocket.removeListener("end", onEnd);
    clientSocket.removeListener("close", onEnd);
  }
}

/**
 * Headers that describe one connection rather than the request, which a
 * normal forward drops in both directions: Node frames the daemon
 * connection itself. Every header the `Connection` value names goes too
 * (RFC 9110 §7.6.1).
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "proxy-connection",
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
  // Node answers `Expect: 100-continue` itself before the body is piped.
  const headers = R.omit(withoutHopByHop(req.headers), ["expect"]);
  return req.headers["transfer-encoding"] === undefined
    ? headers
    : { ...headers, "transfer-encoding": "chunked" };
}

/**
 * The headers of a request whose JSON body the proxy rebuilt, framed by its
 * length. The content type is JSON whatever the client sent, so the daemon
 * never reads a route's parameters from a form body.
 */
export function jsonRequestHeaders(
  req: http.IncomingMessage,
  body: Buffer,
): Record<string, string | string[]> {
  const headers = R.omit(withoutHopByHop(req.headers), [
    "content-length",
    "content-type",
    "expect",
  ]);
  return {
    ...headers,
    "content-type": "application/json",
    "content-length": String(body.length),
  };
}

/** The headers of a request the proxy forwards with no body. */
export function emptyBodyRequestHeaders(
  req: http.IncomingMessage,
): Record<string, string | string[]> {
  const headers = R.omit(withoutHopByHop(req.headers), [
    "content-length",
    "content-type",
    "expect",
  ]);
  return { ...headers, "content-length": "0" };
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

/**
 * Headers a `Connection` token never removes. Without its `Content-Length`
 * a piped body would go out unframed, and the daemon would read it as the
 * next request; `Transfer-Encoding` is re-framed by `pipedRequestHeaders`.
 */
const FRAMING_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "transfer-encoding",
  "host",
]);

function withoutHopByHop(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const named: ReadonlySet<string> = new Set(
    (h.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "" && !FRAMING_HEADERS.has(token)),
  );
  return R.omitBy(
    cloneHeaders(h),
    (_value, name) => HOP_BY_HOP_HEADERS.has(name) || named.has(name),
  );
}

/**
 * The headers of an upgrade the proxy forwards with `body`: a normal
 * forward's, without the hop-by-hop ones or those the client's `Connection`
 * names, with `Upgrade` kept and `Connection: Upgrade, close`. Node writes
 * each value back octet for octet, as latin1.
 *
 * `close` asks the daemon to close the connection once it has answered a
 * request it does not upgrade: a detached exec start (200) or a body it
 * refuses (400); a `101` hands the connection over before `close` applies.
 * The body is the one Node parsed into the request, framed by its length,
 * and an empty one by Node: `Content-Length: 0` on a `POST`, nothing on a
 * `GET`.
 */
export function upgradeRequestHeaders(
  req: http.IncomingMessage,
  body: Buffer,
): Record<string, string | string[]> {
  const kept = R.omit(withoutHopByHop(req.headers), ["content-length"]);
  return {
    ...kept,
    ...(req.headers.upgrade !== undefined && { upgrade: req.headers.upgrade }),
    connection: "Upgrade, close",
    ...(body.length > 0 && { "content-length": String(body.length) }),
  };
}

/**
 * The request's path without its query, for logs: docker-modem copies a
 * create's body, `Env` values included, into the query string.
 */
export function pathOf(req: http.IncomingMessage): string {
  return (req.url ?? "/").split("?", 1)[0] ?? "/";
}

function cloneHeaders(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(h).filter((e): e is [string, string | string[]] => e[1] !== undefined),
  );
}

/** An abort from the task's signal: an expected teardown, not a fault to log. */
export function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}
