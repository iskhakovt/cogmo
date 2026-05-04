import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  HindsightClient,
  HindsightError,
  type MemoryItemInput,
} from "@vectorize-io/hindsight-client";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { logger } from "../logger.js";
import { AbortError, withRetry } from "../util/with-retry.js";
import type {
  Memory,
  MemoryProvider,
  RecallOptions,
  RecallResult,
  ReflectOptions,
  ReflectResult,
  RetainBatchItem,
  RetainOptions,
} from "./provider.js";

const tracer = trace.getTracer("cogmo.memory");

/**
 * Default Hindsight server cap on recall query length, in tokens. Mirrors
 * the upstream default of `HINDSIGHT_API_RECALL_MAX_QUERY_TOKENS=500`. Bumping
 * the server cap requires bumping this provider option to match — otherwise
 * the client truncates first and the server-side budget goes unused.
 */
const DEFAULT_MAX_QUERY_TOKENS = 500;

// cl100k_base matches the tiktoken encoding Hindsight uses server-side
// (`tiktoken.get_encoding("cl100k_base")` in `memory_engine.py`). Decoding
// the token slice back to a string yields exactly what Hindsight will see
// after re-encoding, so our token count and the server's never disagree.
let queryEncoder: Tiktoken | null = null;
function getQueryEncoder(): Tiktoken {
  if (!queryEncoder) queryEncoder = getEncoding("cl100k_base");
  return queryEncoder;
}

function truncateQuery(query: string, maxTokens: number): { query: string; truncated: boolean } {
  const enc = getQueryEncoder();
  const tokens = enc.encode(query);
  if (tokens.length <= maxTokens) return { query, truncated: false };
  return { query: enc.decode(tokens.slice(0, maxTokens)), truncated: true };
}

function isClientError(statusCode: number | undefined): boolean {
  // 429 is transient (rate limiting) — let withRetry's backoff handle it
  // rather than treating it as a deterministic 4xx that aborts immediately.
  return statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
}

export interface HindsightMemoryProviderOptions {
  /**
   * Truncation budget for recall queries, in tokens. Must match the server's
   * `HINDSIGHT_API_RECALL_MAX_QUERY_TOKENS`. Defaults to the upstream default
   * of 500. Bump on both sides simultaneously when long multi-turn context
   * needs to flow into the recall query.
   */
  maxQueryTokens?: number;
}

/**
 * Hindsight memory provider — talks to a self-hosted Hindsight server via HTTP.
 *
 * Retry budgets are split by user-visibility:
 * - retain is async (fire-and-forget) — uses the default 3 retries with
 *   no time cap, since the user never waits for it.
 * - recall and reflect are on the interactive path — the agent can't
 *   respond until they return — so they cap at 2 retries / 5s total
 *   wall-clock to bound user-visible latency on a flaky Hindsight.
 */
export class HindsightMemoryProvider implements MemoryProvider {
  readonly name = "hindsight";
  #client: HindsightClient;
  #maxQueryTokens: number;

  constructor(baseUrl: string, options?: HindsightMemoryProviderOptions) {
    this.#client = new HindsightClient({ baseUrl });
    this.#maxQueryTokens = options?.maxQueryTokens ?? DEFAULT_MAX_QUERY_TOKENS;
  }

  async retain(bankId: string, content: string, options?: RetainOptions): Promise<void> {
    // async: true returns immediately; Hindsight processes the 3-phase pipeline
    // (chunk → extract → consolidate) in the background. Memories become
    // searchable when processing completes — typically 5-15 seconds depending
    // on LLM latency. Callers must tolerate eventual consistency: there is no
    // read-after-write guarantee within the same turn.
    const opts: Parameters<HindsightClient["retain"]>[2] = { async: true };
    if (options?.context !== undefined) opts.context = options.context;
    if (options?.metadata !== undefined) opts.metadata = options.metadata;
    if (options?.tags !== undefined) opts.tags = options.tags;
    await tracer.startActiveSpan(
      "memory.retain",
      { attributes: { "memory.provider": this.name } },
      async (span) => {
        try {
          await withRetry(() => this.#client.retain(bankId, content, opts), {
            context: `hindsight.retain[${bankId}]`,
          });
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  async retainBatch(bankId: string, items: RetainBatchItem[]): Promise<void> {
    const mapped: MemoryItemInput[] = items.map((item) => ({
      content: item.content,
      ...(item.context !== undefined && { context: item.context }),
      ...(item.metadata !== undefined && { metadata: item.metadata }),
      ...(item.tags !== undefined && { tags: item.tags }),
      ...(item.observationScopes !== undefined && {
        observation_scopes: item.observationScopes,
      }),
    }));
    await withRetry(() => this.#client.retainBatch(bankId, mapped, { async: true }), {
      context: `hindsight.retainBatch[${bankId}]`,
    });
  }

  async recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResult> {
    const opts: Parameters<HindsightClient["recall"]>[2] = {};
    if (options?.maxTokens !== undefined) opts.maxTokens = options.maxTokens;
    if (options?.tags !== undefined) opts.tags = options.tags;
    if (options?.tagsMatch !== undefined) opts.tagsMatch = options.tagsMatch;

    const { query: bounded, truncated } = truncateQuery(query, this.#maxQueryTokens);
    if (truncated) {
      logger.warn(
        { bankId, maxQueryTokens: this.#maxQueryTokens, originalLength: query.length },
        "hindsight.recall query truncated to max query tokens",
      );
    }

    return tracer.startActiveSpan(
      "memory.recall",
      { attributes: { "memory.provider": this.name } },
      async (span) => {
        try {
          const response = await withRetry(
            async () => {
              try {
                return await this.#client.recall(bankId, bounded, opts);
              } catch (err) {
                // Hindsight 4xx is deterministic — bad request, malformed bank,
                // etc. Retrying just burns latency before failing the same way.
                // Surface as AbortError so withRetry stops, and let the caller
                // decide whether to fail-soft (auto-recall) or propagate (LLM
                // tool, skill).
                if (err instanceof HindsightError && isClientError(err.statusCode)) {
                  throw new AbortError(err.message);
                }
                throw err;
              }
            },
            {
              retries: 2,
              maxRetryTimeMs: 5000,
              context: `hindsight.recall[${bankId}]`,
            },
          );

          const memories: Memory[] = (response.results ?? []).map((r) => {
            const memory: Memory = { content: r.text, type: r.type ?? "unknown" };
            if (r.metadata) memory.metadata = r.metadata;
            return memory;
          });

          span.setAttributes({
            "memory.hit": memories.length > 0,
            "memory.count": memories.length,
          });

          return { memories };
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  async reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResult> {
    const opts: Parameters<HindsightClient["reflect"]>[2] = {};
    if (options?.context !== undefined) opts.context = options.context;
    if (options?.tags !== undefined) opts.tags = options.tags;
    if (options?.tagsMatch !== undefined) opts.tagsMatch = options.tagsMatch;
    if (options?.budget !== undefined) opts.budget = options.budget;

    const response = await withRetry(() => this.#client.reflect(bankId, query, opts), {
      retries: 2,
      maxRetryTimeMs: 5000,
      context: `hindsight.reflect[${bankId}]`,
    });
    return { answer: response.text };
  }
}
