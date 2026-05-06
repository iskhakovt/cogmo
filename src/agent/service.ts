import type {
  MemoryProvider,
  RecallOptions,
  RecallResult,
  ReflectOptions,
  ReflectResult,
  RetainOptions,
} from "../memory/provider.js";
import type { SkillsService } from "../skills/skills-service.js";
import type { CodingService } from "./coding/service.js";

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
- **Update, don't duplicate**: If you learn something that contradicts a previous memory, retain the new version with context about the change.
- **Recall vs reflect**: \`memory_recall\` returns raw matching facts — fast, cheap, best for looking something up. \`memory_reflect\` runs an agentic synthesis loop across many memories — slower and more expensive, best for open-ended questions that need multi-hop reasoning (e.g. "summarise what I know about X", "what risks should I watch for on project Y?").`;

/** Prompt guidance for the coreMemory Service namespace. */
export const CORE_MEMORY_PROMPT_GUIDANCE = `You have core memory blocks — structured notes about your user and ongoing context that are always visible to you. Update them as you learn new things. Current blocks are shown in the User section of your instructions.`;

export interface CoreMemoryBlock {
  key: string;
  content: string;
}

/** Options for staging a live retain. Only `context` for now; future tag overrides land here. */
export interface StageRetainOptions {
  context?: string;
}

/**
 * Stage a memory write to the agent store's pending_memories table.
 *
 * Pre-bound to a user — `createService` injects a closure that captures
 * userId so the tool surface stays user-agnostic.
 */
export type StageRetainFn = (content: string, opts?: StageRetainOptions) => Promise<void>;

export interface Service {
  memory: {
    recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
    retain(content: string, opts?: RetainOptions): Promise<void>;
    reflect(query: string, opts?: ReflectOptions): Promise<ReflectResult>;
    /**
     * Stage a fact for Observer classification + retention to Hindsight.
     * Returns once the row is durable in pending_memories; the fact becomes
     * searchable in Hindsight on the next conversation/idle drain.
     */
    stageRetain: StageRetainFn;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(prefix?: string): Promise<FileEntry[]>;
  };
  coreMemory: {
    get(): Promise<ReadonlyArray<CoreMemoryBlock>>;
    update(key: string, content: string): Promise<void>;
  };
  /**
   * Coding-delegation surface. Optional — only present when the sandbox
   * module is initialized (SANDBOX_RUNTIME set). Tools that depend on it
   * fail with a clear error when absent.
   */
  coding?: CodingService;
  /**
   * Skills authoring surface — register / approve / deny / rollback.
   * Optional because some tests skip the skills runner; production wiring
   * always populates it.
   */
  skills?: SkillsService;
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
  coreMemory: Service["coreMemory"],
  stageRetain: StageRetainFn,
  coding?: CodingService,
  skills?: SkillsService,
): Service {
  function attachProfileTags(opts: { tags?: string[] } | undefined) {
    return {
      ...opts,
      tags: [...profileTags, ...(opts?.tags ?? [])],
    };
  }

  return {
    memory: {
      recall: (query, opts) => memory.recall(bankId, query, attachProfileTags(opts)),
      retain: (content, opts) => memory.retain(bankId, content, attachProfileTags(opts)),
      reflect: (query, opts) => memory.reflect(bankId, query, attachProfileTags(opts)),
      stageRetain,
    },
    files,
    coreMemory,
    ...(coding !== undefined && { coding }),
    ...(skills !== undefined && { skills }),
  };
}
