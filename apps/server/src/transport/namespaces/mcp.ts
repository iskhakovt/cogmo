import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import {
  type McpServer,
  McpServerConfigSchema,
  type McpServerSpecInput,
  type McpServerStatus,
} from "../../mcp/config.js";
import type { McpRegistry } from "../../mcp/registry.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * MCP server admin surface. Identity-checked: every method takes a
 * `platformUserHandle` resolved against `user_identities`; unknown
 * handles get `identity_rejected`. Returns `mcp_disabled` when bootstrap
 * didn't wire an `McpRegistry` (no MCP servers configured).
 *
 * `addServer` validates the config via `McpServerConfigSchema` (returns
 * `mcp_invalid_config` on parse failure) and creates the row in
 * `pending` state. `approveServer` connects, snapshots tools, and flips
 * the server to `approved` in one transaction. `approveTool` /
 * `rejectTool` flip individual pin status.
 */
export interface McpNamespace {
  /**
   * Configured tool budget — the alphabetical drop cap applied per
   * `resolveTools` call. Surfaced sync (no Result wrapping, no ACL)
   * because it's static config the operator can already see in env vars.
   */
  toolBudget(): number;
  addServer(
    platformUserHandle: string,
    spec: McpServerSpecInput,
  ): Promise<Result<McpServer, TransportError>>;
  removeServer(platformUserHandle: string, serverId: string): Promise<Result<void, TransportError>>;
  listServers(
    platformUserHandle: string,
  ): Promise<Result<ReadonlyArray<McpServerStatus>, TransportError>>;
  approveServer(
    platformUserHandle: string,
    serverId: string,
  ): Promise<Result<void, TransportError>>;
  approveTool(
    platformUserHandle: string,
    serverId: string,
    toolName: string,
  ): Promise<Result<void, TransportError>>;
  rejectTool(
    platformUserHandle: string,
    serverId: string,
    toolName: string,
  ): Promise<Result<void, TransportError>>;
}

// Identity check runs FIRST in every method below (before the
// `mcp_disabled` short-circuit) so an unauthenticated handle can't
// probe whether MCP is wired in this deployment. `toolBudget` is the
// exception — static config, no auth gate.
export function createMcp(
  deps: Omit<TransportContext, "agentStore"> & { mcpRegistry: McpRegistry | undefined },
): McpNamespace {
  const { channelId, runInTx, transportStore, mcpRegistry } = deps;
  return {
    toolBudget() {
      return mcpRegistry?.toolBudget() ?? 0;
    },
    async addServer(platformUserHandle, spec) {
      const identity = await runInTx((tx) =>
        transportStore.resolveUser(tx, channelId, platformUserHandle),
      );
      if (!identity) return err({ code: "identity_rejected" as const });
      if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
      // Validate the config blob before any DB write so a malformed paste
      // surfaces a structured `mcp_invalid_config` instead of a Zod throw.
      const parsed = McpServerConfigSchema.safeParse(spec.config);
      if (!parsed.success) {
        return err({
          code: "mcp_invalid_config" as const,
          reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      }
      const added = await mcpRegistry.addServer({
        name: spec.name,
        config: parsed.data,
        enabled: spec.enabled,
      });
      return added.mapErr((e) =>
        match(e)
          .returnType<TransportError>()
          .with({ code: "name_taken" }, ({ name }) => ({ code: "mcp_server_name_taken", name }))
          .with({ code: "invalid_name" }, ({ reason }) => ({
            code: "mcp_invalid_config",
            reason,
          }))
          .exhaustive(),
      );
    },

    async removeServer(platformUserHandle, serverId) {
      const identity = await runInTx((tx) =>
        transportStore.resolveUser(tx, channelId, platformUserHandle),
      );
      if (!identity) return err({ code: "identity_rejected" as const });
      if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
      await mcpRegistry.removeServer(serverId);
      return ok(undefined);
    },

    async listServers(platformUserHandle) {
      const identity = await runInTx((tx) =>
        transportStore.resolveUser(tx, channelId, platformUserHandle),
      );
      if (!identity) return err({ code: "identity_rejected" as const });
      if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
      const servers = await mcpRegistry.listServers();
      return ok(servers);
    },

    async approveServer(platformUserHandle, serverId) {
      const identity = await runInTx((tx) =>
        transportStore.resolveUser(tx, channelId, platformUserHandle),
      );
      if (!identity) return err({ code: "identity_rejected" as const });
      if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
      const approved = await mcpRegistry.approveServer(serverId);
      return approved.mapErr((e) =>
        match(e)
          .returnType<TransportError>()
          .with({ code: "server_not_found" }, (f) => ({
            code: "mcp_server_not_found",
            serverId: f.serverId,
          }))
          .with({ code: "connection_failed" }, (f) => ({
            code: "mcp_connection_failed",
            serverId: f.serverId,
            reason: f.reason,
          }))
          .exhaustive(),
      );
    },

    async approveTool(platformUserHandle, serverId, toolName) {
      const identity = await runInTx((tx) =>
        transportStore.resolveUser(tx, channelId, platformUserHandle),
      );
      if (!identity) return err({ code: "identity_rejected" as const });
      if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
      const updated = await mcpRegistry.approveTool(serverId, toolName);
      if (!updated) return err({ code: "mcp_tool_not_found" as const, serverId, toolName });
      return ok(undefined);
    },

    async rejectTool(platformUserHandle, serverId, toolName) {
      const identity = await runInTx((tx) =>
        transportStore.resolveUser(tx, channelId, platformUserHandle),
      );
      if (!identity) return err({ code: "identity_rejected" as const });
      if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
      const updated = await mcpRegistry.rejectTool(serverId, toolName);
      if (!updated) return err({ code: "mcp_tool_not_found" as const, serverId, toolName });
      return ok(undefined);
    },
  };
}
