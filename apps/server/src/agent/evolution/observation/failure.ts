/**
 * Which extraction failures the turn caused. The provider layer fails by
 * throwing; the Observer converts a throw to a value here, once, and only
 * when the turn caused it, so that only a turn-caused failure is counted on
 * the turn's row (design/observation.md → Slice 1a). Anything else thrown
 * by the extraction (the rules read, the prompt build or the provider call:
 * an outage, a rate limit, an expired key, an unknown model, a 4xx no rule
 * places, bugs included) is rethrown as `ExtractionUnavailableError`: the
 * step retries it, the fire gives up on the phase, and the row stays as it
 * was. What a turn's step throws outside the extraction (loading the turn,
 * applying it, skipping it) is counted.
 */

import { match } from "ts-pattern";
import { ZodError } from "zod";
import {
  OutputCutOffError,
  ProviderProtocolError,
  ToolArgsCutOffError,
} from "../../../llm/errors.js";
import { extractStatus, RefusalError } from "../../../llm/fallback.js";
import type { TurnFailure } from "../../store/index.js";

/**
 * A 400 that says the request outgrew the context window: Anthropic's
 * "prompt is too long" and "exceed context limit", OpenAI's and
 * OpenRouter's "maximum context length" and `context_length_exceeded`.
 */
const CONTEXT_OVERFLOW_MESSAGE =
  /prompt is too long|maximum context length|context_length_exceeded|exceeds? (?:the )?context (?:limit|window)/i;

/**
 * The turn-caused failure `err` is, or null when it isn't one and the
 * caller rethrows it. Subclasses match before the classes they extend.
 */
export function classifyTurnFailure(err: unknown): TurnFailure | null {
  if (err instanceof RefusalError) return { kind: "refusal", message: err.message };
  if (err instanceof OutputCutOffError || err instanceof ToolArgsCutOffError) {
    return { kind: "output_cut_off", message: err.message };
  }
  // `MissingToolCallError` extends `ProviderProtocolError`; a `ZodError`
  // reaches here once `chatTyped`'s feedback retry is spent.
  if (err instanceof ProviderProtocolError || err instanceof ZodError) {
    return { kind: "parse", message: err.message };
  }
  if (!(err instanceof Error)) return null;
  if (extractStatus(err) === 400 && CONTEXT_OVERFLOW_MESSAGE.test(err.message)) {
    return { kind: "context_overflow", message: err.message };
  }
  return null;
}

/** `ExtractionUnavailableError`'s name, which a step's failure carries through Inngest. */
const EXTRACTION_UNAVAILABLE = "ExtractionUnavailableError";

/**
 * An extraction call that failed for a reason that isn't the turn's,
 * rethrown so the step retries it. A step that fails after its retries with
 * this error is not counted against the turn.
 */
export class ExtractionUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`extraction unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = EXTRACTION_UNAVAILABLE;
  }
}

/**
 * Whether a step's failure is an `ExtractionUnavailableError`, read from the
 * name a `StepError` keeps of the error the step threw.
 */
export function isExtractionUnavailable(err: { name: string }): boolean {
  return err.name === EXTRACTION_UNAVAILABLE;
}

/**
 * Whether a failure ends the turn at once. A turn too large for the model, a
 * refusal and a cut-off reply recur on every attempt; a parse failure or a
 * step that failed for no placed reason may not, so those count toward
 * `MAX_TURN_ATTEMPTS`.
 */
export function isTerminalTurnFailure(failure: TurnFailure): boolean {
  return match(failure.kind)
    .with("context_overflow", "refusal", "output_cut_off", () => true)
    .with("parse", "exhausted", () => false)
    .exhaustive();
}

/** Counted failures a turn's corrections may have before the row is `failed`. */
export const MAX_TURN_ATTEMPTS = 3;
