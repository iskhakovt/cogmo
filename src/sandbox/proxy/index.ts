import { mkdir, rm } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { join } from "node:path";
import { logger } from "../../logger.js";
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
 * Per-connection task-id tag — set by the per-task net.Server's `connection`
 * listener. Connection handlers look up the live scope via `#scopes.get(taskId)`
 * each request, so a `registerTask` update mid-flight (e.g. once the
 * supervisor learns the parent docker id) takes effect immediately without
 * re-binding the socket.
 */
const TASK_ID_BY_SOCKET = new WeakMap<net.Socket, string>();

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
  /** One per-task net.Server keyed by taskId. */
  #taskServers = new Map<string, net.Server>();
  /** Tracks task socket paths so we can remove them on shutdown. */
  #socketPaths = new Map<string, string>();
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
      log.warn({ err: err.message }, "proxy http clientError");
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
   */
  async registerTask(scope: TaskScope): Promise<string> {
    if (this.#closed) throw new Error("proxy is closed");
    this.#scopes.set(scope.taskId, scope);

    const existing = this.#socketPaths.get(scope.taskId);
    if (existing) return existing;

    const socketPath = join(this.#socketDir, `${scope.taskId}.sock`);
    await rm(socketPath, { force: true });
    const taskId = scope.taskId;

    const server = net.createServer((socket) => {
      TASK_ID_BY_SOCKET.set(socket, taskId);
      this.#httpServer.emit("connection", socket);
    });
    server.on("error", (err) => log.warn({ err: err.message, taskId }, "task socket error"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.#taskServers.set(taskId, server);
    this.#socketPaths.set(taskId, socketPath);
    log.info({ taskId, socketPath }, "registered task proxy socket");
    return socketPath;
  }

  /** Close and remove a task's socket. Idempotent. */
  async unregisterTask(taskId: string): Promise<void> {
    const server = this.#taskServers.get(taskId);
    const socketPath = this.#socketPaths.get(taskId);
    this.#taskServers.delete(taskId);
    this.#socketPaths.delete(taskId);
    this.#scopes.delete(taskId);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (socketPath) {
      await rm(socketPath, { force: true });
    }
  }

  /** Tear down all task sockets and the shared HTTP server. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const taskId of [...this.#taskServers.keys()]) {
      await this.unregisterTask(taskId);
    }
    await new Promise<void>((resolve) => this.#httpServer.close(() => resolve()));
  }

  // ── HTTP request dispatch ────────────────────────────────────────────────

  #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const taskId = TASK_ID_BY_SOCKET.get(req.socket);
    const scope = taskId ? this.#scopes.get(taskId) : undefined;
    if (!scope) {
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

    if (route.kind === "policy" && route.subject === "container_create") {
      this.#handleContainerCreate(req, res, scope).catch((err: unknown) => {
        log.error({ err, taskId: scope.taskId }, "container_create policy failed");
        if (!res.headersSent) {
          respondJson(res, 500, { message: `Cogmo proxy: ${(err as Error).message}` });
        }
      });
      return;
    }

    if (route.kind === "hijack") {
      this.#hijackRequest(req, res);
      return;
    }

    // Plain forward.
    this.#forwardRequest(req, res);
  }

  async #handleContainerCreate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scope: TaskScope,
  ): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req, CONTAINER_CREATE_MAX_BODY_BYTES);
    } catch (err) {
      if ((err as Error).message === "body_too_large") {
        // Write the 413 first, then drain whatever's still in flight so
        // the client gets a clean response instead of ECONNRESET. Node
        // discards drained chunks; for a hostile multi-GB body we'd want
        // to bound the drain too, but at slice 3 scale the cap is small
        // enough that draining the rest is cheap.
        respondJson(res, 413, {
          message: `Cogmo proxy: request body exceeds ${CONTAINER_CREATE_MAX_BODY_BYTES} bytes`,
        });
        req.resume();
        return;
      }
      throw err;
    }
    const decision = applyContainerCreatePolicy(body, scope);
    if (decision.kind === "deny") {
      log.info(
        { taskId: scope.taskId, status: decision.status, reason: decision.message },
        "container_create denied",
      );
      respondJson(res, decision.status, { message: decision.message });
      return;
    }
    this.#forwardWithBody(req, res, decision.body);
  }

  // ── Forwarding ──────────────────────────────────────────────────────────

  #forwardRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const upstream = http.request(
      {
        socketPath: this.#hostDockerSocket,
        method: req.method,
        path: req.url,
        headers: cloneHeaders(req.headers),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      log.warn({ err: err.message, url: req.url }, "upstream forward error");
      if (!res.headersSent) {
        respondJson(res, 502, { message: `Cogmo proxy upstream error: ${err.message}` });
      } else {
        res.destroy(err);
      }
    });
    req.pipe(upstream);
  }

  #forwardWithBody(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
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
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      log.warn({ err: err.message, url: req.url }, "upstream forward (body) error");
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
  #hijackRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const clientSocket = req.socket;
    if (!clientSocket) {
      respondJson(res, 500, { message: "Cogmo proxy: hijack without socket" });
      return;
    }
    // Detach from the http response — we're going raw.
    res.detachSocket?.(clientSocket);

    const upstream = net.createConnection({ path: this.#hostDockerSocket });
    upstream.once("connect", () => {
      // Replay the request line and headers to the upstream daemon. We
      // can't use http.request here because Node's http client owns the
      // socket lifecycle and won't expose the raw byte stream after upgrade
      // in a way that fits Docker's hijack protocol cleanly.
      upstream.write(buildHttpRequestPreamble(req));
      // Pipe in both directions. Errors on either side close both.
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", (err) => {
      log.warn({ err: err.message, url: req.url }, "upstream hijack error");
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
    const taskId = TASK_ID_BY_SOCKET.get(req.socket);
    if (!taskId || !this.#scopes.has(taskId)) {
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

    const upstream = net.createConnection({ path: this.#hostDockerSocket });
    upstream.once("connect", () => {
      upstream.write(buildHttpRequestPreamble(req));
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", (err) => {
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

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      // Surface to the caller so it can write a 413 response. The caller
      // is responsible for draining the rest of the body (`req.resume()`)
      // so the client connection closes cleanly rather than RST'ing.
      throw new Error("body_too_large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
