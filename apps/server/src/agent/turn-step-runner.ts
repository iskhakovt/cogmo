/**
 * The durable-step wrapper an agent turn's in-turn steps run through
 * (`llm-iter<N>`, `tool-iter<N>-<P>`, `auto-recall`, `summarize-prefix-outcome`,
 * `load-last-tokens`, `count-tokens-<n>`, …). Shared by every orchestrator
 * that drives `runStreamingAgentLoop` — `handle-message` and the pipeline
 * stage turn — so the retry policy has one definition.
 *
 * It wraps the port's `Durable.run` without making the loop depend on Inngest,
 * and applies the retry policy per step kind INSIDE the body:
 *
 * - `tool-iter*` gets NO step retries at all. A tool's expected failures
 *   never reach here: the handler rejects, and the step returns that
 *   rejection as its result. What does reach here is a throw — a bug, or an
 *   outage the handler didn't map — and the loop answers it with an
 *   `is_error` tool_result too. The agent loop is the retry mechanism (the
 *   model re-decides with that result in context); blind re-runs of the same
 *   handler only delay the feedback by the backoff schedule. A fresh
 *   tool_use from the model creates a fresh step, which IS the retry.
 * - Everything else keeps Inngest's per-step retries for transient failures,
 *   with deterministic provider errors (4xx that aren't 408/425/429)
 *   translated to NonRetriableError so Inngest fails fast instead of burning
 *   attempts on a call that fails identically.
 */

import { NonRetriableError } from "inngest";
import { Result } from "neverthrow";
import { z } from "zod";
import { extractStatus, isRetriableProviderError } from "../llm/fallback.js";
import type { StepRunner } from "./loop.js";

/**
 * A provider's refusal of a chat turn's request, as `onFailure` reads it
 * back: the HTTP status, the step that sent the request, and the inbound
 * cursor of the turn whose request it was.
 */
const ProviderRefusalSchema = z.object({
  status: z.number().int(),
  step: z.string(),
  cursor: z.string(),
});
export type ProviderRefusal = z.infer<typeof ProviderRefusalSchema>;

/** The name of the cause link that carries a {@link ProviderRefusal}. */
const PROVIDER_REFUSAL = "ProviderRefusal";

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => "not JSON",
);

/**
 * Single conversion point for "this failure gains nothing from a blind retry".
 * A chat turn's step passes `turnStep`, and an error carrying a provider's
 * HTTP status then gets a cause link between the two, named
 * {@link PROVIDER_REFUSAL}, whose message is the refusal as JSON: `onFailure`
 * receives the error serialized, and Inngest keeps only a cause's name,
 * message, stack and cause.
 */
export function asNonRetriable(
  err: unknown,
  turnStep?: Omit<ProviderRefusal, "status">,
): NonRetriableError {
  const message = err instanceof Error ? err.message : String(err);
  const status = turnStep !== undefined && err instanceof Error ? extractStatus(err) : undefined;
  if (turnStep === undefined || status === undefined) {
    return new NonRetriableError(message, { cause: err });
  }
  const refusal: ProviderRefusal = { status, ...turnStep };
  const link = new Error(JSON.stringify(refusal), { cause: err });
  link.name = PROVIDER_REFUSAL;
  return new NonRetriableError(message, { cause: link });
}

/**
 * A failed run's error as `onFailure` reads it: the provider's refusal when
 * {@link asNonRetriable} recorded one, and the error it wrapped.
 */
export function failureCause(error: Error): { refusal: ProviderRefusal | null; cause: unknown } {
  const { cause } = error;
  if (!(cause instanceof Error) || cause.name !== PROVIDER_REFUSAL) return { refusal: null, cause };
  const refusal = parseJson(cause.message)
    .map((json) => ProviderRefusalSchema.safeParse(json))
    .match(
      (parsed) => (parsed.success ? parsed.data : null),
      () => null,
    );
  return { refusal, cause: cause.cause };
}

/**
 * `turn` is the chat turn whose requests the steps send, named by its cursor
 * so a refusal's `onFailure` can find its rows; a stage turn passes none.
 */
export function createTurnStepRunner(run: StepRunner, turn?: { cursor: string }): StepRunner {
  return (id, fn) =>
    run(id, async () => {
      try {
        return await fn();
      } catch (err) {
        if (id.startsWith("tool-iter")) throw asNonRetriable(err);
        if (!isRetriableProviderError(err)) {
          throw asNonRetriable(err, turn && { step: id, cursor: turn.cursor });
        }
        throw err;
      }
    });
}
