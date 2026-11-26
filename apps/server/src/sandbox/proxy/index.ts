import { mkdir, rm } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { join } from "node:path";
import { addAbortSignal } from "node:stream";
import { err, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import { applyContainerCreatePolicy } from "./create-policy.js";
import { cachedOnSuccess, daemonLookups, fetchHostPlatform } from "./daemon-lookups.js";
import { applyExecPolicy } from "./exec-policy.js";
import {
  buildHttpRequestPreamble,
  cloneHeaders,
  isAbortError,
  queryOf,
  readBody,
  respondJson,
  respondRejection,
  writeRawRejectionAndDestroy,
  writeRawStatusAndDestroy,
} from "./http-io.js";
import { malformed, type ProxyRejection } from "./rejection.js";
import { classify } from "./router.js";
import type { HostPlatform, LookupFailure, ProxyOptions, TaskScope } from "./types.js";

export type { ProxyOptions, TaskScope } from "./types.js";

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

/** A request a body policy rebuilt: where to send it and what. */
interface Rewritten {
  path: string;
  body: Buffer;
}

/**
 * Per-connection task tag — set by the per-task net.Server's `connection`
 * listener. Connection handlers look up the live scope via `#scopes.get(taskId)`
 * each request, so a `registerTask` update mid-flight (e.g. once the
 * supervisor learns the parent docker id) takes effect immediately without
 * re-binding the socket. `signal` is the task's: upstream connections opened
 * for this client are bound to it.
 */
const CONNECTION_TASK = new WeakMap<net.Socket, { taskId: string; signal: AbortSignal }>();

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
 * path itself is the identity. HTTP/1.1 requests forward to the host
 * `/var/run/docker.sock`; hijacked / upgraded endpoints get raw bidirectional
 * piping; a container create or exec create is buffered and rebuilt by its
 * policy, then forwarded.
 *
 * Slice 3.0e ships the proxy in isolation. Slice 3.0f wires it into the
 * supervisor: a fresh socket is allocated on `createTaskContainer` and bound
 * into the task container at `/var/run/docker.sock`.
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
  #closed = false;

  private constructor(opts: ProxyOptions) {
    this.#hostDockerSocket = opts.hostDockerSocket ?? DEFAULT_HOST_DOCKER_SOCKET;
    this.#socketDir = opts.socketDir;
    const socketPath = this.#hostDockerSocket;
    this.#hostPlatform = cachedOnSuccess((signal) => fetchHostPlatform(socketPath, signal));
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
    const server = net.createServer((socket) => {
      // Destroys the socket at once if it was accepted after the abort.
      addAbortSignal(signal, socket);
      CONNECTION_TASK.set(socket, { taskId, signal });
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

    const route = classify(req.method ?? "GET", req.url ?? "/");
    log.debug(
      { taskId: scope.taskId, method: req.method, url: req.url, route: route.kind },
      "proxy request",
    );

    const { signal } = connection;
    const target = req.url ?? "/";
    match(route)
      .with({ kind: "reject" }, ({ rejection }) => {
        respondRejection(res, rejection);
        // Drain the body so Node can free the parser state.
        req.resume();
      })
      .with({ kind: "container_create" }, ({ versionPrefix }) => {
        const lookups = daemonLookups({
          socketPath: this.#hostDockerSocket,
          signal,
          hostPlatform: this.#hostPlatform,
        });
        this.#rewriteAndForward(req, res, scope, signal, (body) =>
          applyContainerCreatePolicy({ body, query: queryOf(target) }, scope, lookups).map(
            (forward) => ({
              path: `${versionPrefix}/containers/create${forward.query === "" ? "" : `?${forward.query}`}`,
              body: forward.body,
            }),
          ),
        );
      })
      .with({ kind: "exec_create" }, () => {
        this.#rewriteAndForward(req, res, scope, signal, (body) =>
          applyExecPolicy(body).map((rebuilt) => ({ path: target, body: rebuilt })),
        );
      })
      .with({ kind: "hijack" }, () => this.#hijackRequest(req, res, signal))
      .with({ kind: "forward" }, () => this.#forwardRequest(req, res, signal))
      .exhaustive();
  }

  /**
   * Buffer the body, rebuild it through `rewrite`, and forward the result;
   * a rejection is answered here. A throw is a bug, logged and answered 500.
   */
  #rewriteAndForward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scope: TaskScope,
    signal: AbortSignal,
    rewrite: (
      body: Buffer,
    ) => PromiseLike<Result<Rewritten, ProxyRejection>> | Result<Rewritten, ProxyRejection>,
  ): void {
    const run = async () => {
      const read = await readBody(req, MAX_REWRITTEN_BODY_BYTES);
      const rewritten = read.isOk() ? await rewrite(read.value) : err(read.error);
      rewritten.match(
        ({ path, body }) => this.#forwardWithBody(req, res, path, body, signal),
        (rejection) => {
          log.info({ taskId: scope.taskId, url: req.url, rejection }, "proxy request rejected");
          respondRejection(res, rejection);
          req.resume();
        },
      );
    };
    run().catch((cause: unknown) => {
      // The task's abort can surface anywhere in the run: teardown, not a fault.
      if (!signal.aborted) {
        log.error({ err: cause, taskId: scope.taskId, url: req.url }, "proxy body policy failed");
      }
      if (!res.headersSent) {
        respondJson(res, 500, { message: `Cogmo proxy: ${describeError(cause)}` });
      }
    });
  }

  // ── Forwarding ──────────────────────────────────────────────────────────

  #forwardRequest(req: http.IncomingMessage, res: http.ServerResponse, signal: AbortSignal): void {
    const upstream = http.request(
      {
        socketPath: this.#hostDockerSocket,
        method: req.method,
        path: req.url,
        headers: cloneHeaders(req.headers),
        signal,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!isAbortError(err))
        log.warn({ err: err.message, url: req.url }, "upstream forward error");
      respondDaemonFailed(res, err);
    });
    req.pipe(upstream);
  }

  #forwardWithBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    body: Buffer,
    signal: AbortSignal,
  ): void {
    // Rebuilt body — strip any Content-Length / Transfer-Encoding the client
    // sent and re-supply Content-Length so the upstream sees a well-framed
    // request. Strip Expect: 100-continue too — we already consumed the body.
    const headers = cloneHeaders(req.headers);
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    delete headers.expect;
    headers["content-length"] = String(body.length);

    const upstream = http.request(
      {
        socketPath: this.#hostDockerSocket,
        method: req.method,
        path,
        headers,
        signal,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!isAbortError(err)) {
        log.warn({ err: err.message, url: req.url }, "upstream forward (body) error");
      }
      respondDaemonFailed(res, err);
    });
    upstream.end(body);
  }

  /**
   * Hijacked endpoints: open a fresh upstream connection, send the request
   * line + headers verbatim, then pipe the client and upstream sockets in
   * both directions. Covers `/exec/{id}/start`, `/containers/{id}/attach`,
   * `/events`, log follow and `/distribution`. Once an upgrade completes
   * the proxy does not speak the inner protocol.
   */
  #hijackRequest(req: http.IncomingMessage, res: http.ServerResponse, signal: AbortSignal): void {
    const clientSocket = req.socket;
    if (!clientSocket) {
      respondJson(res, 500, { message: "Cogmo proxy: hijack without socket" });
      return;
    }
    // Detach from the http response — we're going raw.
    res.detachSocket?.(clientSocket);

    const upstream = net.createConnection({ path: this.#hostDockerSocket, signal });
    upstream.once("connect", () => {
      // Replay the request line and headers to the upstream daemon. We
      // can't use http.request here because Node's http client owns the
      // socket lifecycle and won't expose the raw byte stream after upgrade
      // in a way that fits Docker's hijack protocol cleanly.
      upstream.write(buildHttpRequestPreamble(req));
      // Pipe in both directions. Default `pipe()` propagates `end` (FIN)
      // bidirectionally — if a client like `docker exec` half-closes its
      // write side after sending stdin, the upstream sees the FIN and
      // can flush. Errors on either side propagate via the `error`
      // listeners and close both halves.
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", (err) => {
      if (!isAbortError(err)) log.warn({ err: err.message, url: req.url }, "upstream hijack error");
      clientSocket.destroy(err);
    });
    clientSocket.on("error", () => upstream.destroy());
  }

  /**
   * `http.IncomingMessage` upgrade event handler — fires for `Upgrade:` headers.
   * Same raw-pipe treatment as #hijackRequest, but Node hands us the head
   * buffer (any bytes the client sent after the headers but before we
   * accepted the upgrade), which we replay to the upstream.
   *
   * Same scope + classify checks as #handleRequest. Without them an
   * `Upgrade: tcp` to `/swarm/*` would slip past the deny prefix.
   */
  #handleUpgrade(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const connection = CONNECTION_TASK.get(req.socket);
    if (!connection || !this.#scopes.has(connection.taskId)) {
      writeRawStatusAndDestroy(clientSocket, 500, "Cogmo proxy: connection has no task scope");
      return;
    }
    const route = classify(req.method ?? "GET", req.url ?? "/");
    // A body policy route and a plain forward are normal requests; only a
    // hijack endpoint may be upgraded.
    match(route)
      .with({ kind: "reject" }, ({ rejection }) =>
        writeRawRejectionAndDestroy(clientSocket, rejection),
      )
      .with({ kind: P.union("container_create", "exec_create", "forward") }, ({ kind }) =>
        writeRawRejectionAndDestroy(clientSocket, malformed(`${kind} endpoint cannot be upgraded`)),
      )
      .with({ kind: "hijack" }, () => this.#pipeUpgrade(req, clientSocket, head, connection.signal))
      .exhaustive();
  }

  #pipeUpgrade(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
    signal: AbortSignal,
  ): void {
    const upstream = net.createConnection({ path: this.#hostDockerSocket, signal });
    upstream.once("connect", () => {
      upstream.write(buildHttpRequestPreamble(req));
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", (err) => {
      if (!isAbortError(err))
        log.warn({ err: err.message, url: req.url }, "upstream upgrade error");
      clientSocket.destroy(err);
    });
    clientSocket.on("error", () => upstream.destroy());
  }
}

/** A forward whose daemon connection failed: `daemon_failed` if nothing was sent yet. */
function respondDaemonFailed(res: http.ServerResponse, cause: Error): void {
  if (res.headersSent) {
    res.destroy(cause);
    return;
  }
  respondRejection(res, {
    kind: "daemon_failed",
    message: `Cogmo proxy upstream error: ${cause.message}`,
  });
}
