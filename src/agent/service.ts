import type {
  MemoryProvider,
  RecallOptions,
  RecallResult,
  ReflectOptions,
  ReflectResult,
  RetainOptions,
  TagGroup,
  TagsMatch,
} from "../memory/provider.js";
import type { SkillsService } from "../skills/skills-service.js";
import type { CodingService } from "./coding/service.js";
import type { ProfileMemoryScope } from "./store/schema.js";

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
 * and folding the profile's `memoryScope` (if any) into every recall
 * and reflect as a `tag_groups` ACL filter. Tools that use this
 * service cannot access other users' data or bypass the scope.
 *
 * Retain is intentionally not scoped — writes go to Hindsight as-is,
 * and tagging happens at extraction time via the Observer drain.
 */
export function createService(
  memory: MemoryProvider,
  bankId: string,
  memoryScope: ProfileMemoryScope | null,
  files: Service["files"],
  coreMemory: Service["coreMemory"],
  stageRetain: StageRetainFn,
  coding?: CodingService,
  skills?: SkillsService,
): Service {
  return {
    memory: {
      recall: (query, opts) => memory.recall(bankId, query, applyScope(memoryScope, opts)),
      retain: (content, opts) => memory.retain(bankId, content, opts),
      reflect: (query, opts) => memory.reflect(bankId, query, applyScope(memoryScope, opts)),
      stageRetain,
    },
    files,
    coreMemory,
    ...(coding !== undefined && { coding }),
    ...(skills !== undefined && { skills }),
  };
}

interface ScopableOptions {
  tags?: string[];
  tagsMatch?: TagsMatch;
  tagGroups?: TagGroup[];
}

/**
 * Fold the profile's scope into recall/reflect options.
 *
 * Null scope → caller's options pass through unchanged. Set scope →
 * caller's tag fields (`tags`, `tagsMatch`, `tagGroups`) are absorbed
 * into a single `tagGroups: [{ and: [...] }]` clause that ANDs the
 * scope leaves with any caller-supplied filter; non-tag options
 * (maxTokens, context, budget) ride through untouched.
 *
 * Note: a caller passing `tagsMatch` without `tags` has no leaf to
 * attach the match mode to, so it's silently dropped — meaningless
 * on its own.
 */
function applyScope<T extends ScopableOptions>(
  memoryScope: ProfileMemoryScope | null,
  opts: T | undefined,
): T {
  if (memoryScope === null) {
    // Empty-object default mirrors how callers treat undefined opts; the
    // cast is safe because every field on T is optional for the no-scope
    // path (caller-supplied opts pass through verbatim otherwise).
    return (opts ?? {}) as T;
  }
  const andChildren: TagGroup[] = buildScopeLeaves(memoryScope);
  if (opts?.tags !== undefined && opts.tags.length > 0) {
    andChildren.push({ tags: opts.tags, match: opts.tagsMatch ?? "any" });
  }
  if (opts?.tagGroups !== undefined) {
    andChildren.push(...opts.tagGroups);
  }
  const { tags: _t, tagsMatch: _m, tagGroups: _g, ...rest } = opts ?? {};
  // TS can't track that destructuring-rest then re-spreading preserves
  // T's structural constraint, even though every removed field is
  // optional on T. Widen via unknown rather than threading a generic
  // helper that obscures the runtime shape.
  return { ...rest, tagGroups: [{ and: andChildren }] } as unknown as T;
}

/**
 * Build the leaves of the scope filter — one leaf per dimension.
 * `any_strict` excludes untagged memories (so legacy un-compartmented
 * rows aren't accidentally exposed) and ORs within the dimension.
 * The caller wraps these in an AND group.
 */
function buildScopeLeaves(scope: ProfileMemoryScope): TagGroup[] {
  return [
    {
      tags: scope.compartments.map((c) => `compartment:${c}`),
      match: "any_strict",
    },
    {
      tags: scope.trust.map((t) => `trust:${t}`),
      match: "any_strict",
    },
  ];
}
