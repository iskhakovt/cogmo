/**
 * Provider-agnostic LLM types.
 *
 * These are our canonical representations — domain code only touches these.
 * Each provider adapter translates to/from its SDK types.
 */

// --- Content blocks ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ImageBlock {
  type: "image";
  source: "base64" | "url";
  data: string; // base64-encoded bytes or URL string
  mediaType: string; // e.g. "image/jpeg", "image/png"
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Opaque signature for multi-turn thinking continuity (Anthropic). Must be preserved in history. */
  signature: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock;

// --- Messages ---

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// --- Tools ---

/**
 * JSON Schema object describing tool input parameters.
 * Matches the subset used by both Anthropic and OpenAI.
 */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

// --- Response ---

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

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
