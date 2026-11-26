/**
 * Sending a checked request to the daemon and relaying its answer
 * (design/sandbox.md → Proxy Design → The forwarded request). Every path
 * here is one the proxy built from the route it classified, never the
 * request's own target.
 *
 * A normal forward goes through `http.request` without the hop-by-hop
 * headers, and its response streams back: whole, filtered to the task's
 * objects, or read for the exec id it creates. A stream route is
 * raw-piped: the request line and headers are replayed under the
 * canonical path, then both sockets are piped.
 */

import * as http from "node:http";
import * as net from "node:net";
import { pipeline } from "node:stream";
import { ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import {
  buildHttpRequestPreamble,
  isAbortError,
  pathOf,
  pipedRequestHeaders,
  readBody,
  rebuiltRequestHeaders,
  rebuiltResponseHeaders,
  relayedResponseHeaders,
  respondJson,
  respondRejection,
} from "./http-io.js";
import { daemonFailed, type ProxyRejection } from "./rejection.js";
import { createdExecId, filterContainerList, taskEventFilter } from "./response-filters.js";

const log = logger.child({ component: "sandbox.proxy" });

/**
 * Bound on a daemon reply the proxy reads whole: a container list, or an
 * exec create's `{"Id": …}`. A list of a few thousand containers stays well
 * under it.
 */
const MAX_BUFFERED_REPLY_BYTES = 16 * 1024 * 1024;

/** The daemon socket, and the task's signal every connection to it is bound to. */
export interface Upstream {
  socketPath: string;
  signal: AbortSignal;
}

/** A checked request: what reaches the daemon and how its answer comes back. */
export interface Forward {
  /** The canonical path with the re-serialised query. */
  path: string;
  body: { kind: "piped" } | { kind: "rebuilt"; bytes: Buffer };
  response: ResponseRelay;
}

export type ResponseRelay =
  | { kind: "piped" }
  /** Keep only the containers whose ids the task owns. */
  | { kind: "container_list"; owned: ReadonlySet<string> }
  /** Keep only the event lines labelled with the task. */
  | { kind: "events"; taskId: string }
  /** Record the `Id` of a 201, the exec the task may then start. */
  | { kind: "exec_created"; record: (execId: string) => void };

export function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream,
  plan: Forward,
): void {
  const headers = match(plan.body)
    .with({ kind: "piped" }, () => pipedRequestHeaders(req))
    .with({ kind: "rebuilt" }, ({ bytes }) => rebuiltRequestHeaders(req, bytes))
    .exhaustive();
  const outgoing = http.request(
    {
      socketPath: upstream.socketPath,
      method: req.method,
      path: plan.path,
      headers,
      signal: upstream.signal,
    },
    (reply) => relay(req, reply, res, plan.response),
  );
  outgoing.on("error", (cause) => {
    if (!isAbortError(cause)) log.warn({ err: cause.message, path: pathOf(req) }, "upstream error");
    respondDaemonFailed(res, cause);
  });
  match(plan.body)
    .with({ kind: "piped" }, () => req.pipe(outgoing))
    .with({ kind: "rebuilt" }, ({ bytes }) => outgoing.end(bytes))
    .exhaustive();
}

/**
 * A stream route that arrived as a normal request: replay its preamble
 * under `path` on a fresh daemon connection and pipe both sockets. Covers
 * exec start, attach, logs and the distribution lookup.
 */
export function pipeRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream,
  path: string,
): void {
  const clientSocket = req.socket;
  res.detachSocket(clientSocket);
  pipeUpgrade(req, clientSocket, Buffer.alloc(0), upstream, path);
}

