/**
 * The MCP client registry, started once and shared by handle-message and
 * every channel's Transport.
 */

import { env } from "../env.js";
import { HostRunner as McpHostRunner } from "../mcp/client/runner.js";
import { McpRegistryImpl } from "../mcp/registry.js";
import type { CoreDeps } from "./stages.js";

/**
 * Single MCP registry shared by handle-message (per-turn `resolveTools`) and
 * every channel's Transport (admin `/mcp` operations). Constructed before
 * startChannels so the same connection pool is reused — duplicate registries
 * would each spawn their own subprocess on first use.
 */
export async function startMcpRegistry(core: CoreDeps): Promise<McpRegistryImpl> {
  const mcpRegistry = new McpRegistryImpl({
    store: core.mcpStore,
    secrets: core.secretsStore,
    runInTx: core.runInTx,
    runner: new McpHostRunner(),
    callTimeoutMs: env.MCP_CALL_TIMEOUT_MS,
    idleEvictionMs: env.MCP_IDLE_EVICTION_MS,
    toolBudget: env.MCP_TOOL_BUDGET,
  });
  await mcpRegistry.start();
  return mcpRegistry;
}
