/**
 * Memory provider interface — the plugin contract for semantic memory.
 *
 * Implementations can use Hindsight, a local vector store, or any other backend.
 * Domain code depends on this interface, never on a concrete implementation.
 */
export interface MemoryProvider {
  readonly name: string;

  /** Store a memory. */
  retain(bankId: string, content: string, options?: RetainOptions): Promise<void>;

  /** Store multiple memories in one call. Supports per-item observation scoping. */
  retainBatch(bankId: string, items: RetainBatchItem[]): Promise<void>;

  /** Semantic search for relevant memories. */
  recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResult>;

  // TODO: not yet exposed as a Service method — start with recall+retain,
  // add reflect when recall proves insufficient for synthesis-heavy queries.
  /** Agentic reasoning loop — synthesizes an answer from memories (not consolidation). */
  reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResult>;
}

export interface RetainOptions {
  context?: string;
  metadata?: Record<string, string>;
  tags?: string[];
}

export interface RetainBatchItem {
  content: string;
  context?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  observationScopes?: "per_tag" | "combined";
}

/** How to match tags during recall/reflect: 'any' (OR, includes untagged), 'all' (AND, includes untagged), 'any_strict' (OR, excludes untagged), 'all_strict' (AND, excludes untagged). */
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";

export interface RecallOptions {
  maxTokens?: number;
  tags?: string[];
  tagsMatch?: TagsMatch;
}

export interface RecallResult {
  memories: Memory[];
}

export interface Memory {
  content: string;
  type: string;
  metadata?: Record<string, string>;
}

export interface ReflectOptions {
  context?: string;
  tags?: string[];
  tagsMatch?: TagsMatch;
}

export interface ReflectResult {
  answer: string;
}
