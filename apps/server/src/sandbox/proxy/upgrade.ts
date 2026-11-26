/**
 * An upgrade on a task socket's connection (design/sandbox.md → Proxy
 * Design → Upgraded streams). Only a stream route may be upgraded, only to
 * the protocol its route names, and only once its checks pass; the
 * forward itself is `upgrade-forward.ts`. Every refusal is answered on the
 * raw socket and logged as a refused request is. Without the
 * classification an `Upgrade: tcp` to `/swarm/*` would slip past the route
 * table.
 */

import type * as http from "node:http";
import type { Duplex } from "node:stream";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import type { Upstream } from "./forward.js";
import {
  atHeaderLimit,
  MAX_BUFFERED_BODY_BYTES,
  MAX_HEADERS,
  pathOf,
  readUpgradeBody,
  writeRawRejectionAndDestroy,
  writeRawStatusAndDestroy,
} from "./http-io.js";
import { planStream, type StreamContext } from "./plan.js";
import { denied, malformed, type ProxyRejection, unavailable } from "./rejection.js";
import { classify, type StreamRoute, type UpgradeProtocol } from "./router.js";
import type { TaskSocketState } from "./task-sockets.js";
import type { TaskScope } from "./types.js";
import { forwardUpgrade } from "./upgrade-forward.js";

const log = logger.child({ component: "sandbox.proxy" });

/** A task socket's connection, as an upgrade on it sees it. */
export interface UpgradeConnection {
  readonly taskId: string;
  /** The state of the socket the connection came in on. */
  readonly state: TaskSocketState;
  /** Whether the HTTP server holds an earlier request's answer open on the connection. */
  readonly answering: boolean;
  readonly upstream: Upstream;
  /** The ownership and exec-id lookups a stream route's checks need under `scope`. */
  streamContext(scope: TaskScope): StreamContext;
}

/**
 * The HTTP server's `upgrade` handler. `connection` is `undefined` for a
 * connection that came through no task socket.
 */
export function handleUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  connection: UpgradeConnection | undefined,
): void {
  // Nothing else listens on the socket the HTTP server hands over, or on
  // Node's wrapper around it, from here to the connection's end. The
  // task's teardown destroys it with an `AbortError`, which unheard would
  // be an uncaught exception; any error ends a connection there is no one
  // else to tell.
  clientSocket.on("error", () => clientSocket.destroy());
  if (connection === undefined) {
    writeRawStatusAndDestroy(clientSocket, 500, "Cogmo proxy: connection has no task scope");
    return;
  }
  match(connection.state)
    .with({ kind: "serving" }, ({ scope }) =>
      serveUpgrade(req, clientSocket, head, connection, scope),
    )
    .with({ kind: "retiring" }, () =>
      rejectUpgrade(
        req,
        clientSocket,
        connection.taskId,
        unavailable("the task is being torn down"),
      ),
    )
    .exhaustive();
}

function serveUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  connection: UpgradeConnection,
  scope: TaskScope,
): void {
  // Node hands the connection over at the upgrade's headers, while an
  // earlier request's answer may still be streaming on it; any byte written
  // now would land inside that answer, so the connection is closed instead.
  if (connection.answering) {
    const rejection = malformed("an upgrade cannot follow a request still being answered");
    log.info({ taskId: scope.taskId, path: pathOf(req), rejection }, "proxy request rejected");
    clientSocket.destroy();
    return;
  }
  const reject = (rejection: ProxyRejection) =>
    rejectUpgrade(req, clientSocket, scope.taskId, rejection);
  const framed = upgradeFraming(req);
  if (framed.isErr()) {
    reject(framed.error);
    return;
  }
  match(classify(req.method ?? "GET", req.url ?? "/"))
    .with({ kind: "reject" }, ({ rejection }) => reject(rejection))
    .with({ kind: "request" }, { kind: "create" }, () =>
      reject(denied("upgrading a request other than exec start or attach")),
    )
    .with({ kind: "stream" }, ({ route, upgrade, query }) =>
      namedProtocol(req, route, upgrade).match(
        () => forwardChecked(req, clientSocket, head, { route, query }, connection, scope),
        reject,
      ),
    )
    .exhaustive();
}

/**
 * The checks on how an upgrade is framed, before its route's: the header
 * count, `Expect`, which Node never answers with `100 Continue` for an
 * upgrade (the body is read before the daemon is dialled, so the client and
 * the proxy would wait on each other), and a body framed by its
 * `Content-Length`, as the Docker CLI and docker-modem frame one, rather
 * than chunked.
 */
function upgradeFraming(req: http.IncomingMessage): Result<void, ProxyRejection> {
  if (atHeaderLimit(req)) return err({ kind: "headers_too_large", limit: MAX_HEADERS });
  if (req.headers.expect !== undefined) return err({ kind: "expectation_failed" });
  if (req.headers["transfer-encoding"] !== undefined) {
    return err(malformed("an upgrade's body must be framed by its Content-Length"));
  }
  return ok(undefined);
}

/**
 * The `Upgrade` value names the one protocol the route takes, compared
 * without case as RFC 9110 asks. The daemon switches an exec start or an
 * attach to `tcp` whatever value it is sent, so this is the only check on it.
 */
function namedProtocol(
  req: http.IncomingMessage,
  route: StreamRoute,
  protocol: UpgradeProtocol,
): Result<void, ProxyRejection> {
  return (req.headers.upgrade ?? "").toLowerCase() === protocol
    ? ok(undefined)
    : err(denied(`an upgrade of ${routeName(route)} to anything but ${protocol}`));
}

function routeName(route: StreamRoute): string {
  return match(route)
    .with({ kind: "container" }, ({ target }) => target.route)
    .with({ kind: "exec" }, ({ target }) => `POST /exec/{id}${target.suffix}`)
    .exhaustive();
}

/** Run the route's checks, read the body Node parses into the request, and forward. */
function forwardChecked(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  stream: { route: StreamRoute; query: URLSearchParams },
  connection: UpgradeConnection,
  scope: TaskScope,
): void {
  const { upstream } = connection;
  planStream(stream.route, stream.query, connection.streamContext(scope))
    .then((planned) =>
      planned.asyncAndThen((path) =>
        new ResultAsync(readUpgradeBody(req, clientSocket, MAX_BUFFERED_BODY_BYTES)).map(
          (body) => ({ path, body, head }),
        ),
      ),
    )
    .then((checked) =>
      checked.match(
        (upgrade) =>
          forwardUpgrade(req, clientSocket, upgrade, upstream, (rejection) =>
            rejectUpgrade(req, clientSocket, scope.taskId, rejection),
          ),
        (rejection) => rejectUpgrade(req, clientSocket, scope.taskId, rejection),
      ),
    )
    .catch((cause: unknown) => {
      if (!upstream.signal.aborted) {
        log.error({ err: cause, taskId: scope.taskId, path: pathOf(req) }, "proxy upgrade failed");
      }
      writeRawStatusAndDestroy(clientSocket, 500, `Cogmo proxy: ${describeError(cause)}`);
    });
}

/** A refused upgrade, answered on the raw socket and logged as a request's is. */
function rejectUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  taskId: string,
  rejection: ProxyRejection,
): void {
  log.info({ taskId, path: pathOf(req), rejection }, "proxy request rejected");
  writeRawRejectionAndDestroy(clientSocket, rejection);
}
