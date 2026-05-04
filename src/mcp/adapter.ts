import type { ToolSpec } from "../agent/tools.js";
import type { JsonSchema } from "../llm/types.js";
import type { McpConnectionPool } from "./client/pool.js";
import { composeMcpToolName, type McpServer, type McpToolDescriptor } from "./config.js";

export interface McpToolAdapterOptions {
  server: McpServer;
  descriptor: McpToolDescriptor;
  pool: McpConnectionPool;
  /** Per-call timeout in ms, passed straight through to the SDK. */
  timeoutMs: number;
}

/**
 * Wrap an MCP tool descriptor as a `ToolSpec` the agent loop dispatches
 * through. The handler is `durable: true` — MCP servers are non-deterministic
 * (network / subprocess / external state), so Inngest step memoization gives
 * us exactly-once semantics under retry.
 */
export function mcpDescriptorToToolSpec(opts: McpToolAdapterOptions): ToolSpec {
  return {
    name: composeMcpToolName(opts.server.name, opts.descriptor.name),
    description: opts.descriptor.description,
    inputSchema: descriptorToJsonSchema(opts.descriptor),
    durable: true,
    handler: async (input) => {
      const conn = await opts.pool.getConnection(opts.server.id);
      const result = await conn.callTool(opts.descriptor.name, input, {
        timeoutMs: opts.timeoutMs,
      });
      return serializeCallToolResult(result);
    },
  };
}

function descriptorToJsonSchema(descriptor: McpToolDescriptor): JsonSchema {
  // MCP tool input schemas are always JSON-Schema objects per the spec.
  // The descriptor shape preserves whatever fields the server declared
  // (properties, required, additionalProperties, etc.) — we just enforce
  // the type discriminator.
  const schema = descriptor.inputSchema;
  return { ...schema, type: "object" } as JsonSchema;
}

interface CallToolResultLike {
  content?: ReadonlyArray<{ type?: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Convert an MCP `CallToolResult` to the string the agent loop appends as a
 * `tool_result`. Throws on `isError: true` — the agent loop's try/catch
 * wraps thrown errors as `isError` tool_result content blocks for the LLM.
 */
function serializeCallToolResult(result: unknown): string {
  const r = (result ?? {}) as CallToolResultLike;

  if (r.isError) {
    const text = (r.content ?? [])
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    throw new Error(text || "MCP tool reported isError without textual content");
  }

  const textParts = (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);

  if (textParts.length > 0) return textParts.join("\n");
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  if (r.content && r.content.length > 0) return JSON.stringify(r.content);
  return "";
}
