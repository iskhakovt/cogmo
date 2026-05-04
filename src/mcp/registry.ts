import type { ToolSpec } from "../agent/tools.js";
import { logger } from "../logger.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { mcpDescriptorToToolSpec } from "./adapter.js";
import { hashToolSchema } from "./approval.js";
import { McpConnectionPool } from "./client/pool.js";
import type { Runner } from "./client/runner.js";
import {
  compileToolMatchers,
  composeMcpToolName,
  type McpServer,
  type McpServerSpec,
  type McpServerStatus,
  type McpToolApprovalStatus,
} from "./config.js";
import type { McpStore } from "./store/index.js";

export interface ResolveToolsParams {
  /** picomatch-compatible globs from `profile.toolSet`. Empty array = no MCP tools surfaced. */
  toolGlobs: readonly string[];
  /** Override the registry's default tool budget for this call. */
  budget?: number;
}

export interface McpRegistry {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Build the per-turn MCP tool list. Surfaces a tool only when:
   *   1. its server is `enabled` AND `approval_status = approved`,
   *   2. its pin's `approval_status = approved`,
   *   3. its composed name (`mcp__<server>__<tool>`) matches one of the globs,
   *   4. it survives the alphabetical-cap at `budget` (or the registry default).
   */
  resolveTools(params: ResolveToolsParams): Promise<readonly ToolSpec[]>;

  addServer(spec: McpServerSpec): Promise<McpServer>;
  removeServer(id: string): Promise<void>;
  listServers(): Promise<readonly McpServerStatus[]>;
  /**
   * Connect, refresh the tool pin set against the server's current `listTools`
   * (added → pending; mutated → pending; removed → deleted; unchanged → keep
   * existing approval status), and flip the server's own approval to
   * `approved`. Per-tool approval still requires `approveTool`.
   *
   * Resets any prior `unhealthy` pool state — operator action implies the
   * intent to retry.
   */
  approveServer(id: string): Promise<void>;
  approveTool(serverId: string, toolName: string): Promise<void>;
  rejectTool(serverId: string, toolName: string): Promise<void>;
}

export interface McpRegistryOptions {
  store: McpStore;
  secrets: SecretsStore;
  runner: Runner;
  /** Per-call timeout for tool dispatch (ms). */
  callTimeoutMs: number;
  /** Idle eviction threshold (ms) — live connections idle longer get closed. */
  idleEvictionMs: number;
  /** How often the idle sweep runs (ms). Set to 0 to disable. */
  evictionIntervalMs: number;
  /** Maximum MCP tools surfaced per `resolveTools` call. */
  toolBudget: number;
}

export class McpRegistryImpl implements McpRegistry {
  #store: McpStore;
  #pool: McpConnectionPool;
  #callTimeoutMs: number;
  #toolBudget: number;

  constructor(opts: McpRegistryOptions) {
    this.#store = opts.store;
    this.#callTimeoutMs = opts.callTimeoutMs;
    this.#toolBudget = opts.toolBudget;
    this.#pool = new McpConnectionPool({
      store: opts.store,
      secrets: opts.secrets,
      runner: opts.runner,
      idleEvictionMs: opts.idleEvictionMs,
      evictionIntervalMs: opts.evictionIntervalMs,
    });
  }

  async start(): Promise<void> {
    // Connections are lazy; nothing to warm up. Reserved hook for future
    // eager-connect of latency-sensitive servers.
  }

  async stop(): Promise<void> {
    await this.#pool.close();
  }

  async resolveTools(params: ResolveToolsParams): Promise<readonly ToolSpec[]> {
    const matcher = compileToolMatchers(params.toolGlobs);
    if (params.toolGlobs.length === 0) return [];

    const enabled = await this.#store.listEnabledServers();
    const approvedServers = enabled.filter((s) => s.approvalStatus === "approved");

    const tools: ToolSpec[] = [];
    for (const server of approvedServers) {
      const pins = await this.#store.getApprovedToolPins(server.id);
      for (const pin of pins) {
        const composed = composeMcpToolName(server.name, pin.toolName);
        if (!matcher(composed)) continue;
        tools.push(
          mcpDescriptorToToolSpec({
            server,
            descriptor: {
              name: pin.toolName,
              description: pin.schemaSnapshot.description,
              inputSchema: pin.schemaSnapshot.inputSchema,
            },
            pool: this.#pool,
            timeoutMs: this.#callTimeoutMs,
          }),
        );
      }
    }

    tools.sort((a, b) => a.name.localeCompare(b.name));
    const budget = params.budget ?? this.#toolBudget;
    if (tools.length > budget) {
      const dropped = tools.slice(budget).map((t) => t.name);
      logger.warn(
        { dropped, budget, total: tools.length },
        "MCP tool budget exceeded; dropping alphabetically",
      );
      tools.length = budget;
    }
    return tools;
  }

  async addServer(spec: McpServerSpec): Promise<McpServer> {
    return this.#store.addServer(spec);
  }

  async removeServer(id: string): Promise<void> {
    await this.#pool.evict(id);
    await this.#store.removeServer(id);
  }

  async listServers(): Promise<readonly McpServerStatus[]> {
    return this.#store.listServerStatuses();
  }

  async approveServer(id: string): Promise<void> {
    const server = await this.#store.getServerById(id);
    if (!server) throw new Error(`MCP server not found: ${id}`);

    // Operator action — clear any prior unhealthy state so connect retries.
    this.#pool.reset(id);

    const conn = await this.#pool.getConnection(id);
    const tools = await conn.listTools();
    const existingPins = await this.#store.getToolPins(server.id);
    const existingByName = new Map(existingPins.map((p) => [p.toolName, p]));
    const incomingNames = new Set(tools.map((t) => t.name));

    for (const tool of tools) {
      const snapshot = { description: tool.description, inputSchema: tool.inputSchema };
      const hash = hashToolSchema(snapshot);
      const existing = existingByName.get(tool.name);
      // Schema-pinning rule: unchanged → preserve prior status; new or mutated
      // → pending (operator must re-approve). We never silently approve a
      // changed schema.
      const status: McpToolApprovalStatus =
        existing && existing.schemaHash === hash ? existing.approvalStatus : "pending";
      await this.#store.upsertToolPin({
        serverId: server.id,
        toolName: tool.name,
        schemaHash: hash,
        schemaSnapshot: snapshot,
        approvalStatus: status,
      });
    }

    for (const pin of existingPins) {
      if (!incomingNames.has(pin.toolName)) {
        await this.#store.deleteToolPin(server.id, pin.toolName);
      }
    }

    await this.#store.setServerApprovalStatus(server.id, "approved");
  }

  async approveTool(serverId: string, toolName: string): Promise<void> {
    await this.#store.setToolApproval(serverId, toolName, "approved");
  }

  async rejectTool(serverId: string, toolName: string): Promise<void> {
    await this.#store.setToolApproval(serverId, toolName, "rejected");
  }
}
