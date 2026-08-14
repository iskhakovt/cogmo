/**
 * Wedge regression — real `@daytona/sdk` against a stub HTTP+WS server
 * whose log-stream WebSocket holds open and never closes.
 *
 * Unit-tier `exec-streaming.test.ts` covers the timeout + cleanup paths
 * with a `fakeProcess()` stub. This test goes one layer down: a real
 * `Daytona` client built from `@daytona/sdk` calls `getSessionCommandLogs`
 * which opens a real `ws` WebSocket against a hand-rolled test server.
 * The server accepts the upgrade and emits nothing — modelling the
 * Daytona wedge (Daytona [#2513](https://github.com/daytonaio/daytona/issues/2513)
 * — no async exit notification; [#2510](https://github.com/daytonaio/daytona/issues/2510)
 * — log-stream WS doesn't always close).
 *
 * The contract the test pins:
 *   1. `wait()` rejects with `ExecTimeoutError` within `timeoutMs + ε`,
 *      not at the vitest default-timeout boundary.
 *   2. The cleanup `DELETE /toolbox/.../session/<sid>` was sent — the
 *      Daytona [#2510] recommended explicit-cleanup path.
 *
 * Lives in the unit tier (no Docker, no Postgres, no Inngest) — the
 * stub server is in-process. Real SDK + real `ws` lib is the
 * integration value; routing through the `integration` project
 * would force Docker compose for an in-process test.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Daytona } from "@daytona/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { ExecTimeoutError } from "../index.js";
import { startExecStreaming } from "./exec-streaming.js";

const SANDBOX_ID = "wedge-sandbox-id";

interface StubServer {
  url: string;
  /** DELETE calls captured for assertion — the cleanup path's signature. */
  deletedSessions: string[];
  stop: () => Promise<void>;
}

/**
 * Minimal HTTP+WS server that satisfies the subset of the Daytona REST
 * surface `startExecStreaming` actually drives. Pattern-matches paths
 * (no fixture cursor — easier than threading session-id placeholders
 * through a recorded fixture).
 */
