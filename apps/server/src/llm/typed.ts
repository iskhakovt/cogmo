/**
 * Typed LLM calls — Zod schema → structured output with repair.
 *
 * Converts a Zod schema to responseFormat, calls the provider, parses with
 * a `jsonrepair` pre-pass via {@link parseProviderJson}, validates with Zod,
 * and on Zod failure retries by injecting the validation error as a synthetic
 * user turn.
 *
 * **Repair semantics differ from in-loop Class C repair.** See
 * `design/agent-resilience.md` → "Outside the agent loop":
 *
 * - Budget is per-call (per callsite), not per-turn.
 * - Exhausted retries throw to the caller. There is no `conversation/degraded`
 *   off-ramp — these calls happen in Inngest background steps (evolution
 *   drains, etc.) where no user-facing conversation exists in the failure path.
 * - Synthetic feedback turns are fully ephemeral: they live in the local
 *   `messages` array for the duration of the call only, never persisted to
 *   the `messages` table.
 * - No `turnLogger` — these calls run outside the agent loop, so there's no
 *   per-turn structured-log context to thread through.
 */

import type { ZodType } from "zod";
import { logger } from "../logger.js";
import { ProviderProtocolError, parseProviderJson } from "./errors.js";
import { toObjectJsonSchema } from "./json-schema.js";
import type { LlmProvider } from "./provider.js";
import type { Message, Usage } from "./types.js";

/**
 * Repair behavior for typed LLM calls.
 *
 * Each option has a default that matches the evolution-callsite policy
 * (jsonrepair on; one Zod-failure feedback retry). Pass an empty object
 * (`repair: {}`) to opt every default in; pass overrides to tune.
 */
export interface ChatTypedRepair {
  /**
   * Apply `jsonrepair` as a pre-pass when `JSON.parse` fails. Implemented via
   * {@link parseProviderJson} so the behavior matches the in-loop tool-arg
   * parse path: trailing commas, unclosed strings within reason, missing
   * quotes are recovered without consuming a retry. If `jsonrepair` also
   * fails, a {@link ProviderProtocolError} propagates to the caller — these
   * out-of-loop callsites have no degrade off-ramp, so the error surfaces as
   * a thrown exception that the wrapping Inngest step handles.
   *
   * Default: `true`.
   */
  jsonrepair?: boolean;
  /**
   * Number of feedback-injection retries permitted on Zod validation failure.
   * `0` disables retry (one attempt total). Has no effect when
   * {@link onZodFailure} is `"throw"`.
   *
   * Default: `1`.
   */
  maxRetries?: number;
  /**
   * What to do when Zod validation fails on a parsed response.
   *
   * - `"feedback"`: append the bad assistant turn + a user turn carrying the
   *   validation error, re-call the model with the same schema, count one
   *   retry against {@link maxRetries}.
   * - `"throw"`: surface the Zod error immediately, no retry.
   *
   * Default: `"feedback"`.
   */
  onZodFailure?: "throw" | "feedback";
}

export interface TypedChatParams<T> {
  provider: LlmProvider;
  model: string;
  system: string;
  messages: Message[];
  schema: ZodType<T>;
  name: string;
  maxTokens?: number;
  /**
   * Repair behavior. Pass `repair: {}` to signal "I want the default repair
   * policy" — semantically identical to omitting the field, with grep-ability
   * value for rollout review. `repair: {}` does **not** freeze defaults at
   * today's values: future changes to {@link DEFAULT_REPAIR} (`jsonrepair`,
   * `maxRetries`, `onZodFailure`) still apply to every callsite that passes
   * `repair: {}`. Pass explicit fields to override individual defaults.
   */
  repair?: ChatTypedRepair;
}

export interface TypedChatResult<T> {
  data: T;
  usage: Usage;
  model: string;
  retries: number;
}

const DEFAULT_REPAIR: Required<ChatTypedRepair> = {
  jsonrepair: true,
  maxRetries: 1,
  onZodFailure: "feedback",
};

/**
 * Make a typed LLM call with structured output and Zod validation.
 *
 * Uses `responseFormat` to request JSON Schema output from the provider,
 * runs {@link parseProviderJson} (with optional `jsonrepair` pre-pass) on
 * the returned text, validates with the provided Zod schema. On Zod failure
 * with `repair.onZodFailure: "feedback"`, appends the failed response plus
 * a validation-error user turn and re-calls the model up to
 * `repair.maxRetries` times.
 *
 * {@link ProviderProtocolError} (raised by {@link parseProviderJson} when
 * `jsonrepair` also fails) propagates immediately — no feedback retry, no
 * additional call. The in-loop classifier owns that recovery path for
 * in-loop callsites; for out-of-loop callsites the wrapping Inngest step
 * handles the throw.
 */
export async function chatTyped<T>(params: TypedChatParams<T>): Promise<TypedChatResult<T>> {
  const { provider, model, system, schema, name } = params;
  const repair: Required<ChatTypedRepair> = { ...DEFAULT_REPAIR, ...params.repair };
  const jsonSchema = toObjectJsonSchema(schema);
  const messages: Message[] = [...params.messages];
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let retries = 0;

  for (;;) {
    const response = await provider.chat({
      model,
      system,
      messages,
      responseFormat: { type: "json_schema", name, schema: jsonSchema },
      ...(params.maxTokens != null && { maxTokens: params.maxTokens }),
    });

    totalUsage.inputTokens += response.usage.inputTokens;
    totalUsage.outputTokens += response.usage.outputTokens;

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");

    const parsed = parseStructuredOutput(text, name, repair.jsonrepair);

    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (zodErr) {
      if (repair.onZodFailure === "throw" || retries >= repair.maxRetries) {
        logger.warn(
          { name, retries, err: zodErr },
          "chatTyped: zod validation failed, no retry budget",
        );
        throw zodErr;
      }

      const errorMessage = zodErr instanceof Error ? zodErr.message : String(zodErr);
      logger.debug({ name, retry: retries + 1, error: errorMessage }, "chatTyped: retrying");

      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `Your response didn't match the expected format. Error: ${errorMessage}\n\nPlease try again with the correct format.`,
        },
      );
      retries++;
      continue;
    }

    return { data, usage: totalUsage, model: response.model, retries };
  }
}

/**
 * Parse the assistant's structured-output text. With `useJsonrepair: true`,
 * delegates to {@link parseProviderJson} so trailing commas / minor
 * malformations are repaired deterministically and an irrecoverable failure
 * surfaces as {@link ProviderProtocolError}. With `useJsonrepair: false`,
 * uses bare `JSON.parse` and wraps a `SyntaxError` in
 * {@link ProviderProtocolError} so callers see a consistent error class
 * either way.
 */
function parseStructuredOutput(text: string, name: string, useJsonrepair: boolean): unknown {
  if (useJsonrepair) {
    return parseProviderJson(text, name, "chatTyped structured output");
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderProtocolError(
      `chatTyped structured output for "${name}" failed JSON.parse: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
