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

/**
 * Compound boolean tag filter. Mirrors Hindsight's `tag_groups` shape so
 * the provider can pass it through unchanged. Used for ACL-style filters
 * that combine multiple tag dimensions (e.g. AND across compartment and
 * trust, OR within each).
 */
export interface TagGroupLeaf {
  tags: string[];
  match?: TagsMatch;
}
export interface TagGroupAnd {
  and: TagGroup[];
}
export interface TagGroupOr {
  or: TagGroup[];
}
export interface TagGroupNot {
  not: TagGroup;
}
export type TagGroup = TagGroupLeaf | TagGroupAnd | TagGroupOr | TagGroupNot;

/**
 * Reasoning budget for reflect() — controls how many LLM calls Hindsight
 * makes inside its agentic loop. Higher budgets allow deeper multi-hop
 * reasoning at higher cost and latency.
 */
export type ReflectBudget = "low" | "mid" | "high";

export interface RecallOptions {
  maxTokens?: number;
  tags?: string[];
  tagsMatch?: TagsMatch;
  /** Compound tag filter — passed through to Hindsight's `tag_groups`. Combine with simple `tags` only when intentional. */
  tagGroups?: TagGroup[];
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
  /** Compound tag filter — passed through to Hindsight's `tag_groups`. Combine with simple `tags` only when intentional. */
  tagGroups?: TagGroup[];
  budget?: ReflectBudget;
}

export interface ReflectResult {
  answer: string;
}
