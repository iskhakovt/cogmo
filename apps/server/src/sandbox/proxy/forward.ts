/**
 * Sending a checked request to the daemon and relaying its answer
 * (design/sandbox.md → Proxy Design → The forwarded request). Every path
 * here is one the proxy built from the route it classified, never the
 * request's own target.
 *
 * A normal forward goes through `http.request` without the hop-by-hop
 * headers, and its response streams back: whole, filtered to the task's
 * objects, or read for the exec id it creates. Every request but an
 * upgrade is a normal forward, so the client connection stays under Node's
 * parser and a request pipelined after one is classified on its own. An
 * upgrade is raw-piped: its request line and headers are replayed under
 * the canonical path, then both sockets are piped.
 */

import * as http from "node:http";
import * as net from "node:net";
import { PassThrough, pipeline, type Transform } from "node:stream";
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
  writeRawRejectionAndDestroy,
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
  /**
   * What happens when the client is gone before the request is sent, or
   * goes before its answer is complete: `drop` sends nothing or closes the
   * daemon request, `send` sends it all the same (a container create).
   */
  whenClientGone: "drop" | "send";
}

export type ResponseRelay =
  | { kind: "piped" }
  /** Keep only the containers whose ids the task owns. */
  | { kind: "container_list"; owned: ReadonlySet<string> }
  /** Keep only the event lines of the task's own container and its children. */
  | { kind: "events"; taskContainerId: string }
  /** Record the `Id` of a 201, the exec the task may then start. */
  | { kind: "exec_created"; record: (execId: string) => void };

export function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream,
  plan: Forward,
): void {
  const gone = res.destroyed || req.socket.destroyed;
  if (gone && plan.whenClientGone === "drop") return;
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
  // A client that hangs up before its answer is complete, even before the
  // daemon has answered at all (a `wait`), closes the daemon request with it.
  match(plan.whenClientGone)
    .with("drop", () =>
      res.once("close", () => {
        if (!res.writableFinished) outgoing.destroy();
      }),
    )
    .with("send", () => undefined)
    .exhaustive();
  match(plan.body)
    .with({ kind: "piped" }, () => req.pipe(outgoing))
    .with({ kind: "rebuilt" }, ({ bytes }) => outgoing.end(bytes))
    .exhaustive();
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
  const warn = (cause: Error) => {
    if (!isAbortError(cause)) {
      log.warn({ err: cause.message, path: pathOf(req) }, "upstream stream error");
    }
  };
  // Until the daemon's first byte nothing has reached the client, which gets
  // a 502 for a failed dial or a reset; after it, the stream just ends.
  const failedUnanswered = (cause: Error) => {
    warn(cause);
    writeRawRejectionAndDestroy(
      clientSocket,
      daemonFailed(`Cogmo proxy upstream error: ${cause.message}`),
    );
  };
  daemon.once("error", failedUnanswered);
  daemon.once("connect", () => {
    daemon.write(buildHttpRequestPreamble(req, path));
    if (head.length > 0) daemon.write(head);
    // `pipe` carries a half-close each way: a client that ends its write
    // side after sending stdin lets the daemon flush.
    clientSocket.pipe(daemon);
    daemon.pipe(clientSocket);
    daemon.once("data", () => {
      daemon.removeListener("error", failedUnanswered);
      daemon.on("error", (cause) => {
        warn(cause);
        clientSocket.destroy(cause);
      });
    });
  });
  clientSocket.on("error", () => daemon.destroy());
}

function relay(
  req: http.IncomingMessage,
  reply: http.IncomingMessage,
  res: http.ServerResponse,
  how: ResponseRelay,
): void {
  // A client that is gone (a container create sent all the same) gets nothing.
  if (res.destroyed) {
    reply.resume();
    return;
  }
  const status = reply.statusCode ?? 502;
  match(how)
    .with({ kind: "piped" }, () => {
      res.writeHead(status, relayedResponseHeaders(reply.headers));
      relayStream(req, reply, res, new PassThrough());
    })
    .with({ kind: "events" }, ({ taskContainerId }) => {
      if (status !== 200) {
        res.writeHead(status, relayedResponseHeaders(reply.headers));
        relayStream(req, reply, res, new PassThrough());
        return;
      }
      res.writeHead(status, rebuiltResponseHeaders(reply.headers, null));
      relayStream(req, reply, res, taskEventFilter(taskContainerId));
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

/**
 * Stream the reply through `through` to the client. `pipeline` destroys
 * the reply, and with it the daemon connection, when the client hangs up.
 */
function relayStream(
  req: http.IncomingMessage,
  reply: http.IncomingMessage,
  res: http.ServerResponse,
  through: Transform,
): void {
  pipeline(reply, through, res, (cause) => {
    if (cause !== null && cause !== undefined && !isAbortError(cause)) {
      log.debug({ err: cause.message, path: pathOf(req) }, "relayed stream ended early");
    }
  });
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
