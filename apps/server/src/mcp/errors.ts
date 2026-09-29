/**
 * Typed errors for the MCP module. Used at the registry boundary so the
 * Transport layer can route via `instanceof` checks rather than string-matching
 * on `Error.message` (which silently breaks the moment anyone reworders the
 * message).
 */

export class McpServerNotFoundError extends Error {
  readonly serverId: string;
  constructor(serverId: string) {
    super(`MCP server not found: ${serverId}`);
    this.name = "McpServerNotFoundError";
    this.serverId = serverId;
  }
}

export type McpPoolErrorCode = "server_not_found" | "server_unhealthy" | "evicted" | "pool_closed";

/** Why the connection pool gave a caller no connection. */
export class McpPoolError extends Error {
  readonly code: McpPoolErrorCode;
  constructor(code: McpPoolErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "McpPoolError";
  }
}

export class McpInvalidServerNameError extends Error {
  readonly invalidName: string;
  constructor(invalidName: string, message: string) {
    super(message);
    this.name = "McpInvalidServerNameError";
    this.invalidName = invalidName;
  }
}
