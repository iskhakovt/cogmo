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
 * is misusing the SDK.
 *
 * ## Streaming semantics
 *
 * Streaming fallback applies **only to pre-stream failures**. Once the
 * first event has been handed to the consumer, mid-stream errors propagate
 * — we cannot recover partial output. We implement this by pulling the
 * first event inside the try/catch used for candidate selection, then
 * wiring the remaining events through without further interception.
 */

import { logger } from "../logger.js";
import type { LlmProvider } from "./provider.js";
import type {
  ChatParams,
  ChatStreamResult,
  CountTokensParams,
  LlmResponse,
  StopReason,
  StreamEvent,
  Usage,
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
 * Classify an error as retriable (try the next provider) or permanent
 * (propagate). Pure function — exported for testability.
 *
 * Retriable: no status (network/DNS/TLS/timeout), 408, 425, 429, any 5xx.
 * Permanent: any other numeric HTTP status, or a non-Error throw.
 */
export function isRetriableProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = extractStatus(err);
  if (status == null) return true; // network / DNS / TLS / timeout
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

function extractStatus(err: Error): number | undefined {
  const status = (err as unknown as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
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

  async chat(params: ChatParams): Promise<LlmResponse> {
    return this.#runWithFallback("chat", (p) => p.chat(params));
  }

  async countTokens(params: CountTokensParams): Promise<number> {
    return this.#runWithFallback("countTokens", (p) => p.countTokens(params));
  }

  chatStream(params: ChatParams): ChatStreamResult {
    const providers = this.#providers;

    let resolveResponse: (v: { stopReason: StopReason; model: string; usage: Usage }) => void;
    let rejectResponse: (err: unknown) => void;
    const response = new Promise<{ stopReason: StopReason; model: string; usage: Usage }>(
      (resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      },
    );

    async function* generateEvents(): AsyncIterable<StreamEvent> {
      const attempts: FallbackAttempt[] = [];

      // Try each candidate in order. Fallback applies only before the first
      // event is yielded downstream — once we yield, the consumer has
      // committed to a model and mid-stream errors must propagate.
      for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        if (!provider) continue;

        let result: ChatStreamResult;
        let iterator: AsyncIterator<StreamEvent>;
        let firstEvent: IteratorResult<StreamEvent>;

        try {
          result = provider.chatStream(params);
          iterator = result.events[Symbol.asyncIterator]();
          // Pull the first event inside the try/catch. If the SDK throws
          // during stream establishment (auth, invalid request, connection
          // refused), this is where we detect it — before yielding anything
          // to the consumer.
          firstEvent = await iterator.next();
        } catch (err) {
          attempts.push({ provider: provider.name, error: err });
          if (isRetriableProviderError(err) && i < providers.length - 1) {
            const next = providers[i + 1];
            logger.warn(
              {
                fromProvider: provider.name,
                toProvider: next?.name,
                errClass: err instanceof Error ? err.name : typeof err,
                errMessage: err instanceof Error ? err.message : String(err),
              },
              "llm provider failed, falling back (stream)",
            );
            continue;
          }
          // Permanent or last candidate — propagate.
          if (!isRetriableProviderError(err)) {
            rejectResponse(err);
            throw err;
          }
          const exhaustion = new AllProvidersFailedError(attempts);
          logger.error(
            {
              attempts: attempts.map((a) => ({
                provider: a.provider,
                err: describeError(a.error),
              })),
            },
            "all llm providers failed (stream)",
          );
          rejectResponse(exhaustion);
          throw exhaustion;
        }

        // Successfully established the stream. Forward the first event and
        // then drain the iterator. Any further errors propagate — fallback
        // is no longer an option.
        try {
          if (!firstEvent.done) {
            yield firstEvent.value;
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              yield next.value;
            }
          }
          const meta = await result.response;
          resolveResponse(meta);
          return;
        } catch (err) {
          rejectResponse(err);
          throw err;
        }
      }

      // Unreachable — empty providers list is rejected in the constructor.
      const empty = new AllProvidersFailedError(attempts);
      rejectResponse(empty);
      throw empty;
    }

    return { events: generateEvents(), response };
  }

  async #runWithFallback<T>(op: string, run: (p: LlmProvider) => Promise<T>): Promise<T> {
    const attempts: FallbackAttempt[] = [];
    for (let i = 0; i < this.#providers.length; i++) {
      const provider = this.#providers[i];
      if (!provider) continue;
      try {
        return await run(provider);
      } catch (err) {
        attempts.push({ provider: provider.name, error: err });
        if (!isRetriableProviderError(err)) {
          throw err;
        }
        const next = this.#providers[i + 1];
        if (!next) {
          const exhaustion = new AllProvidersFailedError(attempts);
          logger.error(
            {
              op,
              attempts: attempts.map((a) => ({
                provider: a.provider,
                err: describeError(a.error),
              })),
            },
            "all llm providers failed",
          );
          throw exhaustion;
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
    // Unreachable — empty providers list is rejected in the constructor.
    throw new AllProvidersFailedError(attempts);
  }
}
