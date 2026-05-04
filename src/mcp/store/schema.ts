import { boolean, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../db/helpers.js";
import { McpServerConfigSchema, ToolSchemaSnapshotSchema } from "../config.js";

export const mcpServerApprovalStatus = pgEnum("mcp_server_approval_status", [
  "pending",
  "approved",
  "needs_reapproval",
]);

export const mcpToolApprovalStatus = pgEnum("mcp_tool_approval_status", [
  "pending",
  "approved",
  "rejected",
]);

/**
 * One row per configured MCP server. `config` is a discriminated union
 * over `transport` (stdio / http / sse) — the discriminator lives inside
 * the JSONB blob, not as a separate column. `jsonbZod` validates the full
 * shape at the store boundary on every read and write.
 *
 * Tool exposure is gated through two fields:
 * - `enabled` — operator toggle without delete.
 * - `approval_status` — `pending` until the operator approves the listed
 *   tools; flips to `needs_reapproval` when a server's tool schemas drift
 *   from the pinned hashes.
 */
export const mcpServers = pgTable("mcp_servers", {
  id: pk(),
  name: text("name").notNull().unique(),
  config: jsonbZod("config", McpServerConfigSchema).notNull(),
  enabled: boolean("enabled").notNull(),
  approvalStatus: mcpServerApprovalStatus("approval_status").notNull(),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: ts(),
});

/**
 * One row per tool exposed by an MCP server. `schema_hash` is sha256 of the
 * pinned `{description, inputSchema}` snapshot — recomputed each time we
 * `listTools` and diffed against the row to detect rug-pull. Cascades on
 * server delete so removing a server cleans up its pins.
 */
export const mcpServerTools = pgTable(
  "mcp_server_tools",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    schemaHash: text("schema_hash").notNull(),
    schemaSnapshot: jsonbZod("schema_snapshot", ToolSchemaSnapshotSchema).notNull(),
    approvalStatus: mcpToolApprovalStatus("approval_status").notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_mcp_server_tool").on(t.serverId, t.toolName)],
);
