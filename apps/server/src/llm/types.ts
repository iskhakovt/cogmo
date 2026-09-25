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
 *
 * `context_overflow` is input-plus-output overrunning the model's context
 * window — Anthropic's `stop_reason: "model_context_window_exceeded"`. It is
 * deliberately separate from `max_tokens`: `max_tokens` is a *budget* stop
 * (there is room left in the window, the output cap was hit), so a partial
 * text reply is worth keeping and a follow-up turn can complete the thought,
 * whereas `context_overflow` means there is no room left at all, so
 * appending anything to the request guarantees the identical failure.
 * `classifyPostStream` marks the first as truncated (or degrades it, when
 * there is no text to keep or a tool call may be cut off) and routes the
 * second straight to the degraded off-ramp.
 * Providers without a distinct overflow signal (the OpenAI wire format folds
 * it into `finish_reason: "length"`) never produce this value.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "context_overflow";

/**
 * Token usage of one LLM call.
 *
 * `inputTokens` is the total prompt size. `cacheReadTokens` and
 * `cacheCreationTokens` are subsets of it, never in addition to it — the
 * convention of the OpenTelemetry GenAI attributes. Adapters whose wire format
 * reports only the uncached remainder (Anthropic's `input_tokens`) add the
 * cache fields back in. Present only when the provider reports them.
 */
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

/**
 * Events the agent loop and orchestrator push at the delivery layer.
 *
 * Most members mirror what a provider stream yields, but the union is the
 * orchestrator→adapter presentation channel, not a pure provider transcript:
 * `status` is emitted by the pre-flight compaction stage, and `retract` by the
 * degraded off-ramp.
 *
 * `retract` names the streamed assistant output that the turn is NOT going to
 * persist, so the user is never left reading something the transcript doesn't
 * contain. The orchestrator emits it immediately before the degraded reply:
 * `text` is the exact streamed text the loop dropped from the turn's messages
 * — always the tail, since the degrade-triggering iteration is the last one —
 * and `toolUseIds` are that same iteration's tool calls, which on a
 * `context_overflow` or `refusal` degrade never even executed. Output from
 * earlier iterations of the turn is deliberately NOT named: those messages are
 * persisted, so they stay on screen. See design/agent-resilience.md → Degraded
 * reply.
 *
 * Attachments already delivered mid-stream (`sendPhoto`, `sendDocument`) can't
 * be taken back and are never named. Adapters apply the retraction to whatever
 * is still editable — output already committed to an immutable surface (a
 * Telegram chunk that overflowed into its own message) stays visible.
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string; signature: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError?: boolean }
  | { type: "status"; message: string }
  | { type: "retract"; text: string; toolUseIds: ReadonlyArray<string> };

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

/**
 * Says that this request's transcript will be sent again, extended, and is
 * worth caching. Provider-neutral: each adapter decides what it means on the
 * wire (see design/prompt-caching.md → Cache Intent). Set only by callers that
 * re-send a transcript — the agent loop's callers; a one-shot call caching its
 * tail pays the write premium on tokens nothing reads back.
 */
export interface CacheIntent {
  /** Stable per transcript — the conversation id. Routing / accounting key. */
  key: string;
  /** "short" ≈ minutes between requests; "long" ≈ a human reply gap. */
  retention: "short" | "long";
}

export interface ChatParams {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** Request structured JSON output. Mutually exclusive with tools. */
  responseFormat?: ResponseFormat;
  /**
   * Sampling temperature. Provider default when unset (typically 1.0).
   * Set to 0 for deterministic / low-variance output — the degraded-reply
   * synthesis in `src/agent/repair.ts` is the one caller today.
   *
   * Best-effort, not a guarantee: the Anthropic Messages API rejects
   * sampling parameters outright, so `AnthropicProvider` drops this and
   * logs once per model. OpenAI-compatible providers honour it — range
   * is 0–2 there, so stick to 0–1 for portability across a fallback
   * chain that may span both.
   */
  temperature?: number;
  /** Cache the transcript for the next request. Adapters without a mapping ignore it. */
  cache?: CacheIntent;
}

// --- Token counting ---

/** Same shape as ChatParams minus maxTokens — if you can chat(), you can count tokens for it. */
export type CountTokensParams = Omit<ChatParams, "maxTokens">;
