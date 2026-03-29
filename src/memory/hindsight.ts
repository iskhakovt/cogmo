import { HindsightClient } from "@vectorize-io/hindsight-client";
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
 */
export class HindsightMemoryProvider implements MemoryProvider {
  readonly name = "hindsight";
  #client: HindsightClient;

  constructor(baseUrl: string) {
    this.#client = new HindsightClient({ baseUrl });
  }

  async retain(bankId: string, content: string, options?: RetainOptions): Promise<void> {
    const opts: Parameters<HindsightClient["retain"]>[2] = {};
    if (options?.context !== undefined) opts.context = options.context;
    if (options?.metadata !== undefined) opts.metadata = options.metadata;
    if (options?.tags !== undefined) opts.tags = options.tags;
    await this.#client.retain(bankId, content, opts);
  }

  async recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResult> {
    const opts: Parameters<HindsightClient["recall"]>[2] = {};
    if (options?.maxTokens !== undefined) opts.maxTokens = options.maxTokens;
    if (options?.tags !== undefined) opts.tags = options.tags;

    const response = await this.#client.recall(bankId, query, opts);

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

    const response = await this.#client.reflect(bankId, query, opts);
    return { answer: response.text };
  }
}
