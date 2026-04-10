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
  /** Initial backoff in ms before the first retry. Default: 1000. */
  minTimeout?: number;
  /** Maximum backoff in ms between retries. Default: 10000. */
  maxTimeout?: number;
  /** Label included in retry log lines for observability. */
  context?: string;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_MIN_TIMEOUT = 1000;
const DEFAULT_MAX_TIMEOUT = 10_000;

export function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  // Tests opt out via RETRY_DISABLED so transient failures surface as
  // hard test failures instead of being silently smoothed over by a
  // retry. Retry behaviour itself is exercised in with-retry.test.ts;
  // integration and e2e tests verify the pipeline, not the retry layer.
  // Production never sets this var.
  if (process.env.RETRY_DISABLED === "true") {
    return fn();
  }

  return pRetry(fn, {
    retries: opts?.retries ?? DEFAULT_RETRIES,
    minTimeout: opts?.minTimeout ?? DEFAULT_MIN_TIMEOUT,
    maxTimeout: opts?.maxTimeout ?? DEFAULT_MAX_TIMEOUT,
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

export { AbortError };
