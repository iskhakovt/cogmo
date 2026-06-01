import type { AddressInfo } from "node:net";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import type { Database, Transactor } from "../db/index.js";
import { expectDefined } from "../test/assertions.js";
import { mockTransportDeep } from "../test/factories.js";
import { createTestDatabase } from "../test/pglite.js";
import type { webRouter } from "./rpc/router.js";
import { createWebServer } from "./server.js";
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
  it("serves the health route (promoted, unauthenticated)", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/health+json");
    expect(await res.json()).toMatchObject({ status: "pass" });
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
});
