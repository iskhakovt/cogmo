import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
} from "@opentelemetry/semantic-conventions/incubating";
import { llmTokens } from "../metrics.js";
import type { StopReason, Usage } from "./types.js";

const tracer = trace.getTracer("cogmo.llm");

/**
 * Open a `chat` span for an LLM call, tagged with the GenAI semantic
 * conventions (`gen_ai.*`). The caller is responsible for calling
 * `recordChatUsage` and `endChatSpan` once usage data is available — for
 * non-streaming `chat()` immediately after the response, for `chatStream()`
 * inside the generator just before resolving the response promise.
 */
export function startChatSpan(provider: string, model: string): Span {
  return tracer.startSpan("chat", {
    attributes: {
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      [ATTR_GEN_AI_PROVIDER_NAME]: provider,
      [ATTR_GEN_AI_REQUEST_MODEL]: model,
    },
  });
}

/**
 * Stamp usage attributes on a chat span and increment the token counter.
 * Safe to call multiple times — counter increments would double, so only
 * call once per LLM call.
 *
 * `usage.inputTokens` is the whole prompt, cache reads and writes included.
 * The span's `gen_ai.usage.input_tokens` carries that total, as the GenAI
 * conventions ask. The counter's `input` type takes only the uncached
 * remainder, so its four types stay disjoint and each is a billing category.
 */
export function recordChatUsage(
  span: Span,
  provider: string,
  responseModel: string,
  usage: Usage,
  stopReason: StopReason,
): void {
  span.setAttributes({
    [ATTR_GEN_AI_RESPONSE_MODEL]: responseModel,
    [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [stopReason],
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
    ...(usage.cacheReadTokens != null && {
      [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheReadTokens,
    }),
    ...(usage.cacheCreationTokens != null && {
      [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheCreationTokens,
    }),
  });

  const labels = { model: responseModel, provider };
  // Clamped: a provider reporting more cached tokens than prompt tokens would
  // otherwise hand a monotonic counter a negative increment.
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheCreationTokens ?? 0),
  );
  llmTokens.add(uncachedInput, { ...labels, type: "input" });
  llmTokens.add(usage.outputTokens, { ...labels, type: "output" });
  if (usage.cacheReadTokens) {
    llmTokens.add(usage.cacheReadTokens, { ...labels, type: "cache_read" });
  }
  if (usage.cacheCreationTokens) {
    llmTokens.add(usage.cacheCreationTokens, { ...labels, type: "cache_create" });
  }
}

export function failChatSpan(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : new Error(String(err)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
}
