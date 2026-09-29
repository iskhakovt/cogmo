import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
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
  /**
   * Aborting `signal` abandons a spawn still under way: it closes what it
   * started and rejects once that is closed. After it resolves, the signal is
   * ignored.
   */
  spawn(
    server: McpServer,
    secrets: SecretsStore,
    runInTx: Transactor,
    signal: AbortSignal,
  ): Promise<McpConnection>;
}

const CLIENT_INFO = { name: "cogmo", version: "0.1.0" } as const;

/**
 * Phase A: spawn MCP servers as host subprocesses (no sandbox). Acceptable
 * because Phase A is dev-only / single-user and gated behind `/mcp` admin
 * commands the operator drives manually. Phase B introduces sandboxed
 * execution for untrusted servers — see `design/integrations/mcp.md`.
 */
export class HostRunner implements Runner {
  async spawn(
    server: McpServer,
    secrets: SecretsStore,
    runInTx: Transactor,
    signal: AbortSignal,
  ): Promise<McpConnection> {
    const transport = await createTransport(server.config, secrets, runInTx);
    signal.throwIfAborted();
    const client = new Client(CLIENT_INFO);
    const connection = new SdkMcpConnection(client, transport, server.name);
    // The MCP spec forbids cancelling `initialize`, so an abort closes the
    // connection, which fails the handshake, rather than reaching the SDK.
    const abandon = () => {
      connection.close().catch(() => {}); // awaited, and its failure logged, below
    };
    signal.addEventListener("abort", abandon, { once: true });
    try {
      await connection.connect();
    } catch (err) {
      // A failed or abandoned handshake may leave the transport half-open.
      await connection.close().catch((closeErr: unknown) => {
        logger.debug(
          { err: closeErr, mcpServer: server.name },
          "MCP close after a failed connect failed",
        );
      });
      signal.throwIfAborted();
      throw err;
    } finally {
      signal.removeEventListener("abort", abandon);
    }
    return connection;
  }
}
