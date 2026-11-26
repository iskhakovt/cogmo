import { mkdir, rm } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { join } from "node:path";
import { addAbortSignal } from "node:stream";
import type { Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
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
import type {
  ContainerRows,
  HostPlatform,
  LookupFailure,
  ProxyOptions,
  TaskScope,
} from "./types.js";

export type {
  ContainerRows,
  ProxyOptions,
  StoreFailed,
  TaskContainerRow,
  TaskScope,
} from "./types.js";

const log = logger.child({ component: "sandbox.proxy" });

const DEFAULT_HOST_DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * Hard cap on a buffered create or exec body. Docker's daemon doesn't
 * enforce a small limit either, but the proxy reads the whole body before
 * forwarding (to rebuild it); without this cap a hostile caller could ask
 * it to allocate gigabytes. 1 MiB is far above any real container spec —
 * published images don't exceed a few KB of JSON.
 */
const MAX_REWRITTEN_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Per-connection task tag — set by the per-task net.Server's `connection`
 * listener. Connection handlers look up the live scope via `#scopes.get(taskId)`
 * each request, so a `registerTask` update mid-flight (e.g. once the
 * supervisor learns the parent docker id) takes effect immediately without
 * re-binding the socket. `signal` is the task's: upstream connections opened
 * for this client are bound to it.
 */
interface ConnectionTask {
  taskId: string;
  signal: AbortSignal;
  /**
   * The exec ids the daemon answered 201 with to an exec create sent
   * through the task's socket: the only ids its exec routes accept. One set
   * per task socket, shared by its connections; it lives as long as the
   * socket, and a process restart loses it with the containers.
   */
  execIds: Set<string>;
}

const CONNECTION_TASK = new WeakMap<net.Socket, ConnectionTask>();

/**
 * A registered task's socket. `controller` aborts on `unregisterTask` and
 * `close`, which destroys every connection accepted on the socket and every
 * upstream connection opened for one — hijacked streams included, so the
 * listener's `close()` never waits on a container.
 */
interface TaskSocket {
  socketPath: string;
  controller: AbortController;
  /** Resolves once the listener is bound; rejects if binding failed. */
  listening: Promise<net.Server>;
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
  /** Live task scopes — looked up per-request so `registerTask` updates take effect immediately. */
  #scopes = new Map<string, TaskScope>();
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
  #closed = false;

  private constructor(opts: ProxyOptions) {
    this.#hostDockerSocket = opts.hostDockerSocket ?? DEFAULT_HOST_DOCKER_SOCKET;
    this.#socketDir = opts.socketDir;
    this.#containerRows = opts.containerRows;
    const socketPath = this.#hostDockerSocket;
    this.#hostPlatform = cachedOnSuccess((signal) => fetchHostPlatform(socketPath, signal));
    this.#rootless = cachedOnSuccess((signal) => fetchRootless(socketPath, signal));
    this.#httpServer = http.createServer();
    this.#httpServer.on("request", (req, res) => this.#handleRequest(req, res));
    this.#httpServer.on("upgrade", (req, socket, head) => {
      // http.Server types `socket` as Duplex; for Unix-socket connections
      // it's always a net.Socket, which has the methods we need.
      this.#handleUpgrade(req, socket as net.Socket, head);
    });
    this.#httpServer.on("clientError", (err, socket) => {
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
   * with a placeholder parent docker id and updates after `createContainer`
   * doesn't disrupt connections in flight). Returns the same path either
   * way so callers can store it once at first register.
   *
   * Rejects if the socket can't be bound, and with the abort reason when
   * `unregisterTask` or `close` runs before the bind completes.
   */
  async registerTask(scope: TaskScope): Promise<string> {
    if (this.#closed) throw new Error("proxy is closed");
    const { taskId } = scope;
    this.#scopes.set(taskId, scope);

    let task = this.#tasks.get(taskId);
    if (!task) {
      task = this.#openTaskSocket(taskId);
      this.#tasks.set(taskId, task);
    }
    try {
      await task.listening;
    } catch (err) {
      if (this.#tasks.get(taskId) === task) this.#tasks.delete(taskId);
      throw err;
    }
    // An unregister or close during the bind aborted the task and owns its
    // teardown; the socket is not usable.
    task.controller.signal.throwIfAborted();
    return task.socketPath;
  }

  /**
   * Close and remove a task's socket, ending every connection made through
   * it. Idempotent.
   */
  async unregisterTask(taskId: string): Promise<void> {
    const task = this.#tasks.get(taskId);
    this.#tasks.delete(taskId);
    this.#scopes.delete(taskId);
    if (!task) return;
    task.controller.abort(new Error("task socket unregistered"));
    const server = await task.listening.catch(() => null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(task.socketPath, { force: true });
  }

  /** Tear down all task sockets and the shared HTTP server. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = new Error("proxy is closed");
    for (const task of this.#tasks.values()) task.controller.abort(closed);
    await Promise.all([...this.#tasks.keys()].map((taskId) => this.unregisterTask(taskId)));
    await new Promise<void>((resolve) => this.#httpServer.close(() => resolve()));
  }

  #openTaskSocket(taskId: string): TaskSocket {
    const socketPath = join(this.#socketDir, `${taskId}.sock`);
    const controller = new AbortController();
    const { signal } = controller;
    const execIds = new Set<string>();
    const server = net.createServer((socket) => {
      // Destroys the socket at once if it was accepted after the abort.
      addAbortSignal(signal, socket);
      CONNECTION_TASK.set(socket, { taskId, signal, execIds });
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
    return { socketPath, controller, listening };
  }

  // ── HTTP request dispatch ────────────────────────────────────────────────

  #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const connection = CONNECTION_TASK.get(req.socket);
    const scope = connection ? this.#scopes.get(connection.taskId) : undefined;
    if (!connection || !scope) {
      // No scope tag — the connection didn't come through a registered task
      // socket, or the task was unregistered between connect and request.
      respondJson(res, 500, { message: "Cogmo proxy: connection has no task scope" });
      return;
    }

    const classified = classify(req.method ?? "GET", req.url ?? "/");
    log.debug(
      { taskId: scope.taskId, method: req.method, path: pathOf(req), route: classified.kind },
      "proxy request",
    );
    const upstream = this.#upstream(connection);
    match(classified)
      .with({ kind: "reject" }, ({ rejection }) => this.#reject(req, res, scope, rejection))
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
    plan: () => Promise<Result<() => void, ProxyRejection>>,
  ): void {
    plan()
      .then((planned) =>
        planned.match(
          (send) => send(),
          (rejection) => this.#reject(req, res, scope, rejection),
        ),
      )
      .catch((cause: unknown) => {
        // The task's abort can surface anywhere in the checks: teardown, not a fault.
        if (!signal.aborted) {
          log.error({ err: cause, taskId: scope.taskId, path: pathOf(req) }, "proxy checks failed");
        }
        respondInternalError(res, `Cogmo proxy: ${describeError(cause)}`);
      });
  }

  #reject(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scope: TaskScope,
    rejection: ProxyRejection,
  ): void {
    log.info({ taskId: scope.taskId, path: pathOf(req), rejection }, "proxy request rejected");
    respondRejection(res, rejection);
    // Drain the body so Node can free the parser state.
    req.resume();
  }

  /**
   * `http.IncomingMessage` upgrade event handler — fires for `Upgrade:` headers.
   * Only a stream route may be upgraded, and only once its checks pass; Node
   * hands over the bytes the client sent after the headers as `head`, which
   * are replayed after the preamble. Without the classification an
   * `Upgrade: tcp` to `/swarm/*` would slip past the route table.
   */
  #handleUpgrade(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const connection = CONNECTION_TASK.get(req.socket);
    const scope = connection ? this.#scopes.get(connection.taskId) : undefined;
    if (!connection || !scope) {
      writeRawStatusAndDestroy(clientSocket, 500, "Cogmo proxy: connection has no task scope");
      return;
    }
    const upstream = this.#upstream(connection);
    match(classify(req.method ?? "GET", req.url ?? "/"))
      .with({ kind: "reject" }, ({ rejection }) =>
        writeRawRejectionAndDestroy(clientSocket, rejection),
      )
      .with({ kind: "request" }, ({ route }) =>
        writeRawRejectionAndDestroy(
          clientSocket,
          malformed(`${route.kind} endpoint cannot be upgraded`),
        ),
      )
      .with({ kind: "stream" }, ({ route, query }) => {
        planStream(route, query, this.#streamContext(connection, scope))
          .then((path) =>
            path.match(
              (p) => pipeUpgrade(req, clientSocket, head, upstream, p),
              (rejection) => writeRawRejectionAndDestroy(clientSocket, rejection),
            ),
          )
          .catch((cause: unknown) => {
            if (!upstream.signal.aborted) {
              log.error({ err: cause, path: pathOf(req) }, "proxy upgrade checks failed");
            }
            writeRawStatusAndDestroy(clientSocket, 500, `Cogmo proxy: ${describeError(cause)}`);
          });
      })
      .exhaustive();
  }

  #upstream(connection: ConnectionTask): Upstream {
    return { socketPath: this.#hostDockerSocket, signal: connection.signal };
  }

  #streamContext(connection: ConnectionTask, scope: TaskScope): StreamContext {
    const { taskId } = connection;
    return {
      taskRows: () =>
        this.#containerRows.forTask(taskId).mapErr(({ cause }): ProxyRejection => {
          log.warn({ err: cause, taskId }, "proxy ownership read failed");
          return unavailable("the ownership read failed");
        }),
      taskContainerRowId: scope.parentContainerRowId,
      refs: refLookups(this.#upstream(connection)),
      execIds: connection.execIds,
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
        signal: connection.signal,
        hostPlatform: this.#hostPlatform,
        rootless: this.#rootless,
      }),
      readBody: () => readBody(req, MAX_REWRITTEN_BODY_BYTES),
      recordExec: (execId) => connection.execIds.add(execId),
    };
  }
}
