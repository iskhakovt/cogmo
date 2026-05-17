/**
 * Provider-agnostic LLM types.
 *
 * These are our canonical representations — domain code only touches these.
 * Each provider adapter translates to/from its SDK types.
 *
 * Content blocks and messages are defined as Zod schemas (single source of
 * truth) with TypeScript types derived via `z.infer`. This enables runtime
 * validation on DB writes without maintaining two representations.
 */

import { z } from "zod";

// --- Content blocks (Zod → inferred types) ---

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});

const ImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.enum(["base64", "url"]),
  data: z.string(),
  mediaType: z.string(),
});

const DocumentBlockSchema = z.object({
  type: z.literal("document"),
  source: z.enum(["base64", "url"]),
  /** Base64 bytes (source=base64) or URL string (source=url). */
  data: z.string(),
  mediaType: z.string(),
  /** Original filename — surfaced to the model and used by adapters for outbound display. */
  name: z.string().optional(),
});

const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  /** Opaque signature for multi-turn thinking continuity (Anthropic). Must be preserved in history. */
  signature: z.string(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  DocumentBlockSchema,
  ThinkingBlockSchema,
]);

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type DocumentBlock = z.infer<typeof DocumentBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// --- Messages ---

export const MessageContentSchema = z.union([z.string(), z.array(ContentBlockSchema)]);

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

// --- Tools ---

/**
 * JSON Schema object describing tool input parameters.
 * Matches the subset used by both Anthropic and OpenAI.
 */
export interface JsonSchema {
  type: "object";
  // Optional fields explicitly include `| undefined` so Zod's `optional()`
  // output (which emits `T | undefined`) is assignable under
  // `exactOptionalPropertyTypes: true`. Runtime behaviour is identical —
  // serialisation drops undefined values either way.
  properties?: Record<string, unknown> | undefined;
  required?: string[] | undefined;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

// --- Response ---

/**
 * Why the model stopped generating.
 *
 * `refusal` is an explicit policy refusal — Anthropic's `stop_reason: "refusal"`
 * or OpenAI's `finish_reason: "content_filter"`. Class C in
 * `design/agent-resilience.md` treats this as a non-recoverable subtype:
 * the in-loop classifier immediately routes to a refusal-specific degraded
 * reply rather than retrying. The signal is best-effort and scoped to
 * Anthropic-direct + OpenAI-direct; OpenAI-compat shims (OpenRouter, Venice,
 * xAI) ride along when they happen to emit the same shape.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface LlmResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  model: string;
  usage: Usage;
}

// --- Stream events ---

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string; signature: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError?: boolean }
  | { type: "status"; message: string };

/**
 * Result of a streaming LLM call.
 *
 * `events` yields stream events as they arrive (text deltas, tool starts).
 * `response` resolves after the stream completes with final metadata.
 *
 * The provider adapter accumulates tool input deltas internally —
 * `tool_start` events always contain complete parsed input.
 */
export interface ChatStreamResult {
  events: AsyncIterable<StreamEvent>;
  response: Promise<{ stopReason: StopReason; model: string; usage: Usage }>;
}

// --- Structured output ---

export interface ResponseFormat {
  type: "json_schema";
  name: string;
  schema: JsonSchema;
}

// --- Chat params ---

export interface ChatParams {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** Enable extended thinking. Provider support varies — Anthropic native, others ignore. */
  thinking?: { budgetTokens: number };
  /** Request structured JSON output. Mutually exclusive with tools. */
  responseFormat?: ResponseFormat;
}

// --- Token counting ---

/** Same shape as ChatParams minus maxTokens — if you can chat(), you can count tokens for it. */
export type CountTokensParams = Omit<ChatParams, "maxTokens">;
