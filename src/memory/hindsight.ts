import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { withRetry } from "../util/with-retry.js";
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

  constructor(baseUrl: string) {
    this.#client = new HindsightClient({ baseUrl });
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

    return tracer.startActiveSpan(
      "memory.recall",
      { attributes: { "memory.provider": this.name } },
      async (span) => {
        try {
          const response = await withRetry(() => this.#client.recall(bankId, query, opts), {
            retries: 2,
            maxRetryTimeMs: 5000,
            context: `hindsight.recall[${bankId}]`,
          });

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

    const response = await withRetry(() => this.#client.reflect(bankId, query, opts), {
      retries: 2,
      maxRetryTimeMs: 5000,
      context: `hindsight.reflect[${bankId}]`,
    });
    return { answer: response.text };
  }
}
