/**
 * Fallback LLM provider.
 *
 * Wraps an ordered list of {@link LlmProvider} candidates (primary first,
 * then fallbacks) and transparently retries transient failures against the
 * next candidate. Implements {@link LlmProvider} so the agent loop, typed
 * calls, and observer are completely unaware of the routing table.
 *
 * ## Retry classification
 *
 * This wrapper is the OUTER retry layer — the SDK adapters
 * ({@link ./anthropic.js}, {@link ./openai-compat.js}) already have their
 * own in-provider HTTP retries. Fallback only kicks in after those exhaust.
 * Do not entangle with {@link ../util/with-retry.js}.
 *
 * Both the Anthropic SDK and OpenAI SDK surface a numeric `status` field on
 * their `APIError` shape (along with lower-level network errors that have
 * no status). We duck-type on `status` and classify errors into:
 *
 * | Class       | Statuses                                        | Behaviour           |
 * | ----------- | ----------------------------------------------- | ------------------- |
 * | transient   | no status (DNS/TLS/timeout), 408, 425, 429, 5xx | try next candidate  |
 * | permanent   | 400/401/403/404/409/422 + other 4xx             | propagate (no fallback) |
 *
 * Non-Error throws (strings, objects) are treated as permanent — the caller
 * is misusing the SDK. A call whose abort signal has fired propagates its
 * error whatever the class: the caller cancelled it.
 *
 * ## Streaming semantics
 *
 * Streaming fallback applies **only to pre-stream failures**. Once the
 * first frame has been handed to the consumer, mid-stream errors propagate
 * — we cannot recover partial output.
 */

import { logger } from "../logger.js";
import { ProviderProtocolError } from "./errors.js";
import type { LlmProvider } from "./provider.js";
import type {
  ChatOptions,
  ChatParams,
  ChatStreamFrame,
  CountTokensParams,
  LlmResponse,
} from "./types.js";

/**
 * One attempt in an exhausted fallback chain — the provider that failed and
 * the error it threw. Used for diagnostics on {@link AllProvidersFailedError}.
 */
export interface FallbackAttempt {
  provider: string;
  error: unknown;
}

/**
 * Thrown when every candidate provider fails with a transient error.
 *
 * Carries the ordered list of attempts so operators can see which providers
 * were tried and why each one failed.
 */
export class AllProvidersFailedError extends Error {
  readonly attempts: ReadonlyArray<FallbackAttempt>;

  constructor(attempts: ReadonlyArray<FallbackAttempt>) {
    const summary = attempts.map((a) => `${a.provider}: ${describeError(a.error)}`).join("; ");
    super(`All ${attempts.length} LLM providers failed — ${summary}`);
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

/**
 * Thrown by an SDK adapter when the upstream provider refuses the request on
 * content-policy grounds — e.g. OpenAI's `BadRequestError` carrying
 * `code: "content_policy_violation"` (or Azure's
 * `responsible_ai_policy_violation`). The success-path equivalent surfaces as
 * `stopReason: "refusal"` on the response; this error class covers refusals
 * that arrive as 400-class HTTP errors instead. `chatTyped` also throws it
 * for a refusal reply.
 *
 * Class C in `design/agent-resilience.md` treats refusal as non-retriable:
 * fallback to the next provider is the wrong shape (policies differ
 * deliberately across providers), and re-prompting the same model would
 * almost certainly hit the same outcome. `isRetriableProviderError` returns
 * `false` for this class so the provider chain propagates it untouched.
 */
export class RefusalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RefusalError";
  }
}

/**
 * Classify an error as retriable (try the next provider) or permanent
 * (propagate). Pure function — exported for testability.
 *
 * Retriable: no status (network/DNS/TLS/timeout), 408, 425, 429, any 5xx.
 * Permanent: any other numeric HTTP status, or a non-Error throw.
 *
 * Two non-status error classes are also treated as permanent so they reach
 * the in-loop classifier instead of burning the provider chain:
 * - {@link ProviderProtocolError}: upstream response arrived intact but its
 *   payload is unusable (tool-arg JSON fails to parse even after
 *   `jsonrepair`). Retrying the next provider has no reason to help.
 * - {@link RefusalError}: policy refusal (`stop_reason: "refusal"`,
 *   `finish_reason: "content_filter"`, or a content-policy 400). Silent
 *   re-routing across providers on a policy refusal is the wrong shape —
 *   policies are deliberately different. See Class C in
 *   `design/agent-resilience.md`.
 */
