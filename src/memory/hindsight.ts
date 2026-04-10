import { HindsightClient } from "@vectorize-io/hindsight-client";
import { withRetry } from "../util/with-retry.js";
import type {
  Memory,
  MemoryProvider,
  RecallOptions,
  RecallResult,
  ReflectOptions,
  ReflectResult,
  RetainOptions,
} from "./provider.js";

/**
 * Hindsight memory provider — talks to a self-hosted Hindsight server via HTTP.
 *
 * All methods wrap the underlying HindsightClient call in withRetry with
 * the default 3 retries (no override). Hindsight is self-hosted and
 * expected to blip during restarts/OOMs/image bumps, so retrying more
 * aggressively than for external rate-limited APIs is appropriate.
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
    await withRetry(() => this.#client.retain(bankId, content, opts), {
      context: `hindsight.retain[${bankId}]`,
    });
  }

  async recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResult> {
    const opts: Parameters<HindsightClient["recall"]>[2] = {};
    if (options?.maxTokens !== undefined) opts.maxTokens = options.maxTokens;
    if (options?.tags !== undefined) opts.tags = options.tags;

    const response = await withRetry(() => this.#client.recall(bankId, query, opts), {
      context: `hindsight.recall[${bankId}]`,
    });

    const memories: Memory[] = (response.results ?? []).map((r) => {
      const memory: Memory = { content: r.text, type: r.type ?? "unknown" };
      if (r.metadata) memory.metadata = r.metadata;
      return memory;
    });

    return { memories };
  }

  async reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResult> {
    const opts: Parameters<HindsightClient["reflect"]>[2] = {};
    if (options?.context !== undefined) opts.context = options.context;
    if (options?.tags !== undefined) opts.tags = options.tags;

    const response = await withRetry(() => this.#client.reflect(bankId, query, opts), {
      context: `hindsight.reflect[${bankId}]`,
    });
    return { answer: response.text };
  }
}
