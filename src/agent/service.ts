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
export interface FileEntry {
  path: string;
  size: number;
  lastModified: Date;
}

/** Prompt guidance for the memory Service namespace. */
export const MEMORY_PROMPT_GUIDANCE = `You have persistent memory across conversations. Use it well:
- **Recall first**: At the start of a conversation or when a topic comes up, check if you already know relevant context.
- **Retain important things**: Facts about the user, their preferences, decisions made, commitments, project context. Ask yourself: "would knowing this help me in a future conversation?"
- **Don't over-retain**: Skip greetings, small talk, information already saved in files, and things the user said are temporary.
- **Update, don't duplicate**: If you learn something that contradicts a previous memory, retain the new version with context about the change.`;

export interface Service {
  memory: {
    recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
    retain(content: string, opts?: RetainOptions): Promise<void>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(prefix?: string): Promise<FileEntry[]>;
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
  files: Service["files"],
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
    files,
  };
}
