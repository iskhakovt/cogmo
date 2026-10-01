import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ok } from "neverthrow";
import { z } from "zod";
import { reject, type ToolOutcome, type ToolSpec } from "../agent/tools.js";
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
    // Durable: an MCP tool call reaches an external system we don't control.
    // That buys replay-safety, not exactly-once — the body still runs at least
    // once, and a crash between the upstream mutation and Inngest recording the
    // step result re-runs it. Closing that would need the server to accept an
    // idempotency token, which the MCP tool contract has no slot for; the
    // `ToolCallContext` this handler could forward is available if one ever
    // does. See .claude/rules/inngest.md.
    durable: true,
    handler: async (input) => {
      const conn = await opts.pool.getConnection(opts.server.id);
      let result: unknown;
      try {
        result = await conn.callTool(opts.descriptor.name, input, {
          timeoutMs: opts.timeoutMs,
        });
      } catch (e) {
        if (isRefusedCall(e)) return reject(e.message);
        throw e;
      }
      return serializeCallToolResult(result);
    },
  };
}

/**
 * JSON-RPC codes that mean the server refused this call rather than the
 * connection failing: arguments it rejects, a tool it doesn't know, and the
 * SDK's per-call request timeout. A closed connection or a server-internal
 * error stays a throw.
 */
const REFUSED_CALL_CODES: ReadonlySet<number> = new Set([
  ErrorCode.InvalidParams,
  ErrorCode.MethodNotFound,
  ErrorCode.RequestTimeout,
]);

function isRefusedCall(e: unknown): e is McpError {
  return e instanceof McpError && REFUSED_CALL_CODES.has(e.code);
}

function descriptorToJsonSchema(descriptor: McpToolDescriptor): JsonSchema {
  // MCP tool input schemas are always JSON-Schema objects per the spec.
  // The descriptor shape preserves whatever fields the server declared
  // (properties, required, additionalProperties, etc.) — we just enforce
  // the type discriminator.
  const schema = descriptor.inputSchema;
  // The cast is structurally safe: `JsonSchema` is `{ type: "object";
  // [k: string]: unknown }`, the spread provides the index signature, and
  // the explicit `type: "object"` after the spread guarantees the literal
  // discriminator (TypeScript can't narrow the spread's index-signature
  // value back to the literal). Refactoring to a type guard would buy
  // nothing — the runtime invariant is the same.
  return { ...schema, type: "object" } as JsonSchema;
}

/** The parts of an MCP `CallToolResult` the adapter reads; other fields pass through. */
const CallToolResultSchema = z.object({
  content: z.array(z.looseObject({ type: z.unknown(), text: z.unknown() })).optional(),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});

/**
 * Convert an MCP `CallToolResult` to the agent loop's tool outcome. A result
 * flagged `isError` is the server rejecting the call, and rejects it.
 */
function serializeCallToolResult(result: unknown): ToolOutcome {
  const r = CallToolResultSchema.parse(result ?? {});

  if (r.isError) {
    const text = (r.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n")
      .trim();
    return reject(text || "MCP tool reported isError without textual content");
  }

  const textParts = (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .filter((t) => typeof t === "string");

  if (textParts.length > 0) return ok(textParts.join("\n"));
  if (r.structuredContent !== undefined) return ok(JSON.stringify(r.structuredContent));
  // TODO(phase-e): when MCP resources / image / audio content support lands,
  // route non-text content blocks through the LLM provider's native typed
  // ContentBlock instead of JSON-stringifying them here. This fallback is
  // intentionally lossy — the LLM gets the raw block array as JSON, which
  // is deterministic + safe but not useful for vision-style content.
  // Phase A unblocks dispatch; Phase E surfaces the rich types properly.
  if (r.content && r.content.length > 0) return ok(JSON.stringify(r.content));
  return ok("");
}