async function startStubServer(): Promise<StubServer> {
  const deletedSessions: string[] = [];
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  // Track open log-stream WS sockets so the cleanup `DELETE` handler
  // can close them server-side — that's the real-Daytona contract
  // (`deleteSession` tears down the per-session WS). Without this the
  // SDK's `getSessionCommandLogs` Promise never settles after we
  // timeout, and the SDK keeps the socket half-open forever.
  const openLogStreams = new Set<WebSocket>();

  // Build the sandbox body once. `toolboxProxyUrl` is patched after
  // listen() so it points at our own server (the SDK uses that URL
  // for every per-sandbox call).
  let toolboxProxyUrl = "";

  const sandboxBody = (): Record<string, unknown> => ({
    id: SANDBOX_ID,
    organizationId: "test-org",
    name: SANDBOX_ID,
    target: "eu",
    snapshot: null,
    user: "daytona",
    env: {},
    cpu: 1,
    gpu: 0,
    memory: 1,
    disk: 3,
    public: false,
    networkBlockAll: false,
    networkAllowList: null,
    labels: {},
    volumes: [],
    state: "started",
    desiredState: "started",
    errorReason: null,
    recoverable: false,
    backupState: "None",
    autoStopInterval: 0,
    autoArchiveInterval: 10080,
    autoDeleteInterval: -1,
    sandboxClass: "container",
    androidDevice: false,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    lastActivityAt: "2026-05-18T00:00:00.000Z",
    buildInfo: null,
    daemonVersion: "v0.173.0",
    runnerId: "test-runner",
    toolboxProxyUrl,
  });

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const { method, url } = req;
    const path = url ?? "/";
    res.setHeader("content-type", "application/json");

    // GET /sandbox/<id> — daytona.get(id) lands here; SDK uses the
    // body to construct the in-process Sandbox object whose
    // `.process` is what we feed to `startExecStreaming`.
    if (method === "GET" && path === `/sandbox/${SANDBOX_ID}`) {
      res.statusCode = 200;
      res.end(JSON.stringify(sandboxBody()));
      return;
    }

    // POST /toolbox/<id>/process/session — createSession
    if (method === "POST" && /^\/toolbox\/[^/]+\/process\/session$/.test(path)) {
      res.statusCode = 201;
      res.end("{}");
      return;
    }

    // POST /toolbox/<id>/process/session/<sid>/exec — executeSessionCommand
    if (method === "POST" && /^\/toolbox\/[^/]+\/process\/session\/[^/]+\/exec$/.test(path)) {
      res.statusCode = 200;
      res.end(JSON.stringify({ cmdId: "wedge-cmd-id" }));
      return;
    }

    // DELETE /toolbox/<id>/process/session/<sid> — the cleanup target,
    // the thing this test exists to prove fires on timeout. Real
    // Daytona tears the per-session WS down here; mirror that so the
    // SDK's `getSessionCommandLogs` promise actually rejects (close
    // code 1006) and `startExecStreaming`'s wsPromise.catch branch
    // runs through the timeout-handling code path.
    const deleteMatch = path.match(/^\/toolbox\/[^/]+\/process\/session\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const sid = deleteMatch[1] ?? "";
      deletedSessions.push(sid);
      for (const ws of openLogStreams) {
        try {
          ws.terminate();
        } catch {
          // already gone
        }
      }
      openLogStreams.clear();
      res.statusCode = 204;
      res.end();
      return;
    }

    // Anything else — surface a 404 with the requested path so a
    // missing-handler bug shows up loudly in the test output
    // instead of as a silent hang.
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `stub: no handler for ${method} ${path}` }));
  };

  server.on("request", handle);

  // WS upgrade: accept it, hold open. Track the socket so the cleanup
  // `DELETE` can terminate it — modelling Daytona's real
  // `deleteSession`-tears-down-WS behaviour.
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.includes("/logs")) {
      wss.handleUpgrade(req, socket as Socket, head, (ws) => {
        openLogStreams.add(ws);
        ws.on("close", () => openLogStreams.delete(ws));
      });
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server address invalid");
  const url = `http://127.0.0.1:${address.port}`;
  // The SDK appends `/<sandbox-id>/...` to `toolboxProxyUrl`. Real
  // Daytona uses `https://proxy.app-eu.daytona.io/toolbox` here so
  // the final path is `…/toolbox/<id>/process/session/…`. Mirror that
  // so our regex handlers see the same shape.
  toolboxProxyUrl = `${url}/toolbox`;

  return {
    url,
    deletedSessions,
    stop: async () => {
      wss.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

let stub: StubServer;
let daytona: Daytona;

beforeAll(async () => {
  stub = await startStubServer();
  daytona = new Daytona({ apiKey: "test", apiUrl: stub.url });
});

afterAll(async () => {
  await stub.stop();
});

describe("startExecStreaming wedge regression (real @daytona/sdk + real ws)", () => {
  // The 4-day wedge in production happened because `getSessionCommandLogs`
  // returned a Promise that never settled — the WS held open without a
  // close frame. Without `timeoutMs`, `await handle.wait()` blocked
  // indefinitely. With the timeout, the cap rejects within `timeoutMs`
  // and our `cleanupSession` path runs `deleteSession` — Daytona [#2510]'s
  // recommended explicit-cleanup workaround for the WS-doesn't-close bug.
  it("total timeoutMs fires + cleanupSession runs when the log-stream WS holds open silently", async () => {
    const sandbox = await daytona.get(SANDBOX_ID);
    const handle = await startExecStreaming({
      process: sandbox.process,
      sessionIdPrefix: "wedge-test",
      cmd: ["sleep", "infinity"],
      opts: { timeoutMs: 200 },
    });
    handle.stdout.on("error", () => {});
    handle.stderr.on("error", () => {});

    const start = Date.now();
    const err = await handle.wait().catch((e: Error) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(ExecTimeoutError);
    expect((err as ExecTimeoutError).kind).toBe("total");
    expect((err as ExecTimeoutError).timeoutMs).toBe(200);
    // Sanity bound — vitest's default 5s timeout shouldn't be in play.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);

    // The whole point: the cleanup DELETE fired. Daytona [#2510]
    // recommends explicit `deleteSession` to tear down the stuck WS
    // server-side. Without this, the per-call session leaks.
    expect(stub.deletedSessions).toHaveLength(1);
    expect(stub.deletedSessions[0]).toMatch(/^wedge-test-/);
  });

  it("idleTimeoutMs fires + cleanupSession runs when WS opens but never emits a byte", async () => {
    const sandbox = await daytona.get(SANDBOX_ID);
    stub.deletedSessions.length = 0;
    const handle = await startExecStreaming({
      process: sandbox.process,
      sessionIdPrefix: "wedge-idle",
      cmd: ["sleep", "infinity"],
      opts: { idleTimeoutMs: 200 },
    });
    handle.stdout.on("error", () => {});
    handle.stderr.on("error", () => {});

    const err = await handle.wait().catch((e: Error) => e);
    expect(err).toBeInstanceOf(ExecTimeoutError);
    expect((err as ExecTimeoutError).kind).toBe("idle");
    expect(stub.deletedSessions).toHaveLength(1);
    expect(stub.deletedSessions[0]).toMatch(/^wedge-idle-/);
  });
});
