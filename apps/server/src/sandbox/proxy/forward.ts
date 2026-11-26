/**
 * Sending a checked request to the daemon and relaying its answer
 * (design/sandbox.md → Proxy Design → The forwarded request). Every path
 * here is one the proxy built from the route it classified, never the
 * request's own target.
 *
 * A normal forward goes through `http.request` without the hop-by-hop
 * headers, and its response streams back: whole, filtered to the task's
 * objects, read for the exec id it creates, or held until a child's row
 * has followed it. Every request but an
 * upgrade is a normal forward, so the client connection stays under Node's
 * parser and a request pipelined after one is classified on its own. An
 * upgrade is raw-piped: its request line, headers and body are sent under
 * the canonical path with `Connection: Upgrade, close`, then both sockets
 * are piped.
 */

import * as http from "node:http";
import * as net from "node:net";
import { type Duplex, PassThrough, pipeline, type Transform } from "node:stream";
import { ok, type Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import {
  buildUpgradePreamble,
  emptyBodyRequestHeaders,
  isAbortError,
  jsonRequestHeaders,
  pathOf,
  pipedRequestHeaders,
  readBody,
  rebuiltResponseHeaders,
  relayedResponseHeaders,
  respondJson,
  respondRejection,
  writeRawRejectionAndDestroy,
} from "./http-io.js";
import { daemonFailed, type ProxyRejection } from "./rejection.js";
import { createdId, filterContainerList, taskEventFilter } from "./response-filters.js";

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
  /** The client's body as it came, a JSON body the proxy rebuilt, or none at all. */
  body: { kind: "piped" } | { kind: "json"; bytes: Buffer } | { kind: "none" };
  response: ResponseRelay;
}

export type ResponseRelay =
  | { kind: "piped" }
  /** Keep only the containers whose ids the task owns. */
  | { kind: "container_list"; owned: ReadonlySet<string> }
  /** Keep only the event lines of the task's own container and its children. */
  | { kind: "events"; taskContainerId: string }
  /** Record the `Id` of a 201, the exec the task may then start. */
  | { kind: "exec_created"; record: (execId: string) => void }
  /**
   * Follow the daemon's `status` in the child's row as soon as its status
   * line arrives, whether or not the body then does, and answer once the
   * row has followed it; a rejection replaces the daemon's answer.
   */
  | { kind: "child_transition"; settle: (status: number) => Promise<Result<void, ProxyRejection>> };

export function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream,
  plan: Forward,
): void {
  // A client that is gone before the request is sent gets none sent.
  if (res.destroyed || req.socket.destroyed) return;
  const headers = match(plan.body)
    .with({ kind: "piped" }, () => pipedRequestHeaders(req))
    .with({ kind: "json" }, ({ bytes }) => jsonRequestHeaders(req, bytes))
    .with({ kind: "none" }, () => emptyBodyRequestHeaders(req))
    .exhaustive();
  // Once the daemon has answered, the relay of its reply answers the client.
  let replied = false;
  const outgoing = http.request(
    {
      socketPath: upstream.socketPath,
      method: req.method,
      path: plan.path,
      headers,
      signal: upstream.signal,
    },
    (reply) => {
      replied = true;
      relay(req, reply, res, plan.response);
    },
  );
  // The proxy's own close of the daemon request, for a client that hung up:
  // not an upstream failure, and there is no one left to answer.
  const hungUp = new Error("the client hung up");
  outgoing.on("error", (cause) => {
    if (cause === hungUp) return;
    if (!isAbortError(cause)) log.warn({ err: cause.message, path: pathOf(req) }, "upstream error");
    // Once the daemon has answered, the relay owns the client's answer: a
    // failure mid-reply fails the read of a body read whole, which the relay
    // answers `daemon_failed`.
    if (replied) return;
    respondDaemonFailed(res, cause);
  });
  // A client that hangs up before its answer is complete, even before the
  // daemon has answered at all (a `wait`), closes the daemon request with
  // it; a child's start, restart or removal goes on, since its row follows the answer.
  if (boundToClient(plan.response)) {
    res.once("close", () => {
      if (!res.writableFinished) outgoing.destroy(hungUp);
    });
  }
  match(plan.body)
    .with({ kind: "piped" }, () => req.pipe(outgoing))
    .with({ kind: "json" }, ({ bytes }) => outgoing.end(bytes))
    .with({ kind: "none" }, () => {
      // The client's body, if it sent one, goes nowhere.
      req.resume();
      outgoing.end();
    })
    .exhaustive();
}

/**
 * An upgraded stream route: send the preamble under `path` with the
 * request's `body`, replay `head`, the bytes the client sent after the
 * request, then pipe.
 */
