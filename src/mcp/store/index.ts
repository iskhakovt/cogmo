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

  /**
   * Update a single pin's approval status. Returns `true` if the row existed
   * and was updated, `false` if no pin exists for `(serverId, toolName)`.
   * Lets the caller distinguish "approved" from "silently no-oped" — Postgres
   * reports a zero-row UPDATE as success, so the void variant would let
   * `/mcp approve <name> <typo>` confirm to the operator with nothing changed.
   */
  setToolApproval(
    serverId: string,
    toolName: string,
    status: McpToolApprovalStatus,
  ): Promise<boolean>;

  /** Remove a single pin (when a tool disappears from the server's listTools). */
  deleteToolPin(serverId: string, toolName: string): Promise<void>;

  /**
   * Atomic counterpart to the per-row `upsertToolPin` / `deleteToolPin` /
   * `setServerApprovalStatus` triplet. In a single transaction:
   *   1. read existing pins for `serverId`,
   *   2. for each incoming snapshot — upsert with `approvalStatus = "pending"`
   *      unless the existing pin's `schemaHash` matches (in which case the
   *      prior approval status is preserved verbatim),
   *   3. delete pins for tool names that aren't in the incoming set,
   *   4. flip `mcp_servers.approval_status` to `"approved"`.
   *
   * Used by `approveServer` so a crash partway through can't leave the
   * server `pending` while pins are partially synced (or vice versa).
   */
  syncServerApproval(params: {
    serverId: string;
    snapshots: readonly {
      toolName: string;
      schemaHash: string;
      schemaSnapshot: ToolSchemaSnapshot;
    }[];
  }): Promise<void>;
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
  ): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const updated = await tx
        .update(mcpServerTools)
        .set({ approvalStatus: status })
        .where(and(eq(mcpServerTools.serverId, serverId), eq(mcpServerTools.toolName, toolName)))
        .returning({ id: mcpServerTools.id });
      return updated.length > 0;
    });
  }

  async deleteToolPin(serverId: string, toolName: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .delete(mcpServerTools)
        .where(and(eq(mcpServerTools.serverId, serverId), eq(mcpServerTools.toolName, toolName)));
    });
  }

  async syncServerApproval(params: {
    serverId: string;
    snapshots: readonly {
      toolName: string;
      schemaHash: string;
      schemaSnapshot: ToolSchemaSnapshot;
    }[];
  }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(mcpServerTools)
        .where(eq(mcpServerTools.serverId, params.serverId));
      const existingByName = new Map(existing.map((p) => [p.toolName, p]));
      const incomingNames = new Set(params.snapshots.map((s) => s.toolName));

      for (const snap of params.snapshots) {
        const prev = existingByName.get(snap.toolName);
        // Pinning rule: identical hash → preserve prior approval status; new
        // or mutated → pending. The operator must explicitly re-approve a
        // changed tool — we never silently transition pending → approved on
        // schema drift.
        const status: McpToolApprovalStatus =
          prev && prev.schemaHash === snap.schemaHash ? prev.approvalStatus : "pending";
        await tx
          .insert(mcpServerTools)
          .values({
            serverId: params.serverId,
            toolName: snap.toolName,
            schemaHash: snap.schemaHash,
            schemaSnapshot: snap.schemaSnapshot,
            approvalStatus: status,
          })
          .onConflictDoUpdate({
            target: [mcpServerTools.serverId, mcpServerTools.toolName],
            set: {
              schemaHash: snap.schemaHash,
              schemaSnapshot: snap.schemaSnapshot,
              approvalStatus: status,
            },
          });
      }

      for (const pin of existing) {
        if (!incomingNames.has(pin.toolName)) {
          await tx
            .delete(mcpServerTools)
            .where(
              and(
                eq(mcpServerTools.serverId, params.serverId),
                eq(mcpServerTools.toolName, pin.toolName),
              ),
            );
        }
      }

      await tx
        .update(mcpServers)
        .set({ approvalStatus: "approved" })
        .where(eq(mcpServers.id, params.serverId));
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
