/**
 * Which extraction failures the turn caused. The provider layer fails by
 * throwing; the Observer converts a throw to a value here, once, and only
 * when the turn caused it, so that only a turn-caused failure is counted on
 * the turn's row (design/observation.md → Slice 1a). Everything else (an
 * outage, a rate limit, an expired key, an unknown model) is the step's to
 * retry and the fire's to give up on, and leaves the row as it was.
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

/** A 400 naming the context window: the turn can't fit the extraction model. */
const CONTEXT_LENGTH_MESSAGE = /context|too long|too many tokens|maximum.{0,20}tokens/i;

/** A 400 naming billing or quota, which is the account's, not the turn's. */
const BILLING_MESSAGE = /billing|quota|credit|insufficient/i;

/** Statuses that say nothing about the turn: auth, billing, not found, and the retriable ones. */
const NOT_THE_TURNS = new Set([401, 402, 403, 404, 408, 409, 425, 429]);

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
  const status = extractStatus(err);
  if (status === undefined || status < 400 || status > 499 || NOT_THE_TURNS.has(status)) {
    return null;
  }
  if (status === 400 && BILLING_MESSAGE.test(err.message)) return null;
  if (status === 400 && CONTEXT_LENGTH_MESSAGE.test(err.message)) {
    return { kind: "context_overflow", message: err.message };
  }
  return { kind: "rejected", message: `${status}: ${err.message}` };
}

/**
 * Whether a failure ends the turn at once. A turn too large for the model, a
 * refusal and a cut-off reply recur on every attempt; a parse failure or an
 * unplaced rejection may not, so those count toward `MAX_TURN_ATTEMPTS`.
 */
export function isTerminalTurnFailure(failure: TurnFailure): boolean {
  return match(failure.kind)
    .with("context_overflow", "refusal", "output_cut_off", () => true)
    .with("parse", "rejected", () => false)
    .exhaustive();
}

/** Turn-caused failures a turn's corrections may have before the row is `failed`. */
export const MAX_TURN_ATTEMPTS = 3;
