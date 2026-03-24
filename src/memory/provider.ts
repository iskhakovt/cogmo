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

  /** Semantic search for relevant memories. */
  recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResult>;

  /** Generate a contextual answer from memories. */
  reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResult>;
}

export interface RetainOptions {
  context?: string;
  metadata?: Record<string, string>;
  tags?: string[];
}

export interface RecallOptions {
  maxTokens?: number;
  tags?: string[];
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
}

export interface ReflectResult {
  answer: string;
}
