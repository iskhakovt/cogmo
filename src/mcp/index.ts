// Public exports for the MCP client module.
export { mcpDescriptorToToolSpec } from "./adapter.js";
export type { PinDiff } from "./approval.js";
export { diffPins, hashToolSchema } from "./approval.js";
export type { McpConnection } from "./client/client.js";
export {
  McpConnectionPool,
  type McpConnectionPoolOptions,
  McpPoolError,
  type McpPoolErrorCode,
} from "./client/pool.js";
export { HostRunner, type Runner } from "./client/runner.js";
export {
  assertValidServerName,
  composeMcpToolName,
  MCP_TOOL_NAME_PREFIX,
  type McpServer,
  type McpServerApprovalStatus,
  McpServerConfigSchema,
  type McpServerSpec,
  type McpServerStatus,
  type McpToolApprovalStatus,
  type McpToolDescriptor,
  type McpToolPin,
  type McpTransportKind,
  type McpValueSource,
  McpValueSourceSchema,
  ToolSchemaSnapshotSchema,
} from "./config.js";
export {
  type McpRegistry,
  McpRegistryImpl,
  type McpRegistryOptions,
  type ResolveToolsParams,
} from "./registry.js";
export { DrizzleMcpStore, type McpStore } from "./store/index.js";
