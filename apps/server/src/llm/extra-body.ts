/**
 * Operator-set request-body fields for a model on an OpenAI-compatible
 * provider — `model_providers.extra_body`. `OpenAICompatibleProvider` sends
 * them on every chat-completions request for the model, streaming and not,
 * alongside the fields it builds itself. They carry what a model takes beyond
 * the OpenAI shape, such as a reasoning model's thinking controls
 * (`reasoning`, `venice_parameters`, `chat_template_kwargs`). See
 * design/providers.md → Extra request body.
 *
 * The adapter owns every field it ever sets, so those keys are refused where
 * the value is written, rather than merged on the wire.
 */

import * as R from "remeda";
import { z } from "zod";
import { logger } from "../logger.js";

/**
 * Top-level request-body keys `OpenAICompatibleProvider` sets itself: the
 * call's content and tools, its output shape and cap, the sampling and
 * reasoning-effort mapping of `modelFamilyParams`, and the cache dialect's
 * hints (`cacheHints`).
 */
export const RESERVED_EXTRA_BODY_KEYS: readonly string[] = [
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "response_format",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "reasoning_effort",
  "prompt_cache_key",
  "session_id",
  "cache_control",
];

const JsonObjectSchema = z.record(z.string(), z.json());

function reservedKeysOf(body: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(body).filter((key) => RESERVED_EXTRA_BODY_KEYS.includes(key));
}

/**
 * What may be written: a non-empty JSON object none of whose top-level keys
 * the adapter sets. The CLI and the store's writes check values against it.
 */
export const ExtraBodySchema = JsonObjectSchema.superRefine((body, ctx) => {
  const reserved = reservedKeysOf(body);
  if (reserved.length > 0) {
    ctx.addIssue({
      code: "custom",
      message:
        `${reserved.map((key) => `"${key}"`).join(", ")} ${reserved.length === 1 ? "is" : "are"} ` +
        `set by the adapter and can't be overridden ` +
        `(reserved: ${RESERVED_EXTRA_BODY_KEYS.join(", ")})`,
    });
  }
  if (Object.keys(body).length === 0) {
    ctx.addIssue({ code: "custom", message: "an empty object adds nothing to the request" });
  }
});
export type ExtraBody = z.infer<typeof ExtraBodySchema>;

/**
 * What a `model_providers.extra_body` row holds, read leniently: a reserved
 * key, which only a write outside the store can have put there, is dropped
 * with a warning instead of failing the lookup. Failing it would stop every
 * call to the model and the `cogmo model` commands that would fix the row.
 */
export const StoredExtraBodySchema = JsonObjectSchema.transform((body): ExtraBody => {
  const reserved = reservedKeysOf(body);
  if (reserved.length === 0) return body;
  logger.warn(
    { reserved },
    "ignoring model_providers.extra_body keys the OpenAI-compatible adapter sets itself",
  );
  return R.omit(body, reserved);
});

/**
 * Read operator-typed text as an {@link ExtraBody}. Throws with a message
 * naming what is wrong — not JSON, not an object, a reserved key, or empty.
 */
export function parseExtraBody(text: string): ExtraBody {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `expected a JSON object, got text that doesn't parse: ${(err as Error).message}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const kind = value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
    throw new Error(`expected a JSON object, got ${kind}`);
  }
  const parsed = ExtraBodySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}
