/**
 * Retry an async operation with exponential backoff and jitter.
 *
 * Wraps p-retry with project-wide defaults and structured logging.
 * Use this for transport-level retries against external services
 * (HTTP APIs, self-hosted backends) where transient failures are
 * expected and can be recovered without involving the caller.
 *
 * Do NOT use this for:
 * - Anthropic / OpenAI SDK calls — both SDKs already retry HTTP errors
 * - Validation retries (e.g. typed.ts) — those are semantic, not transport
 * - Generic database connection errors — handled at the postgres-js pool
 *   level (the tx-serialization retry in `src/db/transactor.ts` is a
 *   targeted exception: it retries only SQLSTATE 40001 from REPEATABLE
 *   READ snapshot conflicts, not connection-level transience)
 * - Inngest function steps — Inngest retries failed steps itself
 *
 * Use AbortError to mark permanent failures (e.g. HTTP 4xx) that should
 * NOT be retried — but only when the caller just needs the loop to stop.
 * p-retry rethrows an AbortError's `originalError`, so a subclass of it
 * does not survive to the caller; when the caller must discriminate on the
 * error's type, use `shouldRetry` instead.
 */

import pRetry, { AbortError } from "p-retry";
import { logger } from "../logger.js";

export interface RetryOptions {
  /** Number of retry attempts after the initial call. Default: 3. */
  retries?: number;
  /** Initial backoff before the first retry. Default: 1000ms. */
  minTimeoutMs?: number;
  /** Maximum backoff between retries. Default: 10000ms. */
  maxTimeoutMs?: number;
  /**
   * Hard wall-clock cap — retries stop once total elapsed time
   * exceeds this. Use this when individual attempts can be long
   * (e.g. fetch with its own timeout) and you want to bound the
   * total user-visible wait. Default: no cap.
   */
  maxRetryTimeMs?: number;
  /** Label included in retry log lines for observability. */
  context?: string;
  /**
   * Predicate run on every caught error. Return `false` to skip
   * remaining attempts and re-throw the error unchanged — preserving the
   * caller's error type. `AbortError` does not: p-retry rethrows its
   * `originalError`, which for a string message is a freshly-constructed
   * plain `Error`, so an `AbortError` subclass never reaches the caller as
   * itself. Use this predicate whenever the caller has to tell failure
   * shapes apart afterwards, or for code-specific retry policy (e.g. retry
   * only Postgres SQLSTATE 40001).
   *
   * Called twice per failure (once in `onFailedAttempt` to gate the
   * warn log, once via p-retry's native `shouldRetry` hook). Keep
   * the predicate side-effect-free.
   */
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_MIN_TIMEOUT_MS = 1000;
const DEFAULT_MAX_TIMEOUT_MS = 10_000;

export function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  // Tests opt out via RETRY_DISABLED so transient failures surface as
  // hard test failures instead of being silently smoothed over by a
  // retry. Retry behaviour itself is exercised in with-retry.test.ts;
  // integration and e2e tests verify the pipeline, not the retry layer.
  // Production never sets this var.
  // Test-only escape hatch — read at call time so `vi.stubEnv` works.
  // Stays out of the typed env schema because it's a test concern, not
  // production config.
  if (process.env.RETRY_DISABLED === "true") {
    return fn();
  }

  const userShouldRetry = opts?.shouldRetry;
  return pRetry(fn, {
    retries: opts?.retries ?? DEFAULT_RETRIES,
    minTimeout: opts?.minTimeoutMs ?? DEFAULT_MIN_TIMEOUT_MS,
    maxTimeout: opts?.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    ...(opts?.maxRetryTimeMs != null && { maxRetryTime: opts.maxRetryTimeMs }),
    factor: 2,
    randomize: true,
    // Native p-retry hook — returning `false` re-throws the original
    // error unchanged to the caller, preserving its type. Unlike
    // AbortError, which p-retry unwraps to its `originalError` (a plain
    // `Error` when constructed from a string), losing the subclass.
    ...(userShouldRetry !== undefined && {
      shouldRetry: ({ error }: { error: Error }) => userShouldRetry(error),
    }),
    onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
      // p-retry fires onFailedAttempt BEFORE consulting shouldRetry, so
      // we must re-check here to avoid logging "retry attempt N failed"
      // for errors that won't actually be retried. Same guarantee
      // p-retry gives for AbortError, lifted to the predicate path.
      if (userShouldRetry !== undefined && !userShouldRetry(error)) return;
      logger.warn(
        {
          err: { name: error.name, message: error.message },
          attempt: attemptNumber,
          retriesLeft,
          context: opts?.context,
        },
        `retry attempt ${attemptNumber} failed${opts?.context ? ` (${opts.context})` : ""}`,
      );
    },
  });
}

// Re-exported so callers always import AbortError from this module —
// importing directly from p-retry would bypass any future wrapper-level
// logic we add (custom classification, metrics, etc). Enforced by
// biome's noRestrictedImports rule on the "p-retry" path.
export { AbortError };
