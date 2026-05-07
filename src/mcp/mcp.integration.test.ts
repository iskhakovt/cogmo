import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase } from "../test/pglite.js";
import { HostRunner } from "./client/runner.js";
import { McpRegistryImpl } from "./registry.js";
import { DrizzleMcpStore } from "./store/index.js";

/**
 * End-to-end integration test against `@modelcontextprotocol/server-everything`,
 * the official reference MCP server (npm package, devDep). Exercises the full
 * Phase A pipeline against a real subprocess + real SDK handshake:
 *
 *   addServer → approveServer (listTools + pin) → approveTool → resolveTools
 *     → invoke a tool through the registry → tear down.
 *
 * No mocks below the registry interface — `HostRunner`, `StdioClientTransport`,
 * SDK `Client`, and the real MCP server process are all live.
 */

const SERVER_EVERYTHING_PATH = require.resolve(
  "@modelcontextprotocol/server-everything/dist/index.js",
);

const dummySecrets = {
  getSecret: async () => undefined,
  // Only getSecret is used by the transport; the rest are absent because the
  // store interface methods we don't invoke are inaccessible at the type
  // level when we cast through `unknown`.
} as unknown as SecretsStore;

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleMcpStore;
let registry: McpRegistryImpl;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleMcpStore(tx);
  registry = new McpRegistryImpl({
    store,
    secrets: dummySecrets,
    runner: new HostRunner(),
    callTimeoutMs: 30_000,
    idleEvictionMs: 60_000,
    evictionIntervalMs: 0,
    toolBudget: 50,
  });
  await registry.start();
});

afterAll(async () => {
  await registry.stop();
  await close();
});

describe("MCP end-to-end against server-everything", () => {
  it("approves the server, lists real tools, dispatches `echo`, and round-trips the result", async () => {
    const server = await registry.addServer({
      name: "everything",
      config: {
        transport: "stdio",
        command: process.execPath, // `node`
        args: [SERVER_EVERYTHING_PATH, "stdio"],
        env: {},
      },
      enabled: true,
    });

    // approveServer handshakes, lists tools, and pins them as `pending`.
    await registry.approveServer(server.id);
    const refreshed = await store.getServerById(server.id);
    expect(refreshed?.approvalStatus).toBe("approved");

    const pins = await store.getToolPins(server.id);
    const pinNames = pins.map((p) => p.toolName);
    // server-everything exposes a moving set of demo tools across releases;
    // assert only the one we round-trip below, plus invariants over the rest.
    expect(pinNames).toContain("echo");
    expect(pins.length).toBeGreaterThan(1);
    expect(pins.every((p) => p.approvalStatus === "pending")).toBe(true);
    expect(pins.every((p) => p.schemaHash.length === 64)).toBe(true);

    // Approve `echo` only, then resolve.
    await registry.approveTool(server.id, "echo");
    const tools = await registry.resolveTools({ toolGlobs: ["mcp__everything__*"] });
    expect(tools.map((t) => t.name)).toEqual(["mcp__everything__echo"]);

    const echoSpec = tools[0]!;
    expect(echoSpec.durable).toBe(true);
    expect(echoSpec.inputSchema.type).toBe("object");

    // Dispatch the tool through the spec's handler. The registry's pool
    // re-uses the connection that approveServer opened.
    const result = await echoSpec.handler({ message: "hello mcp" }, {} as never);
    expect(result).toMatch(/hello mcp/);
  });

  it("removeServer evicts the pool entry and the row", async () => {
    const server = await registry.addServer({
      name: "everything_temp",
      config: {
        transport: "stdio",
        command: process.execPath,
        args: [SERVER_EVERYTHING_PATH, "stdio"],
        env: {},
      },
      enabled: true,
    });
    await registry.approveServer(server.id);
    await registry.removeServer(server.id);
    expect(await store.getServerById(server.id)).toBeUndefined();
    // No pool sweep needed — evict closes the connection synchronously.
  });
});
