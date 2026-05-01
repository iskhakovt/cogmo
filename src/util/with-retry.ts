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
 * - Database operations — handled at the connection pool level
 * - Inngest function steps — Inngest retries failed steps itself
 *
 * Use AbortError to mark permanent failures (e.g. HTTP 4xx) that should
 * NOT be retried.
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
  // Read at call time — `vi.stubEnv` in tests mutates `process.env` after
  // module load, and the typed `env` snapshot wouldn't reflect that.
  if (process.env.RETRY_DISABLED === "true") {
    return fn();
  }

  return pRetry(fn, {
    retries: opts?.retries ?? DEFAULT_RETRIES,
    minTimeout: opts?.minTimeoutMs ?? DEFAULT_MIN_TIMEOUT_MS,
    maxTimeout: opts?.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    ...(opts?.maxRetryTimeMs != null && { maxRetryTime: opts.maxRetryTimeMs }),
    factor: 2,
    randomize: true,
    onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
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
