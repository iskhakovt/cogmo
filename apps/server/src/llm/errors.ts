/**
 * Errors raised by the LLM provider layer that don't map onto an upstream
 * HTTP failure shape.
 *
 * SDK / HTTP failures keep their native shape ({@link Error} subclass with a
 * numeric `status`) — {@link FallbackLlmProvider} duck-types on `status` to
 * classify them. The errors here cover cases where the upstream response
 * arrived structurally intact but its payload is unusable downstream:
 * truncated tool-arg JSON, malformed streamed deltas, etc.
 *
 * This file also hosts {@link parseProviderJson} — the shared JSON pre-pass
 * that adapters use to parse buffered tool-arg payloads, with a `jsonrepair`
 * fallback and a {@link ProviderProtocolError} result on irrecoverable
 * failure. It lives here, beside the error it returns, rather than in a
 * separate `parse.ts`; greppers looking for the parse logic should start with
 * this file.
 */

import { jsonrepair } from "jsonrepair";
import { err, ok, type Result } from "neverthrow";
import type { Usage } from "./types.js";

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
 * A {@link ProviderProtocolError} for tool arguments the output cap cut off:
 * the call that failed to parse is the response's last block, and the
 * response stopped at `max_tokens`. The JSON is unfinished rather than
 * malformed, so re-requesting it — the stream-truncation replay — sends the
 * same request into the same cap. The in-loop classifier degrades it
 * directly instead.
 */
export class ToolArgsCutOffError extends ProviderProtocolError {
  constructor(parseError: ProviderProtocolError) {
    super(`${parseError.message} (cut off at the output cap)`, parseError);
    this.name = "ToolArgsCutOffError";
  }
}

/**
 * A structured-output reply the context window cut off, or the output cap
 * even after `chatTyped` raised it, which `chatTyped` refuses rather than
 * repairs.
 */
export class OutputCutOffError extends ProviderProtocolError {
  constructor(name: string, stopReason: "max_tokens" | "context_overflow") {
    super(`structured output for "${name}" stopped at ${stopReason}`, undefined);
    this.name = "OutputCutOffError";
  }
}

/**
 * A whole `responseFormat` reply that made none of the tool call the adapter
 * asked for. It carries what a re-ask needs: the reply's text, the adapter's
 * instruction naming the tool, and the call's usage.
 */
export class MissingToolCallError extends ProviderProtocolError {
  readonly reply: string;
  readonly instruction: string;
  readonly usage: Readonly<Usage>;

  constructor(name: string, miss: { reply: string; instruction: string; usage: Usage }) {
    super(`structured output for "${name}" made no tool call`, undefined);
    this.name = "MissingToolCallError";
    this.reply = miss.reply;
    this.instruction = miss.instruction;
    this.usage = miss.usage;
  }
}

/**
 * Parse a JSON payload streamed by a provider (e.g. buffered tool-use
 * argument chunks). Try `JSON.parse` first; on failure, run `jsonrepair`
 * (handles trailing commas, unclosed strings within reason, missing
 * quotes) and parse again. If repair also fails, the result is a
 * {@link ProviderProtocolError}. The adapter decides whether the output cap
 * cut the payload off ({@link ToolArgsCutOffError}) and throws it from the
 * call, where the in-loop classifier owns the recovery and the provider chain
 * propagates it rather than reading a bare `SyntaxError` as transient.
 *
 * `context` identifies the call site in the error message (e.g. "Anthropic
 * streamed tool_use input", "OpenAI-compatible streamed tool_calls
 * arguments") so failures point at the right adapter without the caller
 * having to format the message.
 *
 * The error carries the `jsonrepair` failure as its `.cause` (the final,
 * decisive error) and embeds the initial `JSON.parse` failure in its message,
 * so both attempts are visible without chasing `.cause`.
 */
export function parseProviderJson(
  raw: string,
  toolName: string,
  context: string,
): Result<unknown, ProviderProtocolError> {
  try {
    return ok(JSON.parse(raw));
  } catch (initial) {
    try {
      return ok(JSON.parse(jsonrepair(raw)));
    } catch (repairErr) {
      const initialMsg = initial instanceof Error ? initial.message : String(initial);
      const repairMsg = repairErr instanceof Error ? repairErr.message : String(repairErr);
      return err(
        new ProviderProtocolError(
          `${context} for "${toolName}" failed to parse — initial: ${initialMsg}; after jsonrepair: ${repairMsg}`,
          repairErr,
        ),
      );
    }
  }
}

/**
 * Parse a tool-call argument payload. Empty / whitespace-only `raw` is
 * the canonical wire shape for a tool called with no arguments —
 * Anthropic streaming emits zero `input_json_delta` events, some
 * OpenAI-compatible providers return `arguments: ""` instead of `"{}"`
 * — and yields `{}` here to match the non-streaming SDK behavior.
 * Anything else delegates to {@link parseProviderJson}.
 */
export function parseToolArgs(
  raw: string,
  toolName: string,
  context: string,
): Result<unknown, ProviderProtocolError> {
  if (raw.trim() === "") return ok({});
  return parseProviderJson(raw, toolName, context);
}
