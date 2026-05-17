/**
 * Errors raised by the LLM provider layer that don't map onto an upstream
 * HTTP failure shape.
 *
 * SDK / HTTP failures keep their native shape ({@link Error} subclass with a
 * numeric `status`) — {@link FallbackLlmProvider} duck-types on `status` to
 * classify them. The errors here cover cases where the upstream response
 * arrived structurally intact but its payload is unusable downstream:
 * truncated tool-arg JSON, malformed streamed deltas, etc.
 */

import { jsonrepair } from "jsonrepair";

/**
 * The provider returned a syntactically intact response but its content
 * violates the wire contract — typically a tool-arg JSON stream that fails
 * to parse even after `jsonrepair`. Carries no `status` field so it does
 * not collide with the SDK's transient-error duck-type.
 *
 * Treated as **non-retriable** by {@link isRetriableProviderError}: trying
 * the next provider is unlikely to help (the model produced garbage; same
 * input to a different provider has no reason to do better) and we want the
 * error to propagate to the in-loop classifier so it can decide whether to
 * attempt repair or degrade.
 */
export class ProviderProtocolError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ProviderProtocolError";
  }
}

/**
 * Parse a JSON payload streamed by a provider (e.g. buffered tool-use
 * argument chunks). Try `JSON.parse` first; on failure, run `jsonrepair`
 * (handles trailing commas, unclosed strings within reason, missing
 * quotes) and parse again. If repair also fails, raise
 * {@link ProviderProtocolError} so the in-loop classifier owns the
 * recovery decision instead of the provider chain misclassifying a bare
 * `SyntaxError`.
 *
 * `context` identifies the call site in the resulting error message
 * (e.g. "Anthropic streamed tool_use input", "OpenAI-compatible streamed
 * tool_calls arguments") so failures point at the right adapter without
 * the caller having to format the message.
 */
export function parseProviderJson(raw: string, toolName: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (initial) {
    try {
      const repaired = jsonrepair(raw);
      return JSON.parse(repaired);
    } catch (repairErr) {
      throw new ProviderProtocolError(
        `${context} for "${toolName}" failed to parse, including after jsonrepair: ${
          repairErr instanceof Error ? repairErr.message : String(repairErr)
        }`,
        initial,
      );
    }
  }
}
