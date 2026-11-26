import { mkdir, rm } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { join } from "node:path";
import { addAbortSignal, type Duplex } from "node:stream";
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
import { type ExecIdRegistry, ExecIds } from "./exec-ids.js";
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
import { type CreateTracker, InFlightCreates } from "./in-flight-creates.js";
import {
  planRequest,
  planStream,
  type RequestContext,
  type StreamContext,
  streamForward,
} from "./plan.js";
import { malformed, type ProxyRejection, unavailable } from "./rejection.js";
import { classify } from "./router.js";
import type {
  ChildContainers,
  ContainerRows,
  HostPlatform,
  LookupFailure,
  ProxyOptions,
  TaskScope,
} from "./types.js";

export type {
  ChildContainers,
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
 * How long teardown waits for a task's container creates in flight before
 * it aborts them: long enough for the daemon to answer a create and the
 * row insert to land, so the cascade finds the child.
 */
const CREATES_SETTLE_MS = 30_000;

/**
 * Per-connection tag — set by the per-task net.Server's `connection`
 * listener: the task socket that accepted the connection. Its handlers read
 * that socket's scope on each request, so a `registerTask` update mid-flight
 * (once the supervisor has the task container's row) takes effect without
 * re-binding the socket, and once the socket's teardown has begun, its
 * connections stay `unavailable` even when the task registers again on a
 * new socket.
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
 * A registered task's socket. `controller` aborts at the end of
 * `unregisterTask`, and at once on `close`, which destroys every connection
 * accepted on the socket and every upstream connection opened for one —
 * hijacked streams included, so the listener's `close()` never waits on a
 * container. Upstream connections opened for its clients are bound to its
 * signal, but an admitted create's (`creates`).
 */
interface TaskSocket {
  taskId: string;
  socketPath: string;
  controller: AbortController;
  /** Resolves once the listener is bound; rejects if binding failed. */
  listening: Promise<net.Server>;
  /** The live scope; `null` from the first step of the socket's teardown. */
  scope: TaskScope | null;
  /**
   * The exec ids the daemon answered 201 with to an exec create sent
   * through the socket: the only ids its exec routes accept. Shared by its
   * connections and capped (`exec-ids.ts`); it lives as long as the socket,
   * and a process restart loses it with the containers.
   */
  execIds: ExecIdRegistry;
  /** The container creates admitted on the socket. */
  creates: CreateTracker;
}

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
  #socketDir: string;
  /** Shared HTTP server that processes parsed requests from any task socket. */
  #httpServer: http.Server;
  /**
   * One per task, keyed by taskId. Set before the listener binds, so an
   * `unregisterTask` or `close` racing `registerTask` finds it.
   */
  #tasks = new Map<string, TaskSocket>();
  /** Task sockets being torn down, with each teardown, which `close` aborts and awaits. */
  #retiring = new Map<TaskSocket, Promise<void>>();
  /**
   * Each task's teardown in progress, which a second `unregisterTask` for
   * the task joins, so its cascade too waits for the creates admitted.
   */
  #unregistering = new Map<string, Promise<void>>();
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
  #closed = false;

  private constructor(opts: ProxyOptions) {
    this.#hostDockerSocket = opts.hostDockerSocket ?? DEFAULT_HOST_DOCKER_SOCKET;
    this.#socketDir = opts.socketDir;
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
   * Upsert a task scope. On first call for a `taskId`: allocate the socket,
   * bind a `net.Server` to it, and return the absolute socket path the
   * supervisor mounts into the container at `/var/run/docker.sock`. On
   * subsequent calls: replace the live scope (so a supervisor that registers
   * with no anchor and updates once it has the task container's row
   * doesn't disrupt connections in flight). Returns the same path either
   * way so callers can store it once at first register.
   *
   * Rejects if the socket can't be bound, and when `unregisterTask` or
   * `close` runs before the bind completes.
   */
  async registerTask(scope: TaskScope): Promise<string> {
    if (this.#closed) throw new Error("proxy is closed");
    const { taskId } = scope;
    let task = this.#tasks.get(taskId);
    if (!task) {
      task = this.#openTaskSocket(scope);
      this.#tasks.set(taskId, task);
    }
    task.scope = scope;
    try {
      await task.listening;
    } catch (err) {
      if (this.#tasks.get(taskId) === task) this.#tasks.delete(taskId);
      throw err;
    }
    // A close or an unregister during the bind owns the task's teardown;
    // the socket is not usable.
    task.controller.signal.throwIfAborted();
    if (this.#tasks.get(taskId) !== task) throw new Error("task socket unregistered");
    return task.socketPath;
  }

  /**
   * Close and remove a task's socket, ending every connection made through
   * it, in the teardown order of design/sandbox.md → Child containers: the
   * creates admitted on it have settled, or 30 seconds have passed, before
   * this resolves and the cascade after it lists the task's rows. A call for
   * a task already being torn down joins that teardown, and resolves with
   * it. Idempotent.
   */
  unregisterTask(taskId: string): Promise<void> {
    const task = this.#tasks.get(taskId);
    const pending = this.#unregistering.get(taskId);
    if (task === undefined) return pending ?? Promise.resolve();
    this.#tasks.delete(taskId);
    const torn = this.#retire(task, CREATES_SETTLE_MS);
    const teardown =
      pending === undefined ? torn : Promise.all([pending, torn]).then(() => undefined);
    this.#unregistering.set(taskId, teardown);
    const forget = () => {
      if (this.#unregistering.get(taskId) === teardown) this.#unregistering.delete(taskId);
    };
    teardown.then(forget, forget);
    return teardown;
  }

  /**
   * Tear down all task sockets and the shared HTTP server, at once: every
   * create in flight is aborted, with no wait for it, a teardown already
   * waiting included, and each teardown has finished before this resolves.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = new Error("proxy is closed");
    const registered = [...this.#tasks.values()];
    this.#tasks.clear();
    for (const task of [...registered, ...this.#retiring.keys()]) abortTask(task, closed);
    for (const task of registered) this.#retire(task, 0);
    await Promise.all([...this.#retiring.values()]);
    await new Promise<void>((resolve) => this.#httpServer.close(() => resolve()));
  }

  /**
   * One socket's teardown: drop its scope and admit no more creates; stop
   * accepting; wait up to `settleMs` for the creates admitted; then end
   * every connection, and any create still in flight with them.
   */
  #retire(task: TaskSocket, settleMs: number): Promise<void> {
    task.scope = null;
    task.creates.stopAdmitting();
    const torn = (async () => {
      const server = await task.listening.catch(() => null);
      const listenerClosed =
        server === null
          ? Promise.resolve()
          : new Promise<void>((resolve) => server.close(() => resolve()));
      await task.creates.settled(settleMs);
      abortTask(task, new Error("task socket unregistered"));
      await listenerClosed;
      // A registration of the same task during the wait owns the path.
      if (!this.#tasks.has(task.taskId)) await rm(task.socketPath, { force: true });
    })();
    this.#retiring.set(task, torn);
    const forget = () => this.#retiring.delete(task);
    torn.then(forget, forget);
    return torn;
  }

  #openTaskSocket(scope: TaskScope): TaskSocket {
    const { taskId } = scope;
    const socketPath = join(this.#socketDir, `${taskId}.sock`);
    const controller = new AbortController();
    const { signal } = controller;
    // Half-open, as an HTTP server's own sockets are, for upgrades: a client
    // that ends its side after sending stdin (`echo hi | docker exec -i`)
    // still reads the daemon's output, and one that ends its side once its
    // upgrade request is complete still gets the answer. A connection Node's
    // HTTP server still owns, an ordinary request's or an upgrade's whose
    // body is still arriving, is ended by Node when the client ends its
    // side, and an answer still owed is dropped.
    // The listener accepts nothing before it is bound, by which time `task` is.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      // Destroys the socket at once if it was accepted after the abort.
      addAbortSignal(signal, socket);
      CONNECTION_TASK.set(socket, { task, openResponses: new Set() });
      this.#httpServer.emit("connection", socket);
    });
    server.on("error", (err) => log.warn({ err: err.message, taskId }, "task socket error"));
    const listening = (async () => {
      await rm(socketPath, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      log.info({ taskId, socketPath }, "registered task proxy socket");
      return server;
    })();
    const task: TaskSocket = {
      taskId,
      socketPath,
      controller,
      listening,
      scope,
      execIds: new ExecIds(),
      creates: new InFlightCreates(),
    };
    return task;
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
    const { scope } = connection.task;
    if (scope === null) {
      // The socket is being torn down; nothing is forwarded from here on.
      this.#reject(req, res, connection.task.taskId, unavailable("the task is being torn down"));
      return;
    }

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
    const { scope } = connection.task;
    if (scope === null) {
      const rejection = unavailable("the task is being torn down");
      log.info(
        { taskId: connection.task.taskId, path: pathOf(req), rejection },
        "proxy request rejected",
      );
      writeRawRejectionAndDestroy(clientSocket, rejection);
      return;
    }
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
    return { socketPath: this.#hostDockerSocket, signal: connection.task.controller.signal };
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
        signal: connection.task.controller.signal,
        hostPlatform: this.#hostPlatform,
        rootless: this.#rootless,
      }),
      readBody: () => readBody(req, MAX_BUFFERED_BODY_BYTES),
      recordExec: (execId) => connection.task.execIds.add(execId),
      creates: connection.task.creates,
      ...childWrites(this.#children, scope.taskId),
    };
  }
}

/** End every connection of a task, and the creates in flight on it. A second abort is a no-op. */
function abortTask(task: TaskSocket, reason: Error): void {
  task.controller.abort(reason);
  task.creates.abort(reason);
}

/** Whether the request carries as many headers as the server collects (`MAX_HEADERS`). */
function atHeaderLimit(req: http.IncomingMessage): boolean {
  return req.rawHeaders.length / 2 >= MAX_HEADERS;
}