export function isRetriableProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ProviderProtocolError) return false;
  if (err instanceof RefusalError) return false;
  const status = extractStatus(err);
  if (status == null) return true; // network / DNS / TLS / timeout
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

export function extractStatus(err: Error): number | undefined {
  // SDK error subclasses (Anthropic, OpenAI) carry a `status` field that
  // Error's type doesn't promise; `in` narrows + typeof guards the read.
  if (!("status" in err)) return undefined;
  return typeof err.status === "number" ? err.status : undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const status = extractStatus(err);
    return status != null
      ? `${err.name} (${status}): ${err.message}`
      : `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * Wraps an ordered list of providers with transparent fallback on
 * transient errors. See module docs for classification + streaming rules.
 */
export class FallbackLlmProvider implements LlmProvider {
  readonly name: string;
  readonly #providers: ReadonlyArray<LlmProvider>;

  constructor(providers: ReadonlyArray<LlmProvider>) {
    if (providers.length === 0) {
      throw new Error("FallbackLlmProvider requires at least one provider");
    }
    this.#providers = providers;
    this.name =
      providers.length === 1
        ? (providers[0]?.name ?? "fallback")
        : `fallback(${providers.map((p) => p.name).join(",")})`;
  }

  async chat(params: ChatParams, options?: ChatOptions): Promise<LlmResponse> {
    return this.#runWithFallback("chat", options?.signal, (p) => p.chat(params, options));
  }

  async countTokens(params: CountTokensParams): Promise<number> {
    return this.#runWithFallback("countTokens", undefined, (p) => p.countTokens(params));
  }

  /**
   * Fallback applies only until a candidate's first frame is forwarded: from
   * then on the consumer has committed to that model, and a mid-stream error
   * propagates. `for await` returns the candidate's stream when the consumer
   * stops early, so the candidate's cleanup (request abort, span end) runs.
   */
  async *chatStream(params: ChatParams, options?: ChatOptions): AsyncGenerator<ChatStreamFrame> {
    const attempts: FallbackAttempt[] = [];
    for (const [index, provider] of this.#providers.entries()) {
      let forwarded = false;
      try {
        for await (const frame of provider.chatStream(params, options)) {
          forwarded = true;
          yield frame;
        }
        return;
      } catch (err) {
        if (forwarded || options?.signal?.aborted) throw err;
        this.#fallBackOrThrow("chatStream", index, err, attempts);
      }
    }
    // Unreachable: the last candidate's failure always throws.
    throw new AllProvidersFailedError(attempts);
  }

  async #runWithFallback<T>(
    op: string,
    signal: AbortSignal | undefined,
    run: (p: LlmProvider) => Promise<T>,
  ): Promise<T> {
    const attempts: FallbackAttempt[] = [];
    for (const [index, provider] of this.#providers.entries()) {
      try {
        return await run(provider);
      } catch (err) {
        if (signal?.aborted) throw err;
        this.#fallBackOrThrow(op, index, err, attempts);
      }
    }
    // Unreachable: the last candidate's failure always throws.
    throw new AllProvidersFailedError(attempts);
  }

  /**
   * Record candidate `index`'s failure, then return to try the next
   * candidate, or throw: the error itself when it is permanent,
   * {@link AllProvidersFailedError} when no candidate is left.
   */
  #fallBackOrThrow(op: string, index: number, err: unknown, attempts: FallbackAttempt[]): void {
    const provider = this.#providers[index];
    if (!provider) throw new Error(`unreachable: no provider at index ${index}`);
    attempts.push({ provider: provider.name, error: err });
    if (!isRetriableProviderError(err)) throw err;
    const next = this.#providers[index + 1];
    if (!next) {
      logger.error(
        {
          op,
          attempts: attempts.map((a) => ({ provider: a.provider, err: describeError(a.error) })),
        },
        "all llm providers failed",
      );
      throw new AllProvidersFailedError(attempts);
    }
    logger.warn(
      {
        op,
        fromProvider: provider.name,
        toProvider: next.name,
        errClass: err instanceof Error ? err.name : typeof err,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "llm provider failed, falling back",
    );
  }
}
