import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { WebStreamRegistry } from "../transport/adapters/web/stream-registry.js";
import type { Transport } from "../transport/transport.js";
import {
  buildClearCookie,
  buildSessionCookie,
  parseCookies,
  sessionCookieName,
} from "./auth/cookies.js";
import { type AuthStrategy, authenticate, cookieStrategy, csrfReject } from "./auth/gate.js";
import { readJsonBody, sendBodyError } from "./body.js";
import { handleChat } from "./chat.js";
import { writeHealth } from "./health-route.js";
import { OWNER_HANDLE } from "./rpc/context.js";
import { handleRpc } from "./rpc/handler.js";
import { createSession } from "./session/create-session.js";
import { destroySession } from "./session/destroy-session.js";
import { resolveSession } from "./session/resolve-session.js";
import { createStaticHandler } from "./static.js";
import type { WebSessionStore } from "./store/index.js";

export interface CreateWebServerDeps {
  /**
   * Web-scoped Transport for the oRPC layer. The `null` arm is defensive-only:
   * `bootstrapRuntime` provisions the web channel before building this, so a
   * real boot is always non-null — the null path + its 503 are a tested
   * backstop, not a runtime state to chase down.
   */
  webTransport: Transport | null;
  webSessionStore: WebSessionStore;
  /** SSE bridge the chat routes register tab connections on; the WebUiAdapter writes through it. */
  webStreamRegistry: WebStreamRegistry;
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
  /**
   * Dev-only: when set to the SPA's dev origin, the server answers a matching
   * `Origin` with credentialed CORS so the Vite dev server's cross-origin SSE
   * stream works. `null` in prod (same-origin) — no CORS, locked down.
   */
  webDevAllowOrigin: string | null;
}

export interface StartWebServerDeps extends CreateWebServerDeps {
  host: string;
  port: number;
}

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(message);
}

/**
 * Strip a trailing slash so a copy-pasted `http://host:port/` still matches the
 * browser's `Origin` header, which never carries one.
 */
function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

/** Login request body. Validated with Zod rather than a hand-rolled typeof ladder. */
const LoginBody = z.object({ token: z.string() });

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
      sendBodyError(res, err);
      return;
    }
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) {
      send(res, 400, "Bad Request");
      return;
    }
    const result = await createSession(
      {
        runInTx: deps.runInTx,
        webSessionStore: deps.webSessionStore,
        verifyLoginToken: deps.verifyLoginToken,
        ownerUserId: deps.ownerUserId,
        ttlDays: deps.sessionTtlDays,
      },
      { token: parsed.data.token, now: new Date() },
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

    // Dev-only CORS for the SPA's cross-origin SSE stream. In dev the Vite
    // server serves the SPA on a different origin and its EventSource hits the
    // API directly (the Vite proxy can't hold an SSE open), so answer the
    // configured dev origin with credentialed CORS. Unset in prod -> no headers,
    // same-origin only. `setHeader` survives the handlers' `writeHead` merges.
    // `allowOrigin` is the configured allow-list value (never the raw request
    // `Origin`), so the credentialed response only ever names that one
    // pre-configured origin; a non-matching `Origin` gets no headers at all.
    const allowOrigin =
      deps.webDevAllowOrigin === null ? null : normalizeOrigin(deps.webDevAllowOrigin);
    if (allowOrigin !== null && req.headers.origin === allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      if (method === "OPTIONS") {
        const requested = req.headers["access-control-request-headers"];
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers":
            typeof requested === "string" ? requested : "content-type",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }
    }

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
    const isChat = path === "/api/chat" || path.startsWith("/api/chat/");

    if (isLogout || isRpc || isChat) {
      const identity = await authenticate(req, strategies);
      if (!identity) {
        send(res, 401, "Unauthorized");
        return;
      }
      if (isLogout) {
        await handleLogout(req, res);
        return;
      }
      // Both the oRPC and chat surfaces drive the web-scoped Transport.
      if (!deps.webTransport) {
        send(res, 503, "Web channel not provisioned — run `cogmo setup`");
        return;
      }
      if (isChat) {
        await handleChat(req, res, path, {
          transport: deps.webTransport,
          registry: deps.webStreamRegistry,
          ownerHandle: identity.platformUserHandle,
        });
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
  return new Promise((resolve, reject) => {
    // Surface a bind failure (EADDRINUSE / EACCES) as a rejected promise; without
    // this the 'error' event is unhandled (uncaught exception) and the await never
    // settles. Scoped to startup — removed once listening so runtime errors aren't
    // swallowed.
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => {
      server.removeListener("error", reject);
      logger.info({ host: deps.host, port: deps.port }, "web server listening");
      resolve(server);
    });
  });
}
