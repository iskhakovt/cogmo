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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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
}

export interface LlmResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  model: string;
  usage: Usage;
}

// --- Chat params ---

export interface ChatParams {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}
