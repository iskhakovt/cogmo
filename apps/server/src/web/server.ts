import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { Transport } from "../transport/transport.js";
import {
  buildClearCookie,
  buildSessionCookie,
  parseCookies,
  sessionCookieName,
} from "./auth/cookies.js";
import { type AuthStrategy, authenticate, cookieStrategy, csrfReject } from "./auth/gate.js";
import { writeHealth } from "./health-route.js";
import { OWNER_HANDLE } from "./rpc/context.js";
import { handleRpc } from "./rpc/handler.js";
import { createSession } from "./session/create-session.js";
import { destroySession } from "./session/destroy-session.js";
import { resolveSession } from "./session/resolve-session.js";
import { createStaticHandler } from "./static.js";
import type { WebSessionStore } from "./store/index.js";

export interface CreateWebServerDeps {
  /** Web-scoped Transport for the oRPC layer. Null when the web channel isn't provisioned. */
  webTransport: Transport | null;
  webSessionStore: WebSessionStore;
  runInTx: Transactor;
  /** Constant-time compare of a presented bootstrap token to the derived one. */
  verifyLoginToken: (candidate: string) => boolean;
  /** Owner user id new sessions belong to. */
  ownerUserId: string;
  sessionTtlDays: number;
  /** Hardened (`__Host-`+Secure) cookies vs the dev unprefixed cookie. */
  cookieSecure: boolean;
  /** Filesystem root of the built SPA (sirv). */
  staticRoot: string;
}

export interface StartWebServerDeps extends CreateWebServerDeps {
  host: string;
  port: number;
}

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(message);
}

/** Login bodies are tiny (`{ token }`). Cap the unauthenticated read so a public
 * endpoint can't be used to exhaust memory with an unbounded stream. */
const MAX_BODY_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // Reject an honestly-declared oversized body before reading a byte; the
  // streaming cap below backstops chunked / lying Content-Length. Throwing
  // unwinds the read — the `for await` iterator's return() ends the request
  // stream — and the handler replies 413. We just don't call `req.destroy()`
  // ourselves, which tore down the socket before the response could flush.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Create the in-process web server without listening — the promoted health
 * server plus the auth-gated oRPC admin API and the static SPA. Exported
 * unbound so tests can use an ephemeral port.
 *
 * Routes: `GET /health` (public) · `POST /api/session` (public login) ·
 * `DELETE /api/session` (gated logout) · `ALL /rpc/*` (gated oRPC) ·
 * `GET /*` (sirv SPA fallback). Fail-closed: anything gated without a valid
 * session is 401.
 */
export function createWebServer(deps: CreateWebServerDeps): Server {
  const cookieName = sessionCookieName(deps.cookieSecure);
  const serveStatic = createStaticHandler(deps.staticRoot);

  const strategies: AuthStrategy[] = [
    cookieStrategy({
      cookieName,
      ownerHandle: OWNER_HANDLE,
      resolveSession: (rawToken) =>
        resolveSession(
          { runInTx: deps.runInTx, webSessionStore: deps.webSessionStore },
          { rawToken, now: new Date() },
        ),
    }),
  ];

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      send(res, err instanceof PayloadTooLargeError ? 413 : 400, "Bad Request");
      return;
    }
    const token =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { token?: unknown }).token === "string"
        ? (body as { token: string }).token
        : "";
    const result = await createSession(
      {
        runInTx: deps.runInTx,
        webSessionStore: deps.webSessionStore,
        verifyLoginToken: deps.verifyLoginToken,
        ownerUserId: deps.ownerUserId,
        ttlDays: deps.sessionTtlDays,
      },
      { token, now: new Date() },
    );
    if (!result) {
      send(res, 401, "Unauthorized");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": buildSessionCookie(result.rawToken, {
        secure: deps.cookieSecure,
        maxAgeSeconds: result.maxAgeSeconds,
      }),
    });
    res.end(JSON.stringify({ ok: true }));
  }

  async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawToken = parseCookies(req.headers.cookie)[cookieName];
    if (rawToken) {
      await destroySession(
        { runInTx: deps.runInTx, webSessionStore: deps.webSessionStore },
        { rawToken },
      );
    }
    res.writeHead(204, { "Set-Cookie": buildClearCookie({ secure: deps.cookieSecure }) });
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = (req.url ?? "/").split("?", 1)[0] ?? "/";

    // Public, safe: liveness.
    if (method === "GET" && path === "/health") {
      writeHealth(res);
      return;
    }

    // CSRF gate for every state-changing request, login included.
    if (csrfReject(req)) {
      send(res, 403, "Forbidden");
      return;
    }

    // Public: login.
    if (method === "POST" && path === "/api/session") {
      await handleLogin(req, res);
      return;
    }

    const isLogout = method === "DELETE" && path === "/api/session";
    const isRpc = path === "/rpc" || path.startsWith("/rpc/");

    if (isLogout || isRpc) {
      const identity = await authenticate(req, strategies);
      if (!identity) {
        send(res, 401, "Unauthorized");
        return;
      }
      if (isLogout) {
        await handleLogout(req, res);
        return;
      }
      if (!deps.webTransport) {
        send(res, 503, "Web channel not provisioned — run `cogmo setup`");
        return;
      }
      const { matched } = await handleRpc(req, res, {
        platformUserHandle: identity.platformUserHandle,
        transport: deps.webTransport,
      });
      if (!matched) send(res, 404, "Not Found");
      return;
    }

    // Static SPA shell + assets (public — the login screen must load).
    if (method === "GET" || method === "HEAD") {
      serveStatic(req, res);
      return;
    }
    send(res, 404, "Not Found");
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err, url: req.url }, "web request handler failed");
      if (!res.headersSent) send(res, 500, "Internal Server Error");
      else res.end();
    });
  });
}

/** Start the web server on `host:port`. Returns the node `Server` for shutdown. */
export function startWebServer(deps: StartWebServerDeps): Promise<Server> {
  const server = createWebServer(deps);
  return new Promise((resolve) => {
    server.listen(deps.port, deps.host, () => {
      logger.info({ host: deps.host, port: deps.port }, "web server listening");
      resolve(server);
    });
  });
}
