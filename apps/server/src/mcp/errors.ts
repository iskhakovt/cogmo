import { match } from "ts-pattern";
import { describeError } from "../util/describe-error.js";

/** Why the connection pool gave a caller no connection. */
export type McpPoolError =
  | { code: "server_not_found" }
  /** The last connects in a row failed; every call fails fast until `reset`. */
  | { code: "server_unhealthy"; lastError: string }
  /** The server was removed while the call waited. */
  | { code: "evicted" }
  | { code: "pool_closed" }
  /** Looking the server up, or spawning and handshaking with it, failed. */
  | { code: "connect_failed"; error: Error };

/** Why `addServer` created no server. */
export type McpAddServerError =
  | { code: "invalid_name"; name: string; reason: string }
  | { code: "name_taken"; name: string };

/** Why `approveServer` approved nothing. */
export type McpApproveServerError =
  | { code: "server_not_found"; serverId: string }
  | { code: "connection_failed"; serverId: string; reason: string };

/** Operator- and model-facing text for a pool failure. */
export function describeMcpPoolError(error: McpPoolError): string {
  return match(error)
    .with({ code: "server_not_found" }, () => "MCP server not found")
    .with({ code: "server_unhealthy" }, (e) => `MCP server is unhealthy: ${e.lastError}`)
    .with({ code: "evicted" }, () => "MCP server was removed")
    .with({ code: "pool_closed" }, () => "MCP connection pool is closed")
    .with({ code: "connect_failed" }, (e) => describeError(e.error))
    .exhaustive();
}
