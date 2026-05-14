import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase } from "../test/pglite.js";
import { HostRunner } from "./client/runner.js";
import { McpRegistryImpl } from "./registry.js";
import { DrizzleMcpStore } from "./store/index.js";

/**
 * HTTP MCP transport integration test. Spawns
 * `@modelcontextprotocol/server-everything streamableHttp` on a random port,
 * waits for its "listening on port" stderr line, and drives the full
 * pipeline through `McpRegistryImpl` against the real Streamable-HTTP
 * endpoint at `/mcp`:
 *
 *   addServer(http) → approveServer (POST + SSE handshake) → approveTool
 *     → resolveTools → invoke echo → tear down with explicit terminateSession
 *
 * No mocks below the registry interface. Verifies the same contract the
 * stdio integration test pins, but over a TLS-shaped HTTP/JSON-RPC channel.
 */

const SERVER_EVERYTHING_PATH = require.resolve(
  "@modelcontextprotocol/server-everything/dist/index.js",
);

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr !== null) {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate port")));
      }
    });
  });
}

const dummySecrets: SecretsStore = mock<SecretsStore>();

let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleMcpStore;
let registry: McpRegistryImpl;
let serverProc: ChildProcess;
let serverUrl: string;

beforeAll(async () => {
  const port = await pickFreePort();
  serverUrl = `http://127.0.0.1:${port}/mcp`;

  serverProc = spawn(process.execPath, [SERVER_EVERYTHING_PATH, "streamableHttp"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server-everything did not become ready in 15s")),
      15_000,
    );
    // Accumulate stderr — the readiness banner could land split across two
    // `data` events, in which case a per-chunk substring check would silently
    // miss it and the test would hang to the 15s timeout.
    let stderrBuf = "";
    const onReady = (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.includes(`listening on port ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    serverProc.stderr?.on("data", onReady);
    serverProc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server-everything exited before ready (code=${code})`));
    });
  });

  ({ tx, close } = await createTestDatabase());
  store = new DrizzleMcpStore();
  registry = new McpRegistryImpl({
    store,
    secrets: dummySecrets,
    runInTx: tx,
    runner: new HostRunner(),
    callTimeoutMs: 30_000,
    idleEvictionMs: 60_000,
    evictionIntervalMs: 0,
    toolBudget: 50,
  });
  await registry.start();
}, 30_000);

afterAll(async () => {
  await registry?.stop();
  await close?.();
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill("SIGTERM");
    // Give the process a moment to exit cleanly; force-kill if it doesn't.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        serverProc.kill("SIGKILL");
        resolve();
      }, 2_000);
      serverProc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});

describe("MCP HTTP end-to-end against server-everything streamableHttp", () => {
  it("approves the server, lists real tools, dispatches `echo` over HTTP", async () => {
    const server = await registry.addServer({
      name: "everything_http",
      config: {
        transport: "http",
        url: serverUrl,
        headers: {},
      },
      enabled: true,
    });

    await registry.approveServer(server.id);
    const refreshed = await tx((trx) => store.getServerById(trx, server.id));
    expect(refreshed?.approvalStatus).toBe("approved");

    const pins = await tx((trx) => store.getToolPins(trx, server.id));
    const pinNames = pins.map((p) => p.toolName);
    expect(pinNames).toContain("echo");
    expect(pins.length).toBeGreaterThan(1);
    expect(pins.every((p) => p.schemaHash.length === 64)).toBe(true);

    await registry.approveTool(server.id, "echo");
    const tools = await registry.resolveTools({ toolGlobs: ["mcp__everything_http__*"] });
    expect(tools.map((t) => t.name)).toEqual(["mcp__everything_http__echo"]);

    const echoSpec = tools[0]!;
    const result = await echoSpec.handler({ message: "hello http mcp" }, {} as never);
    expect(result).toMatch(/hello http mcp/);
  });
});
