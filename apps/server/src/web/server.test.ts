import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import type { Database, Transactor } from "../db/index.js";
import { expectDefined } from "../test/assertions.js";
import { mockTransportDeep } from "../test/factories.js";
import { createTestDatabase } from "../test/pglite.js";
import { WebStreamRegistry } from "../transport/adapters/web/stream-registry.js";
import type { webRouter } from "./rpc/router.js";
import { createWebServer, startWebServer } from "./server.js";
import { hashSessionToken } from "./session/token.js";
import { DrizzleWebSessionStore } from "./store/index.js";
import { webSessions } from "./store/schema.js";

const VALID_TOKEN = "secret-token";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let server: ReturnType<typeof createWebServer>;
let base: string;
let ownerUserId: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  const agentStore = new DrizzleAgentStore();
  ownerUserId = await tx(async (trx) => (await agentStore.createUser(trx)).id);

  server = createWebServer({
    webTransport: mockTransportDeep({ models: { list: async () => ["gpt", "claude"] } }),
    webSessionStore: new DrizzleWebSessionStore(),
    webStreamRegistry: new WebStreamRegistry(),
    runInTx: tx,
    verifyLoginToken: (candidate) => candidate === VALID_TOKEN,
    ownerUserId,
    sessionTtlDays: 30,
    cookieSecure: true,
    staticRoot: "/nonexistent-cogmo-dist",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // Only sessions — keep the owner user the server's deps are bound to.
  await db.delete(webSessions);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await close();
});

/** Headers a same-origin browser fetch would carry on a state-changing JSON request. */
function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "sec-fetch-site": "same-origin", ...extra };
}

/** Log in and return the `name=value` cookie pair for reuse as a Cookie header. */
async function login(): Promise<string> {
  const res = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ token: VALID_TOKEN }),
  });
  expect(res.status).toBe(200);
  const setCookie = expectDefined(res.headers.get("set-cookie"), "set-cookie header");
  return expectDefined(setCookie.split(";")[0], "cookie pair");
}

/** An oRPC client whose fetch injects the same-origin marker + an optional cookie. */
function rpcClient(cookie?: string): RouterClient<typeof webRouter> {
  const link = new RPCLink({
    url: `${base}/rpc`,
    // Browsers set Sec-Fetch-Site automatically on same-origin requests; node
    // doesn't, and EventSource/fetch can't carry the session cookie cross-test,
    // so inject both while preserving oRPC's method + body by cloning the Request.
    fetch: (request) => {
      const headers = new Headers(request.headers);
      headers.set("sec-fetch-site", "same-origin");
      if (cookie) headers.set("cookie", cookie);
      return globalThis.fetch(new Request(request, { headers }));
    },
  });
  return createORPCClient(link);
}

