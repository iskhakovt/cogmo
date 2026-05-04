import { and, count, eq, sql } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import {
  assertValidServerName,
  type McpServer,
  type McpServerApprovalStatus,
  type McpServerSpec,
  type McpServerStatus,
  type McpToolApprovalStatus,
  type McpToolPin,
  type ToolSchemaSnapshot,
} from "../config.js";
import { mcpServers, mcpServerTools } from "./schema.js";

// --- Interface ---

export interface McpStore {
  /** Insert a new server. Throws on duplicate name or invalid name shape. */
  addServer(spec: McpServerSpec): Promise<McpServer>;

  /** Delete a server by id. Cascades to tool pins. No-op if not found. */
  removeServer(id: string): Promise<void>;

  /** Get a server by id. */
  getServerById(id: string): Promise<McpServer | undefined>;

  /** Get a server by unique name. */
  getServerByName(name: string): Promise<McpServer | undefined>;

  /** All servers, ordered by name. */
  listServers(): Promise<readonly McpServer[]>;

  /**
   * All servers with tool counts. Heavier than `listServers` — runs an extra
   * aggregation per call. Used for `/mcp list` admin output, not the hot path.
   */
  listServerStatuses(): Promise<readonly McpServerStatus[]>;

  /** Enabled servers only, ordered by name. Hot path: called from resolveTools. */
  listEnabledServers(): Promise<readonly McpServer[]>;

  setEnabled(id: string, enabled: boolean): Promise<void>;

  setServerApprovalStatus(id: string, status: McpServerApprovalStatus): Promise<void>;

  recordLastConnected(id: string, at: Date): Promise<void>;

  recordLastError(id: string, error: string): Promise<void>;

  /** Replace (or insert) a tool pin. The unique (server_id, tool_name) drives upsert. */
  upsertToolPin(params: {
    serverId: string;
    toolName: string;
    schemaHash: string;
    schemaSnapshot: ToolSchemaSnapshot;
    approvalStatus: McpToolApprovalStatus;
  }): Promise<McpToolPin>;

  /** All pins for a server, ordered by tool name. */
  getToolPins(serverId: string): Promise<readonly McpToolPin[]>;

  /** All approved pins for a server, ordered by tool name. Hot path. */
  getApprovedToolPins(serverId: string): Promise<readonly McpToolPin[]>;

  setToolApproval(serverId: string, toolName: string, status: McpToolApprovalStatus): Promise<void>;

  /** Remove a single pin (when a tool disappears from the server's listTools). */
  deleteToolPin(serverId: string, toolName: string): Promise<void>;
}

// --- Implementation ---

export class DrizzleMcpStore implements McpStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async addServer(spec: McpServerSpec): Promise<McpServer> {
    assertValidServerName(spec.name);
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(mcpServers)
          .values({
            name: spec.name,
            config: spec.config,
            enabled: spec.enabled,
            approvalStatus: "pending",
          })
          .returning(),
      );
      return rowToServer(row);
    });
  }

  async removeServer(id: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(mcpServers).where(eq(mcpServers.id, id));
    });
  }

  async getServerById(id: string): Promise<McpServer | undefined> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
      const row = rows[0];
      return row ? rowToServer(row) : undefined;
    });
  }

  async getServerByName(name: string): Promise<McpServer | undefined> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(mcpServers).where(eq(mcpServers.name, name)).limit(1);
      const row = rows[0];
      return row ? rowToServer(row) : undefined;
    });
  }

  async listServers(): Promise<readonly McpServer[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(mcpServers).orderBy(mcpServers.name);
      return rows.map(rowToServer);
    });
  }

  async listServerStatuses(): Promise<readonly McpServerStatus[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({
          server: mcpServers,
          toolCount: count(mcpServerTools.id),
          approvedToolCount: sql<number>`count(*) filter (where ${mcpServerTools.approvalStatus} = 'approved')`,
        })
        .from(mcpServers)
        .leftJoin(mcpServerTools, eq(mcpServerTools.serverId, mcpServers.id))
        .groupBy(mcpServers.id)
        .orderBy(mcpServers.name);
      return rows.map((r) => ({
        ...rowToServer(r.server),
        toolCount: Number(r.toolCount),
        approvedToolCount: Number(r.approvedToolCount),
      }));
    });
  }

  async listEnabledServers(): Promise<readonly McpServer[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.enabled, true))
        .orderBy(mcpServers.name);
      return rows.map(rowToServer);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(mcpServers).set({ enabled }).where(eq(mcpServers.id, id));
    });
  }

  async setServerApprovalStatus(id: string, status: McpServerApprovalStatus): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(mcpServers).set({ approvalStatus: status }).where(eq(mcpServers.id, id));
    });
  }

  async recordLastConnected(id: string, at: Date): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(mcpServers)
        .set({ lastConnectedAt: at, lastError: null })
        .where(eq(mcpServers.id, id));
    });
  }

  async recordLastError(id: string, error: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(mcpServers).set({ lastError: error }).where(eq(mcpServers.id, id));
    });
  }

  async upsertToolPin(params: {
    serverId: string;
    toolName: string;
    schemaHash: string;
    schemaSnapshot: ToolSchemaSnapshot;
    approvalStatus: McpToolApprovalStatus;
  }): Promise<McpToolPin> {
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(mcpServerTools)
          .values({
            serverId: params.serverId,
            toolName: params.toolName,
            schemaHash: params.schemaHash,
            schemaSnapshot: params.schemaSnapshot,
            approvalStatus: params.approvalStatus,
          })
          .onConflictDoUpdate({
            target: [mcpServerTools.serverId, mcpServerTools.toolName],
            set: {
              schemaHash: params.schemaHash,
              schemaSnapshot: params.schemaSnapshot,
              approvalStatus: params.approvalStatus,
            },
          })
          .returning(),
      );
      return rowToToolPin(row);
    });
  }

  async getToolPins(serverId: string): Promise<readonly McpToolPin[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(mcpServerTools)
        .where(eq(mcpServerTools.serverId, serverId))
        .orderBy(mcpServerTools.toolName);
      return rows.map(rowToToolPin);
    });
  }

  async getApprovedToolPins(serverId: string): Promise<readonly McpToolPin[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(mcpServerTools)
        .where(
          and(eq(mcpServerTools.serverId, serverId), eq(mcpServerTools.approvalStatus, "approved")),
        )
        .orderBy(mcpServerTools.toolName);
      return rows.map(rowToToolPin);
    });
  }

  async setToolApproval(
    serverId: string,
    toolName: string,
    status: McpToolApprovalStatus,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(mcpServerTools)
        .set({ approvalStatus: status })
        .where(and(eq(mcpServerTools.serverId, serverId), eq(mcpServerTools.toolName, toolName)));
    });
  }

  async deleteToolPin(serverId: string, toolName: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .delete(mcpServerTools)
        .where(and(eq(mcpServerTools.serverId, serverId), eq(mcpServerTools.toolName, toolName)));
    });
  }
}

// --- Row mappers ---

function rowToServer(row: typeof mcpServers.$inferSelect): McpServer {
  return {
    id: row.id,
    name: row.name,
    config: row.config,
    enabled: row.enabled,
    approvalStatus: row.approvalStatus,
    lastConnectedAt: row.lastConnectedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

function rowToToolPin(row: typeof mcpServerTools.$inferSelect): McpToolPin {
  return {
    id: row.id,
    serverId: row.serverId,
    toolName: row.toolName,
    schemaHash: row.schemaHash,
    schemaSnapshot: row.schemaSnapshot,
    approvalStatus: row.approvalStatus,
    createdAt: row.createdAt,
  };
}