export function pipeUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  upgrade: { path: string; body: Buffer; head: Buffer },
  upstream: Upstream,
): void {
  const { path, body, head } = upgrade;
  // The checks are async: a connection the task's teardown destroyed
  // meanwhile gets no daemon connection. One the client has only ended is
  // forwarded, since a half-open client can still read the answer.
  if (clientSocket.destroyed) return;
  const daemon = net.createConnection({ path: upstream.socketPath, signal: upstream.signal });
  const warn = (cause: Error) => {
    if (!isAbortError(cause)) {
      log.warn({ err: cause.message, path: pathOf(req) }, "upstream stream error");
    }
  };
  // Until the daemon's first byte nothing has reached the client, which gets
  // a 502 for a failed dial, a reset or a clean close; after it, a failure
  // just ends the stream.
  const answered = () => daemon.bytesRead > 0;
  daemon.on("error", (cause) => {
    warn(cause);
    if (answered()) {
      clientSocket.destroy(cause);
      return;
    }
    writeRawRejectionAndDestroy(
      clientSocket,
      daemonFailed(`Cogmo proxy upstream error: ${cause.message}`),
    );
  });
  // The daemon connection's end ends the client's and releases it once the
  // rest of the output is flushed, whether or not the client has ended its
  // side.
  daemon.once("end", () => {
    // Nothing the client sends from here has anywhere to go.
    clientSocket.unpipe(daemon);
    if (answered()) {
      clientSocket.end(() => clientSocket.destroy());
      return;
    }
    log.warn({ path: pathOf(req) }, "upstream closed before answering an upgrade");
    writeRawRejectionAndDestroy(
      clientSocket,
      daemonFailed("Cogmo proxy: the daemon closed the connection before answering"),
    );
  });
  daemon.once("connect", () => {
    daemon.write(buildUpgradePreamble(req, path, body));
    if (head.length > 0) daemon.write(head);
    // `pipe` carries the client's end to the daemon, and the client's
    // connection stays open after it: a client that ends its side after
    // sending stdin still reads the daemon's output.
    clientSocket.pipe(daemon);
    daemon.pipe(clientSocket, { end: false });
  });
  clientSocket.on("error", () => daemon.destroy());
}

function relay(
  req: http.IncomingMessage,
  reply: http.IncomingMessage,
  res: http.ServerResponse,
  how: ResponseRelay,
): void {
  // A client that is gone gets nothing, but a child's row still follows the answer.
  if (res.destroyed && boundToClient(how)) {
    reply.resume();
    return;
  }
  const status = reply.statusCode ?? 502;
  match(how)
    // A streamed answer's headers go out at once, not with its first body
    // byte: `docker run` blocks on a `wait`'s headers before it starts the
    // container, and a quiet event stream sends no body for a long time.
    .with({ kind: "piped" }, () => {
      res.writeHead(status, relayedResponseHeaders(reply.headers));
      res.flushHeaders();
      relayStream(req, reply, res, new PassThrough());
    })
    .with({ kind: "events" }, ({ taskContainerId }) => {
      if (status !== 200) {
        res.writeHead(status, relayedResponseHeaders(reply.headers));
        res.flushHeaders();
        relayStream(req, reply, res, new PassThrough());
        return;
      }
      res.writeHead(status, rebuiltResponseHeaders(reply.headers, null));
      res.flushHeaders();
      relayStream(req, reply, res, taskEventFilter(taskContainerId));
    })
    .with({ kind: "container_list" }, ({ owned }) =>
      relayBuffered(reply, res, (read) =>
        read.andThen((body) => (status === 200 ? filterContainerList(body, owned) : ok(body))),
      ),
    )
    .with({ kind: "exec_created" }, ({ record }) =>
      relayBuffered(reply, res, (read) =>
        read.map((body) => {
          const created = status === 201 ? createdId(body) : null;
          if (created !== null) record(created);
          return body;
        }),
      ),
    )
    .with({ kind: "child_transition" }, ({ settle }) =>
      // The row follows the status line, before the body is read, so a
      // reply cut off after it still moves the row.
      relayBuffered(reply, res, (read) => new ResultAsync(settle(status)).andThen(() => read)),
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

/**
 * Read the whole reply, and answer with what `answer` makes of the read:
 * the body to send, or the rejection that replaces it.
 */
function relayBuffered(
  reply: http.IncomingMessage,
  res: http.ServerResponse,
  answer: (read: ResultAsync<Buffer, ProxyRejection>) => ResultAsync<Buffer, ProxyRejection>,
): void {
  const read = new ResultAsync(readBody(reply, MAX_BUFFERED_REPLY_BYTES)).mapErr((failure) =>
    match(failure)
      .with({ kind: "too_large" }, ({ maxBytes }) =>
        daemonFailed(`Cogmo proxy: the daemon's reply exceeds ${maxBytes} bytes`),
      )
      .with({ kind: "malformed" }, () =>
        daemonFailed("Cogmo proxy: the daemon's reply ended early"),
      )
      .exhaustive(),
  );
  const relayed = answer(read).match(
    (body) => {
      // A client that hung up while a child's row was written gets nothing.
      if (res.destroyed) return;
      res.writeHead(reply.statusCode ?? 502, rebuiltResponseHeaders(reply.headers, body.length));
      res.end(body);
    },
    (rejection) => {
      if (res.destroyed) return;
      respondRejection(res, rejection);
    },
  );
  relayed.catch((cause: unknown) => {
    const aborted = cause instanceof Error && isAbortError(cause);
    if (!aborted) log.error({ err: cause }, "relaying a buffered daemon reply failed");
    res.destroy();
  });
}

/** Whether a forward ends with its client: all but a child's start, restart or removal. */
function boundToClient(how: ResponseRelay): boolean {
  return match(how)
    .with({ kind: "piped" }, { kind: "container_list" }, { kind: "events" }, () => true)
    .with({ kind: "exec_created" }, () => true)
    .with({ kind: "child_transition" }, () => false)
    .exhaustive();
}

/** A forward whose daemon connection failed before the daemon answered: `daemon_failed`. */
function respondDaemonFailed(res: http.ServerResponse, cause: Error): void {
  if (res.destroyed) return;
  respondRejection(res, daemonFailed(`Cogmo proxy upstream error: ${cause.message}`));
}

/** A request whose checks threw: a bug, answered 500 if nothing was sent yet. */
export function respondInternalError(res: http.ServerResponse, message: string): void {
  if (!res.headersSent) respondJson(res, 500, { message });
}
