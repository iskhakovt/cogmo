import { z } from "zod";
import { McpInvalidServerNameError } from "./errors.js";

// --- Value sources (literal or secret reference) ---

/**
 * Per-key value source for `env` and `headers` entries. Literals carry their
 * string value inline; secrets reference a row in the `secrets` table by name
 * and are resolved at spawn / request time. Mixed maps are allowed —
 * `NODE_ENV=production` sits next to `GITHUB_PERSONAL_ACCESS_TOKEN` from the
 * encrypted store.
 */
export const McpValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("secret"), name: z.string().min(1) }),
]);
export type McpValueSource = z.infer<typeof McpValueSourceSchema>;

const McpVarMapSchema = z.record(z.string().min(1), McpValueSourceSchema);

// --- Per-transport server config ---

const StdioConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: McpVarMapSchema,
});

const HttpConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: McpVarMapSchema,
});

const SseConfigSchema = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: McpVarMapSchema,
});

/**
 * Discriminated union over `transport`. The discriminator lives inside the
 * JSONB blob — there is no separate `transport` column on `mcp_servers`.
 * One source of truth; `jsonbZod` validates the full shape on every read
 * and write.
 */
export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  StdioConfigSchema,
  HttpConfigSchema,
  SseConfigSchema,
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpTransportKind = McpServerConfig["transport"];

// --- Tool schema pinning ---

/**
 * The portion of a tool definition we hash and pin against rug-pull. SDK
 * `Tool` objects carry additional metadata (annotations, etc.); we only
 * pin the fields the LLM actually sees.
 */
export const ToolSchemaSnapshotSchema = z.object({
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolSchemaSnapshot = z.infer<typeof ToolSchemaSnapshotSchema>;

// --- Approval status ---

export const McpServerApprovalStatusSchema = z.enum(["pending", "approved", "needs_reapproval"]);
export type McpServerApprovalStatus = z.infer<typeof McpServerApprovalStatusSchema>;

export const McpToolApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type McpToolApprovalStatus = z.infer<typeof McpToolApprovalStatusSchema>;

// --- Domain types (not stored shapes) ---

export interface McpServerSpec {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
}

/**
 * Boundary-input shape for `transport.mcp.addServer` — `config` is `unknown`
 * because the caller (Telegram /mcp add, future channels) hands us raw
 * `JSON.parse` output. The transport layer validates with
 * `McpServerConfigSchema` before constructing an `McpServerSpec` for the
 * registry / store layers.
 */
export interface McpServerSpecInput {
  name: string;
  config: unknown;
  enabled: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  approvalStatus: McpServerApprovalStatus;
  lastConnectedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface McpServerStatus extends McpServer {
  toolCount: number;
  approvedToolCount: number;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolPin {
  id: string;
  serverId: string;
  toolName: string;
  schemaHash: string;
  schemaSnapshot: ToolSchemaSnapshot;
  approvalStatus: McpToolApprovalStatus;
  createdAt: Date;
}

// --- Tool naming ---

export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * Regex enforcing the server-name shape — exported so command parsers can
 * pre-check at the boundary instead of relying on the schema's reject-with-
 * generic-error path.
 */
export const SERVER_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Server names must match {@link SERVER_NAME_RE}. The name appears inside
 * `mcp__<server>__<tool>` agent-facing identifiers; the separator between
 * server and tool is the literal `__`, so a server name containing `__`
 * would make the composed identifier ambiguous (e.g. `foo__bar` plus tool
 * `baz` is indistinguishable from server `foo` plus tool `bar__baz`).
 * Allowing single underscores between alphanumerics covers `google_calendar`
 * while disallowing leading, trailing, or consecutive underscores.
 */
export function assertValidServerName(name: string): void {
  if (!SERVER_NAME_RE.test(name)) {
    throw new McpInvalidServerNameError(
      name,
      `Invalid MCP server name: ${JSON.stringify(name)} — must match /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/`,
    );
  }
}

/** Compose the agent-facing tool name: `mcp__<server>__<tool>`. */
export function composeMcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${server}__${tool}`;
}
