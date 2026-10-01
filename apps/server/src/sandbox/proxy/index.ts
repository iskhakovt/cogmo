import { mkdir, rm } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { join } from "node:path";
import { addAbortSignal } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import { applyContainerCreatePolicy } from "./policy.js";
import { classify } from "./router.js";
import type { ProxyOptions, TaskScope } from "./types.js";

export type { ProxyOptions, TaskScope } from "./types.js";

const log = logger.child({ component: "sandbox.proxy" });

const DEFAULT_HOST_DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * Hard cap on the buffered body size for `POST /containers/create`. Docker's
 * daemon doesn't enforce a small limit either, but we read the whole body
 * before forwarding (to inspect + mutate); without this cap a hostile
 * caller could ask us to allocate gigabytes. 1 MiB is far above any real
 * container spec — published images don't exceed a few KB of JSON.
 */
const CONTAINER_CREATE_MAX_BODY_BYTES = 1 * 1024 * 1024;

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
 * piping; `POST /containers/create` is buffered, validated, mutated to inject
 * labels + runtime + cgroup parent, then forwarded.
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
  #closed = false;

  private constructor(opts: ProxyOptions) {
    this.#hostDockerSocket = opts.hostDockerSocket ?? DEFAULT_HOST_DOCKER_SOCKET;
    this.#socketDir = opts.socketDir;
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

    if (route.kind === "deny") {
      respondJson(res, route.status, { message: route.reason });
      // Drain the body so Node can free the parser state.
      req.resume();
      return;
    }

    const { signal } = connection;
    if (route.kind === "policy" && route.subject === "container_create") {
      this.#handleContainerCreate(req, res, scope, signal).catch((err: unknown) => {
        // An unregister mid-read resets the body stream: teardown, not a fault.
        if (!signal.aborted) {
          log.error({ err, taskId: scope.taskId }, "container_create policy failed");
        }
        if (!res.headersSent) {
          respondJson(res, 500, { message: `Cogmo proxy: ${describeError(err)}` });
        }
      });
      return;
    }

    if (route.kind === "hijack") {
      this.#hijackRequest(req, res, signal);
      return;
    }

    // Plain forward.
    this.#forwardRequest(req, res, signal);
  }

  async #handleContainerCreate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scope: TaskScope,
    signal: AbortSignal,
  ): Promise<void> {
    const read = await readBody(req, CONTAINER_CREATE_MAX_BODY_BYTES);
    if (read.isErr()) {
      // Write the 413, then drain the rest so the client sees a clean
      // response rather than ECONNRESET.
      respondJson(res, 413, {
        message: `Cogmo proxy: request body exceeds ${read.error.maxBytes} bytes`,
      });
      req.resume();
      return;
    }
    const body = read.value;
    const decision = applyContainerCreatePolicy(body, scope);
    if (decision.kind === "deny") {
      log.info(
        { taskId: scope.taskId, status: decision.status, reason: decision.message },
        "container_create denied",
      );
      respondJson(res, decision.status, { message: decision.message });
      return;
    }
    this.#forwardWithBody(req, res, decision.body, signal);
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
      if (!res.headersSent) {
        respondJson(res, 502, { message: `Cogmo proxy upstream error: ${err.message}` });
      } else {
        res.destroy(err);
      }
    });
    req.pipe(upstream);
  }

  #forwardWithBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    signal: AbortSignal,
  ): void {
    // Mutated body — strip any Content-Length / Transfer-Encoding the client
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
        path: req.url,
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
      if (!res.headersSent) {
        respondJson(res, 502, { message: `Cogmo proxy upstream error: ${err.message}` });
      } else {
        res.destroy(err);
      }
    });
    upstream.end(body);
  }

  /**
   * Hijacked endpoints: open a fresh upstream connection, send the request
   * line + headers verbatim, then pipe the client and upstream sockets in
   * both directions. Covers `/exec/{id}/start`, `/containers/{id}/attach`,
   * `/events`, log follow, `/build`, `/session`. Same code path for the
   * BuildKit `Upgrade: tcp` → HTTP/2 case — once the upgrade completes
   * we don't speak the inner protocol.
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
      writeRawHttpStatusAndDestroy(clientSocket, 500, "Cogmo proxy: connection has no task scope");
      return;
    }
    const route = classify(req.method ?? "GET", req.url ?? "/");
    if (route.kind === "deny") {
      writeRawHttpStatusAndDestroy(clientSocket, route.status, route.reason);
      return;
    }
    // `policy` outcomes wouldn't happen via Upgrade (`POST /containers/create`
    // doesn't use Upgrade), and `forward` is a normal request — neither
    // should reach the upgrade handler. Only `hijack` is expected here.
    if (route.kind !== "hijack") {
      writeRawHttpStatusAndDestroy(
        clientSocket,
        400,
        `Cogmo proxy: ${route.kind} endpoint cannot be upgraded`,
      );
      return;
    }

    const upstream = net.createConnection({
      path: this.#hostDockerSocket,
      signal: connection.signal,
    });
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

/**
 * Write a minimal HTTP/1.1 response on a hijacked client socket and close
 * it. Used by the upgrade handler when no `http.ServerResponse` is around
 * to format a clean reply.
 */
function writeRawHttpStatusAndDestroy(socket: net.Socket, status: number, message: string): void {
  const body = `${JSON.stringify({ message })}\n`;
  const reply =
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n` +
    `\r\n${body}`;
  socket.end(reply);
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 500:
      return "Internal Server Error";
    default:
      return "OK";
  }
}

/**
 * Build an HTTP/1.1 request preamble (request line + headers + empty line)
 * for replay to the upstream daemon. Used for hijacked / upgraded requests
 * where we forward at the byte level rather than via http.request.
 */
function buildHttpRequestPreamble(req: http.IncomingMessage): Buffer {
  const lines: string[] = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (const [name, raw] of Object.entries(req.headers)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const v of raw) lines.push(`${name}: ${v}`);
    } else {
      lines.push(`${name}: ${raw}`);
    }
  }
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

/** An abort from the task's signal: an expected teardown, not a fault to log. */
function isAbortError(err: Error): boolean {
  return err.name === "AbortError";
}

function cloneHeaders(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function respondJson(res: http.ServerResponse, status: number, body: object): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
  });
  res.end(payload);
}

/**
 * Read the whole body, or stop at the first chunk past `maxBytes`. The caller
 * answers `body_too_large` with a 413 and drains the rest (`req.resume()`), so
 * the client connection closes cleanly rather than RST'ing.
 */
async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Result<Buffer, { kind: "body_too_large"; maxBytes: number }>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) return err({ kind: "body_too_large", maxBytes });
    chunks.push(buf);
  }
  return ok(Buffer.concat(chunks));
}
