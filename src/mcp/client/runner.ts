import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { McpServer } from "../config.js";
import { type McpConnection, SdkMcpConnection } from "./client.js";
import { createTransport } from "./transport.js";

/**
 * Spawns an MCP server in some execution environment (host, sysbox, …) and
 * returns a connection. Phase A ships only `HostRunner`. Phase B introduces
 * `SysboxRunner` for `untrusted` servers; the registry will route based on
 * a code-level trust allowlist.
 */
export interface Runner {
  spawn(server: McpServer, secrets: SecretsStore): Promise<McpConnection>;
}

const CLIENT_INFO = { name: "cogmo", version: "0.1.0" } as const;

/**
 * Phase A: spawn MCP servers as host subprocesses (no sandbox). Acceptable
 * because Phase A is dev-only / single-user and gated behind `/mcp` admin
 * commands the operator drives manually. Phase B introduces sandboxed
 * execution for untrusted servers — see `design/integrations/mcp.md`.
 */
export class HostRunner implements Runner {
  async spawn(server: McpServer, secrets: SecretsStore): Promise<McpConnection> {
    const transport = await createTransport(server.config, secrets);
    const client = new Client(CLIENT_INFO);
    const connection = new SdkMcpConnection(client, transport);
    try {
      await connection.connect();
    } catch (err) {
      // If connect() failed, the transport may be half-open. Best effort cleanup.
      await connection.close().catch(() => {});
      throw err;
    }
    return connection;
  }
}
