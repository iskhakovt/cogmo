import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

export const ECHO_TOOL_DESCRIPTION =
  "Echo the input string back unchanged. Use this to verify connectivity.";
export const ECHO_INPUT_SCHEMA = {
  message: z.string().describe("The message to echo back"),
};

/**
 * In-process MCP echo server reachable over Streamable HTTP. Boots in
 * vitest's `globalSetup` so every integration-test worker can reach it
 * through the production `HostRunner` — Inngest's connect-mode gateway
 * can route an `inbound/arrived` event to any connected worker, so the
 * MCP server has to be reachable from all of them.
 *
 * Stateless mode: each POST creates a fresh transport + server pair,
 * processes the request, and tears down. Echo has no cross-request state
 * to maintain, so stateless avoids session-tracking machinery.
 */
export async function startMcpEchoHttpServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }

    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;

      const server = new McpServer({ name: "cogmo-test-mcp", version: "0.0.0" });
      server.registerTool(
        "echo",
        { description: ECHO_TOOL_DESCRIPTION, inputSchema: ECHO_INPUT_SCHEMA },
        async ({ message }) => ({
          content: [{ type: "text", text: `Echo: ${message}` }],
        }),
      );

      // Stateless mode (no `sessionIdGenerator`): each request gets a fresh
      // transport + server. The SDK declares `sessionIdGenerator?: () => string`
      // and the option-bag setter narrows `undefined` out of the type under
      // `exactOptionalPropertyTypes`, so we omit the field instead of setting
      // it explicitly. The `as Transport` is the same SDK type-gap as on the
      // client side — `StreamableHTTPServerTransport` declares `onclose` as
      // `(() => void) | undefined` (getter/setter) while the `Transport`
      // interface declares `onclose?: () => void`; the two are equivalent at
      // runtime but `exactOptionalPropertyTypes: true` rejects the structural
      // match.
      const transport = new StreamableHTTPServerTransport({});
      await server.connect(transport as Transport);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(req, res, body);
    })().catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
            id: null,
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
