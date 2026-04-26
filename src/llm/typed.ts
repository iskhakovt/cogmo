/**
 * Typed LLM calls — Zod schema → structured output with retry.
 *
 * Converts a Zod schema to responseFormat, calls the provider,
 * parses + validates the response, retries with error feedback on failure.
 */

import { type ZodType, z } from "zod";
import { logger } from "../logger.js";
import type { LlmProvider } from "./provider.js";
import type { JsonSchema, Message, Usage } from "./types.js";

export interface TypedChatParams<T> {
  provider: LlmProvider;
  model: string;
  system: string;
  messages: Message[];
  schema: ZodType<T>;
  name: string;
  maxRetries?: number;
  maxTokens?: number;
}

export interface TypedChatResult<T> {
  data: T;
  usage: Usage;
  model: string;
  retries: number;
}

const DEFAULT_MAX_RETRIES = 2;

/**
 * Make a typed LLM call with structured output and Zod validation.
 *
 * Uses responseFormat to request JSON Schema output from the provider,
 * then validates with the provided Zod schema. On parse/validation failure,
 * retries by injecting the error as feedback.
 */
export async function chatTyped<T>(params: TypedChatParams<T>): Promise<TypedChatResult<T>> {
  const { provider, model, system, schema, name, maxRetries = DEFAULT_MAX_RETRIES } = params;
  // z.toJSONSchema returns Zod's JSONSchema7-flavoured shape; our internal
  // JsonSchema type is a narrower subset that the LLM providers accept.
  const jsonSchema = z.toJSONSchema(schema) as unknown as JsonSchema;
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

    try {
      const parsed = JSON.parse(text);
      const data = schema.parse(parsed);
      return { data, usage: totalUsage, model: response.model, retries };
    } catch (err) {
      if (retries >= maxRetries) {
        logger.warn({ name, retries, err }, "chatTyped: max retries exceeded");
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.debug({ name, retry: retries + 1, error: errorMessage }, "chatTyped: retrying");

      // Inject the failed response + error feedback for retry
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `Your response didn't match the expected format. Error: ${errorMessage}\n\nPlease try again with the correct format.`,
        },
      );
      retries++;
    }
  }
}
