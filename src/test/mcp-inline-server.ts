import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { Transactor } from "../db/index.js";
import { type McpConnection, SdkMcpConnection } from "../mcp/client/client.js";
import type { Runner } from "../mcp/client/runner.js";
import type { McpServer as DomainMcpServer } from "../mcp/config.js";
import type { SecretsStore } from "../secrets/store/index.js";

/**
 * In-process MCP server exposing a single `echo` tool with a stable schema,
 * for use in LLM-driven integration tests. Built on
 * `InMemoryTransport.createLinkedPair()` — no subprocess, no readiness
 * probe, no fixture drift from upstream server-everything bumps.
 *
 * Returns a {@link Runner} that the registry's pool spawns once on first
 * connection request, plus a `close()` to shut both sides down on test
 * teardown. The MCP server is constructed once and shared across spawns;
 * the pool's lazy-connect + cached-connection pattern means a single
 * spawn covers a whole test.
 */
export async function createInlineMcpEchoRunner(): Promise<{
  runner: Runner;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: "cogmo-test-mcp", version: "0.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo the input string back unchanged. Use this to verify connectivity.",
      inputSchema: { message: z.string().describe("The message to echo back") },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `Echo: ${message}` }],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const runner: Runner = {
    async spawn(
      _server: DomainMcpServer,
      _secrets: SecretsStore,
      _runInTx: Transactor,
    ): Promise<McpConnection> {
      // One linked pair per test run is sufficient — the pool caches the
      // returned connection and only re-spawns on transport close, which
      // never happens for an in-memory transport during a test.
      const client = new Client({ name: "cogmo-test-client", version: "0.0.0" });
      const connection = new SdkMcpConnection(client, clientTransport as Transport);
      await connection.connect();
      return connection;
    },
  };

  return {
    runner,
    close: async () => {
      await server.close();
    },
  };
}