describe("web server", () => {
  it("serves the health route (promoted, unauthenticated) with the full body shape", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/health+json");
    // The IETF health+json contract: status + version + description + notes
    // (node version + start time).
    expect(await res.json()).toMatchObject({
      status: "pass",
      description: "cogmo",
      version: expect.any(String),
      notes: expect.arrayContaining([
        expect.stringMatching(/^node: /),
        expect.stringMatching(/^startedAt: /),
      ]),
    });
  });

  it("404s unknown paths when no SPA dist is present", async () => {
    expect((await fetch(`${base}/somewhere`)).status).toBe(404);
  });

  describe("POST /api/session", () => {
    it("rejects a wrong token with no cookie", async () => {
      const res = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ token: "wrong" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("mints a hardened cookie for the right token", async () => {
      const res = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ token: VALID_TOKEN }),
      });
      expect(res.status).toBe(200);
      const cookie = expectDefined(res.headers.get("set-cookie"), "set-cookie");
      expect(cookie).toContain("__Host-session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");
    });

    it("403s a non-JSON content-type (CSRF)", async () => {
      const res = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: jsonHeaders({ "content-type": "text/plain" }),
        body: JSON.stringify({ token: VALID_TOKEN }),
      });
      expect(res.status).toBe(403);
    });

    it("413s an oversized body (unauthenticated DoS guard)", async () => {
      const res = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ token: "x".repeat(70 * 1024) }),
      });
      expect(res.status).toBe(413);
    });

    it("400s a malformed JSON body", async () => {
      const res = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: jsonHeaders(),
        body: "{not valid json",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("/rpc (gated)", () => {
    it("401s an RPC call with no cookie (fail-closed)", async () => {
      await expect(rpcClient().models.list()).rejects.toThrow();
    });

    it("returns the namespace read behind a valid cookie (acceptance)", async () => {
      const cookie = await login();
      expect(await rpcClient(cookie).models.list()).toEqual(["gpt", "claude"]);
    });

    it("403s a state-changing RPC POST with no same-origin proof (CSRF)", async () => {
      const cookie = await login();
      const res = await fetch(`${base}/rpc/models/list`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: "{}",
      });
      expect(res.status).toBe(403);
    });

    it("503s behind a valid cookie when the web channel isn't provisioned", async () => {
      // Separate server with no web-scoped Transport (web channel unprovisioned).
      const server503 = createWebServer({
        webTransport: null,
        webSessionStore: new DrizzleWebSessionStore(),
        webStreamRegistry: new WebStreamRegistry(),
        runInTx: tx,
        verifyLoginToken: (candidate) => candidate === VALID_TOKEN,
        ownerUserId,
        sessionTtlDays: 30,
        cookieSecure: true,
        staticRoot: "/nonexistent-cogmo-dist",
      });
      await new Promise<void>((resolve) => server503.listen(0, "127.0.0.1", resolve));
      const base503 = `http://127.0.0.1:${(server503.address() as AddressInfo).port}`;
      try {
        const loginRes = await fetch(`${base503}/api/session`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ token: VALID_TOKEN }),
        });
        const setCookie = expectDefined(loginRes.headers.get("set-cookie"), "set-cookie");
        const cookie = expectDefined(setCookie.split(";")[0], "cookie pair");
        // Gate passes (valid cookie); the null Transport is what surfaces 503.
        const res = await fetch(`${base503}/rpc/models/list`, {
          headers: { cookie, "sec-fetch-site": "same-origin" },
        });
        expect(res.status).toBe(503);
      } finally {
        await new Promise<void>((resolve) => server503.close(() => resolve()));
      }
    });
  });

  describe("DELETE /api/session (logout)", () => {
    it("clears the cookie and invalidates the session", async () => {
      const cookie = await login();
      const res = await fetch(`${base}/api/session`, {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-origin", cookie },
      });
      expect(res.status).toBe(204);
      expect(expectDefined(res.headers.get("set-cookie"), "clear cookie")).toContain("Max-Age=0");
      // The deleted session no longer authenticates.
      await expect(rpcClient(cookie).models.list()).rejects.toThrow();
    });
  });

  it("401s an expired session cookie", async () => {
    await tx((trx) =>
      new DrizzleWebSessionStore().create(trx, {
        tokenHash: hashSessionToken("expired-raw"),
        userId: ownerUserId,
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    await expect(rpcClient("__Host-session=expired-raw").models.list()).rejects.toThrow();
  });

  it("startWebServer rejects on a bind failure instead of crashing", async () => {
    // Occupy a port, then start the web server on the same one -> EADDRINUSE.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(
        startWebServer({
          webTransport: null,
          webSessionStore: new DrizzleWebSessionStore(),
          webStreamRegistry: new WebStreamRegistry(),
          runInTx: tx,
          verifyLoginToken: () => false,
          ownerUserId,
          sessionTtlDays: 30,
          cookieSecure: true,
          staticRoot: "/nonexistent-cogmo-dist",
          host: "127.0.0.1",
          port,
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("web chat routes", () => {
  let chatServer: ReturnType<typeof createWebServer>;
  let chatBase: string;
  let chatRegistry: WebStreamRegistry;
  let transport: ReturnType<typeof mockTransportDeep>;

  const session = {
    id: "sess-1",
    channelId: "ch-1",
    platformAddress: "tab-1",
    conversationId: "conv-1",
    status: "active" as const,
    receive: "all" as const,
  };

  /** Start a chat server with a fresh registry + transport mock (default or overridden). */
  async function start(overrides: Parameters<typeof mockTransportDeep>[0] = {}): Promise<void> {
    chatRegistry = new WebStreamRegistry();
    transport = mockTransportDeep(overrides);
    chatServer = createWebServer({
      webTransport: transport,
      webSessionStore: new DrizzleWebSessionStore(),
      webStreamRegistry: chatRegistry,
      runInTx: tx,
      verifyLoginToken: (candidate) => candidate === VALID_TOKEN,
      ownerUserId,
      sessionTtlDays: 30,
      cookieSecure: true,
      staticRoot: "/nonexistent-cogmo-dist",
    });
    await new Promise<void>((resolve) => chatServer.listen(0, "127.0.0.1", resolve));
    chatBase = `http://127.0.0.1:${(chatServer.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (chatServer?.listening) {
      await new Promise<void>((resolve) => {
        chatServer.closeIdleConnections();
        chatServer.close(() => resolve());
      });
    }
  });

  it("creates a conversation and returns its id", async () => {
    await start();
    const cookie = await login();
    const res = await fetch(`${chatBase}/api/chat?tab=tab-1`, {
      method: "POST",
      headers: jsonHeaders({ cookie }),
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: "conv-1" });
  });

  it("emits a user turn to the resolved session (202)", async () => {
    await start({ resolveSession: vi.fn().mockResolvedValue(session) });
    const cookie = await login();
    const res = await fetch(`${chatBase}/api/chat/conv-1?tab=tab-1`, {
      method: "POST",
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(202);
    expect(transport.emit).toHaveBeenCalledWith("sess-1", "hello", expect.any(Date));
  });

  it("409s a send when the tab has no open session", async () => {
    await start({ resolveSession: vi.fn().mockResolvedValue(null) });
    const cookie = await login();
    const res = await fetch(`${chatBase}/api/chat/conv-1?tab=tab-1`, {
      method: "POST",
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(409);
  });

  it("409s a send when the session points at a different conversation", async () => {
    await start({
      resolveSession: vi.fn().mockResolvedValue({ ...session, conversationId: "conv-other" }),
    });
    const cookie = await login();
    const res = await fetch(`${chatBase}/api/chat/conv-1?tab=tab-1`, {
      method: "POST",
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(409);
  });

  it("400s a send with a missing tab or empty body", async () => {
    await start({ resolveSession: vi.fn().mockResolvedValue(session) });
    const cookie = await login();
    const noTab = await fetch(`${chatBase}/api/chat/conv-1`, {
      method: "POST",
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(noTab.status).toBe(400);
    const noText = await fetch(`${chatBase}/api/chat/conv-1?tab=tab-1`, {
      method: "POST",
      headers: jsonHeaders({ cookie }),
      body: "{}",
    });
    expect(noText.status).toBe(400);
  });

  it("opens an SSE stream that registers the tab and emits a ready frame", async () => {
    await start();
    const cookie = await login();
    const ac = new AbortController();
    const res = await fetch(`${chatBase}/api/chat/conv-1/stream?tab=tab-1`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
      signal: ac.signal,
    });
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = expectDefined(res.body, "sse body").getReader();
      const first = await reader.read();
      const text = new TextDecoder().decode(expectDefined(first.value, "first frame"));
      expect(text).toContain("event: ready");
      expect(chatRegistry.size).toBe(1);
      await reader.cancel();
    } finally {
      ac.abort();
    }
  });

  it("401s the stream without a session cookie (fail-closed)", async () => {
    await start();
    const res = await fetch(`${chatBase}/api/chat/conv-1/stream?tab=tab-1`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(401);
  });

  it("403s a create with a non-JSON content-type (CSRF)", async () => {
    await start();
    const res = await fetch(`${chatBase}/api/chat?tab=tab-1`, {
      method: "POST",
      headers: jsonHeaders({ "content-type": "text/plain" }),
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