/** An upgraded stream route: replay the preamble and `head` under `path`, then pipe. */
export function pipeUpgrade(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  upstream: Upstream,
  path: string,
): void {
  // The checks are async: a client that hung up meanwhile gets no daemon connection.
  if (clientSocket.destroyed) return;
  const daemon = net.createConnection({ path: upstream.socketPath, signal: upstream.signal });
  daemon.once("connect", () => {
    daemon.write(buildHttpRequestPreamble(req, path));
    if (head.length > 0) daemon.write(head);
    // `pipe` carries a half-close each way: a client that ends its write
    // side after sending stdin lets the daemon flush.
    clientSocket.pipe(daemon);
    daemon.pipe(clientSocket);
  });
  daemon.on("error", (cause) => {
    if (!isAbortError(cause)) {
      log.warn({ err: cause.message, path: pathOf(req) }, "upstream stream error");
    }
    clientSocket.destroy(cause);
  });
  clientSocket.on("error", () => daemon.destroy());
}

function relay(
  req: http.IncomingMessage,
  reply: http.IncomingMessage,
  res: http.ServerResponse,
  how: ResponseRelay,
): void {
  const status = reply.statusCode ?? 502;
  match(how)
    .with({ kind: "piped" }, () => {
      res.writeHead(status, relayedResponseHeaders(reply.headers));
      reply.pipe(res);
    })
    .with({ kind: "events" }, ({ taskId }) => {
      if (status !== 200) {
        res.writeHead(status, relayedResponseHeaders(reply.headers));
        reply.pipe(res);
        return;
      }
      res.writeHead(status, rebuiltResponseHeaders(reply.headers, null));
      pipeline(reply, taskEventFilter(taskId), res, (cause) => {
        if (cause !== null && cause !== undefined && !isAbortError(cause)) {
          log.debug({ err: cause.message, path: pathOf(req) }, "event stream ended");
        }
      });
    })
    .with({ kind: "container_list" }, ({ owned }) =>
      relayBuffered(reply, res, (body) =>
        status === 200 ? filterContainerList(body, owned) : ok(body),
      ),
    )
    .with({ kind: "exec_created" }, ({ record }) =>
      relayBuffered(reply, res, (body) => {
        const created = status === 201 ? createdExecId(body) : null;
        if (created !== null) record(created);
        return ok(body);
      }),
    )
    .exhaustive();
}

/** Read the whole reply, pass it through `transform`, and answer with what it returns. */
function relayBuffered(
  reply: http.IncomingMessage,
  res: http.ServerResponse,
  transform: (body: Buffer) => Result<Buffer, ProxyRejection>,
): void {
  const relayed = readBody(reply, MAX_BUFFERED_REPLY_BYTES).then((read) => {
    read
      .mapErr((failure) =>
        match(failure)
          .with({ kind: "too_large" }, ({ maxBytes }) =>
            daemonFailed(`Cogmo proxy: the daemon's reply exceeds ${maxBytes} bytes`),
          )
          .with({ kind: "malformed" }, () =>
            daemonFailed("Cogmo proxy: the daemon's reply ended early"),
          )
          .exhaustive(),
      )
      .andThen(transform)
      .match(
        (body) => {
          res.writeHead(
            reply.statusCode ?? 502,
            rebuiltResponseHeaders(reply.headers, body.length),
          );
          res.end(body);
        },
        (rejection) => respondRejection(res, rejection),
      );
  });
  relayed.catch((cause: unknown) => {
    log.error({ err: cause }, "relaying a buffered daemon reply failed");
    res.destroy();
  });
}

/** A forward whose daemon connection failed: `daemon_failed` if nothing was sent yet. */
function respondDaemonFailed(res: http.ServerResponse, cause: Error): void {
  if (res.headersSent) {
    res.destroy(cause);
    return;
  }
  respondRejection(res, daemonFailed(`Cogmo proxy upstream error: ${cause.message}`));
}

/** A request whose checks threw: a bug, answered 500 if nothing was sent yet. */
export function respondInternalError(res: http.ServerResponse, message: string): void {
  if (!res.headersSent) respondJson(res, 500, { message });
}
