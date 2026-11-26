import { mkdir } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { type Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import { planContainerCreate } from "./child-plan.js";
import { childWrites } from "./child-writes.js";
import { forwardCreate } from "./create-forward.js";
import {
  cachedOnSuccess,
  daemonLookups,
  fetchHostPlatform,
  fetchRootless,
  refLookups,
} from "./daemon-lookups.js";
import { forward, pipeUpgrade, respondInternalError, type Upstream } from "./forward.js";
import {
  isAbortError,
  pathOf,
  readBody,
  readUpgradeBody,
  respondJson,
  respondRejection,
  writeRawRejectionAndDestroy,
  writeRawStatusAndDestroy,
} from "./http-io.js";
import {
  planRequest,
  planStream,
  type RequestContext,
  type StreamContext,
  streamForward,
} from "./plan.js";
import { malformed, type ProxyRejection, unavailable } from "./rejection.js";
import { classify } from "./router.js";
import { type NotServing, type TaskSocket, TaskSockets } from "./task-sockets.js";
import type {
  ChildContainers,
  ContainerRows,
  HostPlatform,
  LookupFailure,
  ProxyOptions,
  TaskAnchor,
  TaskScope,
} from "./types.js";

export type { NotServing } from "./task-sockets.js";
export type {
  ChildContainers,
  ChildExitCause,
  ChildRecord,
  ChildRecordFailed,
  ChildStartOutcome,
  ContainerRows,
  ProxyOptions,
  StoreFailed,
  TaskContainerRow,
  TaskScope,
} from "./types.js";

const log = logger.child({ component: "sandbox.proxy" });

const DEFAULT_HOST_DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * Hard cap on a body the proxy buffers: a container create, an exec create
 * or a network connect or disconnect, which it rebuilds, and an upgrade's,
 * which it forwards with the preamble. Docker's daemon doesn't enforce a
 * small limit either, but without this cap a hostile caller could ask the
 * proxy to allocate gigabytes. 1 MiB is far above any real container spec —
 * published images don't exceed a few KB of JSON.
 */
const MAX_BUFFERED_BODY_BYTES = 1 * 1024 * 1024;

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
const MAX_HEADERS = 100;

/**
 * Per-connection tag — set as a task socket accepts the connection: the
 * socket, whose state its handlers read on each request. An `anchorTask`
 * mid-flight (once the supervisor has the task container's row) takes
 * effect without re-binding the socket, and once the socket's
 * teardown has begun its connections stay `unavailable`, even when the
 * task registers again on a new socket.
 */
interface ConnectionTask {
  task: TaskSocket;
  /**
   * The responses the HTTP server holds open on this connection. A parser
   * error after a request that is still being answered cannot be answered
   * itself without overtaking that answer.
   */
  openResponses: Set<http.ServerResponse>;
}

const CONNECTION_TASK = new WeakMap<net.Socket, ConnectionTask>();

/**
 * Unix-socket Docker daemon proxy. Listens on multiple per-task socket
 * paths simultaneously; each task gets its own private socket so the socket
 * path itself is the identity. Each request is classified against the
 * route table, checked (ownership of the container or exec it names, or a
 * body policy) and forwarded to the host `/var/run/docker.sock` under the
 * canonical path it was classified by; an upgrade on a stream endpoint
 * gets raw bidirectional piping once its checks pass. The supervisor allocates a
 * task's socket on `create` and binds it into the task container at
 * `/var/run/docker.sock`.
 *
 * Single Node `http.Server` handles all parsed HTTP traffic; a tiny
 * `net.Server` per task socket tags each accepted connection with its
 * `TaskScope` and hands it to the shared HTTP server via `connection`.
 */
export class CogmoSocketProxy {
  #hostDockerSocket: string;
  /** Shared HTTP server that processes parsed requests from any task socket. */
  #httpServer: http.Server;
  /** The per-task sockets, whose lifecycle `task-sockets.ts` owns. */
  #sockets: TaskSockets;
  /**
   * The daemon's Os/Arch, read once it is first needed: the host's platform
   * cannot change while this process runs. A failed read is retried by the
   * next create that names a platform.
   */
  #hostPlatform: (signal: AbortSignal) => Promise<Result<HostPlatform, LookupFailure>>;
  /**
   * Whether the daemon runs rootless, read once a create first publishes a
   * port: the daemon behind a socket path keeps its mode, since a rootless
   * one listens on its own user's socket. A failed read is retried.
   */
  #rootless: (signal: AbortSignal) => Promise<Result<boolean, LookupFailure>>;
  #containerRows: ContainerRows;
  #children: ChildContainers;

  private constructor(opts: ProxyOptions) {
    this.#hostDockerSocket = opts.hostDockerSocket ?? DEFAULT_HOST_DOCKER_SOCKET;
    this.#sockets = new TaskSockets({
      socketDir: opts.socketDir,
      onConnection: (socket, task) => {
        CONNECTION_TASK.set(socket, { task, openResponses: new Set() });
        this.#httpServer.emit("connection", socket);
      },
    });
    this.#containerRows = opts.containerRows;
    this.#children = opts.childContainers;
    const socketPath = this.#hostDockerSocket;
    this.#hostPlatform = cachedOnSuccess((signal) => fetchHostPlatform(socketPath, signal));
    this.#rootless = cachedOnSuccess((signal) => fetchRootless(socketPath, signal));
    this.#httpServer = http.createServer();
    this.#httpServer.maxHeadersCount = MAX_HEADERS;
    this.#httpServer.on("request", (req, res) => this.#handleRequest(req, res));
    // The upgrade's socket is the connection itself, or, while its body is
    // still arriving, Node's wrapper around it that holds back the bytes
    // after the body.
    this.#httpServer.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));
    this.#httpServer.on("clientError", (err, socket) => {
      // Node's parser fails a request past `maxHeadersCount` headers, or
      // past 16 KiB of them, before there is a request to classify; it is
      // logged as a refused request is, and answered 431 as Node's own
      // handler would, unless an earlier request on the connection is still
      // being answered, when the connection is closed instead.
      if ("code" in err && err.code === "HPE_HEADER_OVERFLOW") {
        const rejection: ProxyRejection = { kind: "headers_too_large", limit: MAX_HEADERS };
        const connection = socket instanceof net.Socket ? CONNECTION_TASK.get(socket) : undefined;
        log.info({ taskId: connection?.task.taskId, rejection }, "proxy request rejected");
        if (connection !== undefined && connection.openResponses.size > 0) {
          socket.destroy();
          return;
        }
        writeRawRejectionAndDestroy(socket, rejection);
        return;
      }
      if (!isAbortError(err)) log.warn({ err: err.message }, "proxy http clientError");
      socket.destroy();
    });
  }

  static async create(opts: ProxyOptions): Promise<CogmoSocketProxy> {
    await mkdir(opts.socketDir, { recursive: true, mode: 0o700 });
    return new CogmoSocketProxy(opts);
  }

  /**
   * Upsert a task scope, returning the socket path the supervisor mounts
   * into the task container at `/var/run/docker.sock`. A task with no live
   * registration gets a socket of its own, bound before this resolves; an
   * upsert of a live one replaces its scope, without disrupting connections
   * in flight, and keeps its path, and its anchor unless `scope` names one.
   * Rejects if the socket can't be bound,
   * and when `unregisterTask` or `close` runs before the bind completes.
   */
  registerTask(scope: TaskScope): Promise<string> {
    return this.#sockets.register(scope);
  }

  /**
   * Set the anchor of the registration `registerTask` answered `socketPath`
   * for, once the supervisor has the task container's row, keeping that
   * path. `not_serving` when the registration was torn down meanwhile, even
   * if the task has registered again since: no socket is opened, since
   * nothing would mount or unregister it.
   */
  anchorTask(taskId: string, socketPath: string, anchor: TaskAnchor): Result<void, NotServing> {
    return this.#sockets.anchor(taskId, socketPath, anchor);
  }

  /**
   * Close and remove a task's socket, ending every connection made through
   * it, in the teardown order of design/sandbox.md → Proxy Design → Teardown
   * order: the creates admitted on it have settled, or 30 seconds have
   * passed, before this resolves and the cascade after it lists the task's
   * rows. A call for a task already being torn down, by an earlier call or
   * by `close`, joins that teardown. Idempotent.
   */
  unregisterTask(taskId: string): Promise<void> {
    return this.#sockets.unregister(taskId);
  }

  /**
   * Release the registration `registerTask` answered `socketPath` for, as
   * `unregisterTask` would, if it still serves the task; a registration
   * torn down already, or replaced by a newer one, is left as it is. A
   * failed `create` releases this way, so it never tears down a newer
   * create's socket.
   */
  releaseTask(taskId: string, socketPath: string): Promise<void> {
    return this.#sockets.release(taskId, socketPath);
  }

  /**
   * Tear down every task socket at once, aborting every create in flight
   * with no wait for it, and then the shared HTTP server.
   */
  async close(): Promise<void> {
    await this.#sockets.closeAll();
    await new Promise<void>((resolve) => this.#httpServer.close(() => resolve()));
  }

  // ── HTTP request dispatch ────────────────────────────────────────────────

  #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const connection = CONNECTION_TASK.get(req.socket);
    if (connection === undefined) {
      // No task tag — the connection didn't come through a task socket.
      respondJson(res, 500, { message: "Cogmo proxy: connection has no task scope" });
      return;
    }
    connection.openResponses.add(res);
    res.once("close", () => connection.openResponses.delete(res));
    match(connection.task.state)
      .with({ kind: "serving" }, ({ scope }) => this.#handleServed(req, res, connection, scope))
      // The socket is being torn down; nothing is forwarded from here on.
      .with({ kind: "retiring" }, () =>
        this.#reject(req, res, connection.task.taskId, unavailable("the task is being torn down")),
      )
      .exhaustive();
  }

  #handleServed(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    connection: ConnectionTask,
    scope: TaskScope,
  ): void {
    if (atHeaderLimit(req)) {
      this.#reject(req, res, scope.taskId, { kind: "headers_too_large", limit: MAX_HEADERS });
      return;
    }
    const classified = classify(req.method ?? "GET", req.url ?? "/");
    log.debug(
      { taskId: scope.taskId, method: req.method, path: pathOf(req), route: classified.kind },
      "proxy request",
    );
    const upstream = this.#upstream(connection);
    match(classified)
      .with({ kind: "reject" }, ({ rejection }) => this.#reject(req, res, scope.taskId, rejection))
      .with({ kind: "request" }, ({ route, query }) =>
        this.#serve(req, res, scope, upstream.signal, async () =>
          (await planRequest(route, query, this.#requestContext(req, scope, connection))).map(
            (plan) => () => forward(req, res, upstream, plan),
          ),
        ),
      )
      .with({ kind: "stream" }, ({ route, query }) =>
        this.#serve(req, res, scope, upstream.signal, async () =>
          (await planStream(route, query, this.#streamContext(connection, scope))).map(
            (path) => () => forward(req, res, upstream, streamForward(path)),
          ),
        ),
      )
      .with({ kind: "create" }, ({ versionPrefix, query }) => {
        // Admitted once its checks pass, and bound from there to neither the
        // client nor the task's connections: teardown waits for it, then
        // aborts it with `creates.signal`.
        const creating: Upstream = {
          socketPath: this.#hostDockerSocket,
          signal: connection.task.creates.signal,
        };
        this.#serve(req, res, scope, upstream.signal, async () =>
          (
            await planContainerCreate(
              versionPrefix,
              query,
              this.#requestContext(req, scope, connection),
            )
          ).map((plan) => () => plan.admission.run(() => forwardCreate(req, res, creating, plan))),
        );
      })
      .exhaustive();
  }

  /**
   * Run a request's checks, then its forward; a rejection is answered here.
   * A throw, from the checks or the forward, is a bug, logged and answered
   * 500.
   */
  #serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scope: TaskScope,
    signal: AbortSignal,
    plan: () => Promise<Result<() => void | Promise<void>, ProxyRejection>>,
  ): void {
    plan()
      .then((planned) =>
        planned.match(
          (send) => send(),
          (rejection) => this.#reject(req, res, scope.taskId, rejection),
        ),
      )
      .catch((cause: unknown) => {
        // The task's abort can surface anywhere in the checks: teardown, not a fault.
        if (!signal.aborted) {
          log.error(
            { err: cause, taskId: scope.taskId, path: pathOf(req) },
            "proxy request failed",
          );
        }
        respondInternalError(res, `Cogmo proxy: ${describeError(cause)}`);
      });
  }

  #reject(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    taskId: string,
    rejection: ProxyRejection,
  ): void {
    log.info({ taskId, path: pathOf(req), rejection }, "proxy request rejected");
    respondRejection(res, rejection);
    // Drain the body so Node can free the parser state.
    req.resume();
  }

  /**
   * `http.IncomingMessage` upgrade event handler — fires for `Upgrade:` headers.
   * Only a stream route may be upgraded, and only once its checks pass; Node
   * hands over the bytes after the request's body as `head`, which are
   * replayed after the preamble and the body. Without the classification an
   * `Upgrade: tcp` to `/swarm/*` would slip past the route table.
   */
  #handleUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    // Nothing else listens on the socket the HTTP server hands over, or on
    // Node's wrapper around it, from here to the connection's end. The
    // task's teardown destroys it with an `AbortError`, which unheard would
    // be an uncaught exception; any error ends a connection there is no one
    // else to tell.
    clientSocket.on("error", () => clientSocket.destroy());
    const connection = CONNECTION_TASK.get(req.socket);
    if (connection === undefined) {
      writeRawStatusAndDestroy(clientSocket, 500, "Cogmo proxy: connection has no task scope");
      return;
    }
    match(connection.task.state)
      .with({ kind: "serving" }, ({ scope }) =>
        this.#handleServedUpgrade(req, clientSocket, head, connection, scope),
      )
      .with({ kind: "retiring" }, () => {
        const rejection = unavailable("the task is being torn down");
        log.info(
          { taskId: connection.task.taskId, path: pathOf(req), rejection },
          "proxy request rejected",
        );
        writeRawRejectionAndDestroy(clientSocket, rejection);
      })
      .exhaustive();
  }

  #handleServedUpgrade(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    connection: ConnectionTask,
    scope: TaskScope,
  ): void {
    // Node hands the connection over at the upgrade's headers, while an
    // earlier request's answer may still be streaming on it; any byte written
    // now would land inside that answer, so the connection is closed instead.
    if (connection.openResponses.size > 0) {
      const rejection = malformed("an upgrade cannot follow a request still being answered");
      log.info({ taskId: scope.taskId, path: pathOf(req), rejection }, "proxy request rejected");
      clientSocket.destroy();
      return;
    }
    const reject = (rejection: ProxyRejection) =>
      this.#rejectUpgrade(req, clientSocket, scope, rejection);
    if (atHeaderLimit(req)) {
      reject({ kind: "headers_too_large", limit: MAX_HEADERS });
      return;
    }
    // Node never sends `100 Continue` for an upgrade, and the body is read
    // before the daemon is dialled, so the client and the proxy would wait
    // on each other.
    if (req.headers.expect !== undefined) {
      reject({ kind: "expectation_failed" });
      return;
    }
    const upstream = this.#upstream(connection);
    match(classify(req.method ?? "GET", req.url ?? "/"))
      .with({ kind: "reject" }, ({ rejection }) => reject(rejection))
      .with({ kind: "request" }, ({ route }) =>
        reject(malformed(`${route.kind} endpoint cannot be upgraded`)),
      )
      .with({ kind: "create" }, () =>
        reject(malformed("container_create endpoint cannot be upgraded")),
      )
      .with({ kind: "stream" }, ({ route, query }) => {
        planStream(route, query, this.#streamContext(connection, scope))
          // Node parses an upgrade's body into the request, not into `head`.
          .then((planned) =>
            planned.asyncAndThen((path) =>
              new ResultAsync(readUpgradeBody(req, clientSocket, MAX_BUFFERED_BODY_BYTES)).map(
                (body) => ({
                  path,
                  body,
                }),
              ),
            ),
          )
          .then((upgrade) =>
            upgrade.match(
              ({ path, body }) => pipeUpgrade(req, clientSocket, { path, body, head }, upstream),
              reject,
            ),
          )
          .catch((cause: unknown) => {
            if (!upstream.signal.aborted) {
              log.error(
                { err: cause, taskId: scope.taskId, path: pathOf(req) },
                "proxy upgrade failed",
              );
            }
            writeRawStatusAndDestroy(clientSocket, 500, `Cogmo proxy: ${describeError(cause)}`);
          });
      })
      .exhaustive();
  }

  /** A rejected upgrade, answered on the raw socket and logged as a request's is. */
  #rejectUpgrade(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    scope: TaskScope,
    rejection: ProxyRejection,
  ): void {
    log.info({ taskId: scope.taskId, path: pathOf(req), rejection }, "proxy request rejected");
    writeRawRejectionAndDestroy(clientSocket, rejection);
  }

  #upstream(connection: ConnectionTask): Upstream {
    return { socketPath: this.#hostDockerSocket, signal: connection.task.signal };
  }

  #streamContext(connection: ConnectionTask, scope: TaskScope): StreamContext {
    const { taskId } = connection.task;
    return {
      taskRows: () =>
        this.#containerRows.forTask(taskId).mapErr(({ cause }): ProxyRejection => {
          log.warn({ err: cause, taskId }, "proxy ownership read failed");
          return unavailable("the ownership read failed");
        }),
      anchor: scope.anchor,
      refs: refLookups(this.#upstream(connection)),
      execIds: connection.task.execIds,
    };
  }

  #requestContext(
    req: http.IncomingMessage,
    scope: TaskScope,
    connection: ConnectionTask,
  ): RequestContext {
    return {
      ...this.#streamContext(connection, scope),
      scope,
      createLookups: daemonLookups({
        socketPath: this.#hostDockerSocket,
        signal: connection.task.signal,
        hostPlatform: this.#hostPlatform,
        rootless: this.#rootless,
      }),
      readBody: () => readBody(req, MAX_BUFFERED_BODY_BYTES),
      recordExec: (execId) => connection.task.execIds.add(execId),
      // Admitted on this socket; counted across every socket of the task.
      creates: {
        admit: () => connection.task.creates.admit(),
        admitting: () => connection.task.creates.admitting(),
        admittedBeyond: (counted) => this.#sockets.admittedBeyond(scope.taskId, counted),
      },
      ...childWrites(this.#children, scope.taskId, connection.task.signal),
    };
  }
}

/** Whether the request carries as many headers as the server collects (`MAX_HEADERS`). */
function atHeaderLimit(req: http.IncomingMessage): boolean {
  return req.rawHeaders.length / 2 >= MAX_HEADERS;
}
