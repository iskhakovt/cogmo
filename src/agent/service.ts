import type {
  MemoryProvider,
  RecallOptions,
  RecallResult,
  RetainOptions,
} from "../memory/provider.js";

/**
 * Service interface — the ACL boundary between tools and external systems.
 *
 * Tools interact with the outside world exclusively through this interface.
 * The orchestrator constructs a scoped Service per conversation turn,
 * baking in userId, profile access rules, and tag filters. Tools never
 * see raw service references (MemoryProvider, Database, etc.).
 *
 * Today this is an in-process typed interface. For future WASM plugins,
 * a bridge implements Service by routing calls across the boundary.
 * Tools always see the same interface regardless of execution environment.
 */
export interface Service {
  memory: {
    recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
    retain(content: string, opts?: RetainOptions): Promise<void>;
  };
}

/**
 * Create a scoped Service for a conversation turn.
 *
 * Wraps a MemoryProvider, scoping all operations to the given bank
 * and merging profileTags into every call. Tools that use this
 * service cannot access other users' data or bypass tag filters.
 */
export function createService(
  memory: MemoryProvider,
  bankId: string,
  profileTags: readonly string[],
): Service {
  return {
    memory: {
      recall: (query, opts) =>
        memory.recall(bankId, query, {
          ...opts,
          tags: [...profileTags, ...(opts?.tags ?? [])],
        }),
      retain: (content, opts) =>
        memory.retain(bankId, content, {
          ...opts,
          tags: [...profileTags, ...(opts?.tags ?? [])],
        }),
    },
  };
}
