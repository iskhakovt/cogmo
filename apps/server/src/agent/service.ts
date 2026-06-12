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
import type { PipelinesService } from "./pipeline/pipelines-service.js";
import type { SchedulingService } from "./scheduling/scheduling-service.js";
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
    edit(
      path: string,
      oldString: string,
      newString: string,
      opts?: { replaceAll?: boolean },
    ): Promise<void>;
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
  /**
   * Scheduling surface — `schedule_task` / `list_tasks` / `remove_task`
   * agent tools, the wizard's recurring-tasks step, and `/schedules`.
   * Optional so tests can opt out; production wiring always populates
   * it (factory in `src/agent/scheduling/scheduling-service.ts`).
   */
  scheduling?: SchedulingService;
  /**
   * User-defined pipelines surface — `define_pipeline` /
   * `activate_pipeline` / `list_pipelines` agent tools. Optional so tests
   * can opt out; production wiring always populates it (factory in
   * `src/agent/pipeline/pipelines-service.ts`).
   */
  pipelines?: PipelinesService;
}

/**
 * Create a scoped Service for a conversation turn.
 *
 * Wraps a MemoryProvider, scoping all operations to the given bank
 * and folding the profile's `memoryScope` (if any) into every recall
 * and reflect as a `tag_groups` ACL filter. Tools that use this
 * service cannot access other users' data or bypass the scope.
 *
 * `speakerClass` and `restrictedClassNames` together drive fail-closed
 * recall on the speaker dimension: any class flagged `restricted` in
 * `profile_classes` is hidden unless the profile either opts in via
 * `memory_scope.profileClasses` or speaks as the class itself
 * (auto-include — a restricted-speaker profile reads its own writes by
 * default). The NOT leaf is built even when `memoryScope` is null, so
 * a profile without an explicit scope still benefits from fail-closed
 * defaults on marked classes.
 *
 * Retain is intentionally not scoped — writes go to Hindsight as-is,
 * and tagging happens at extraction time via the Observer drain.
 */
export function createService(
  memory: MemoryProvider,
  bankId: string,
  memoryScope: ProfileMemoryScope | null,
  speakerClass: string | null,
  restrictedClassNames: ReadonlyArray<string>,
  files: Service["files"],
  coreMemory: Service["coreMemory"],
  stageRetain: StageRetainFn,
  coding?: CodingService,
  skills?: SkillsService,
  scheduling?: SchedulingService,
  pipelines?: PipelinesService,
): Service {
  return {
    memory: {
      recall: (query, opts) =>
        memory.recall(
          bankId,
          query,
          applyScopeToRecall(memoryScope, speakerClass, restrictedClassNames, opts),
        ),
      retain: (content, opts) => memory.retain(bankId, content, opts),
      reflect: (query, opts) =>
        memory.reflect(
          bankId,
          query,
          applyScopeToReflect(memoryScope, speakerClass, restrictedClassNames, opts),
        ),
      stageRetain,
    },
    files,
    coreMemory,
    ...(coding !== undefined && { coding }),
    ...(skills !== undefined && { skills }),
    ...(scheduling !== undefined && { scheduling }),
    ...(pipelines !== undefined && { pipelines }),
  };
}

/**
 * Fold scope + isolation leaves into a `tag_groups` filter combining
 * any caller-supplied tag filter (tags, tagsMatch, tagGroups). Caller
 * passing `tagsMatch` without `tags` has no leaf to attach the match
 * mode to, so it's silently dropped — meaningless on its own.
 *
 * Caller leaves use `caller.tagsMatch ?? "any"` (the API default), not
 * `any_strict` like the scope leaves. The asymmetry is deliberate: the
 * scope leaves must exclude untagged memories on the compartment/trust
 * dimensions (legacy rows with no tags would otherwise leak across
 * compartments). The caller's leaf is an additional filter on a third
 * dimension — within the same AND group, the scope leaves already
 * exclude untagged on their dimensions, so the caller leaf only widens
 * on the caller's tag dimension.
 */
function buildScopedTagGroups(
  leaves: TagGroup[],
  caller: { tags?: string[]; tagsMatch?: TagsMatch; tagGroups?: TagGroup[] } | undefined,
): TagGroup[] {
  const andChildren: TagGroup[] = [...leaves];
  if (caller?.tags !== undefined && caller.tags.length > 0) {
    andChildren.push({ tags: caller.tags, match: caller.tagsMatch ?? "any" });
  }
  if (caller?.tagGroups !== undefined) {
    andChildren.push(...caller.tagGroups);
  }
  return [{ and: andChildren }];
}

// Strip the simple-tag-filter fields the scope path folds into tagGroups.
// Spreading `rest` carries forward any future RecallOptions/ReflectOptions
// fields automatically — adding a new option won't silently drop on the
// scoped path while passing through unchanged on the no-isolation path.
function applyScopeToRecall(
  memoryScope: ProfileMemoryScope | null,
  speakerClass: string | null,
  restrictedClassNames: ReadonlyArray<string>,
  opts: RecallOptions | undefined,
): RecallOptions {
  const leaves = buildIsolationLeaves(memoryScope, speakerClass, restrictedClassNames);
  if (leaves.length === 0) return opts ?? {};
  const { tags: _tags, tagsMatch: _tagsMatch, tagGroups: _tagGroups, ...rest } = opts ?? {};
  return { ...rest, tagGroups: buildScopedTagGroups(leaves, opts) };
}

function applyScopeToReflect(
  memoryScope: ProfileMemoryScope | null,
  speakerClass: string | null,
  restrictedClassNames: ReadonlyArray<string>,
  opts: ReflectOptions | undefined,
): ReflectOptions {
  const leaves = buildIsolationLeaves(memoryScope, speakerClass, restrictedClassNames);
  if (leaves.length === 0) return opts ?? {};
  const { tags: _tags, tagsMatch: _tagsMatch, tagGroups: _tagGroups, ...rest } = opts ?? {};
  return { ...rest, tagGroups: buildScopedTagGroups(leaves, opts) };
}

/**
 * Build the leaves of the isolation filter — one leaf per dimension.
 *
 * Scope leaves (compartments / trust / profileClasses) are `any_strict`:
 * they exclude untagged memories so legacy un-tagged rows aren't
 * accidentally exposed.
 *
 * The class leaf is identity-aware: when `scope.profileClasses` is set,
 * the leaf's tag set is `scope.profileClasses ∪ {speakerClass}`. Speaker
 * auto-include is structural, not an opt-in — a profile's recall always
 * sees its own writes regardless of how the operator wrote `classes=…`.
 * This matches the convention in personal-data systems (email's "Sent"
 * folder, Drive owner-implicit-read, PostgreSQL RLS's `owner =
 * current_user` idiom): self-recall is a primitive of the actor, not a
 * configuration parameter. If a future use case needs write-only-no-self-
 * recall (auditor / one-way channels), express it via a separate identity
 * (e.g. `profile.profileClass = null`), not by misconfiguring the scope.
 *
 * The restricted-class NOT leaf is independent of `memoryScope` — it
 * applies even when scope is null, so a deployment that opts a class
 * into `restricted` gets fail-closed defaults without each profile
 * having to enumerate its allow-list. A class is excluded when it's
 * restricted AND not in the same effective opt-in set
 * (`scope.profileClasses ∪ {speakerClass}`), so the speaker auto-include
 * applies symmetrically across both leaves.
 *
 * The NOT leaf uses `match: "any"` (not `any_strict`): it only
 * excludes memories that carry one of the restricted tags. Untagged
 * memories pass — pre-feature rows from any speaker are unaffected
 * because they carry no `profile_class:*` tag at all.
 */
function buildIsolationLeaves(
  scope: ProfileMemoryScope | null,
  speakerClass: string | null,
  restrictedClassNames: ReadonlyArray<string>,
): TagGroup[] {
  const leaves: TagGroup[] = [];
  if (scope !== null) {
    leaves.push(
      {
        tags: scope.compartments.map((c) => `compartment:${c}`),
        match: "any_strict",
      },
      {
        tags: scope.trust.map((t) => `trust:${t}`),
        match: "any_strict",
      },
    );
    if (scope.profileClasses !== undefined && scope.profileClasses.length > 0) {
      const classes =
        speakerClass !== null && !scope.profileClasses.includes(speakerClass)
          ? [...scope.profileClasses, speakerClass]
          : scope.profileClasses;
      leaves.push({
        tags: classes.map((c) => `profile_class:${c}`),
        match: "any_strict",
      });
    }
  }
  const optedIn = new Set<string>(scope?.profileClasses ?? []);
  if (speakerClass !== null) optedIn.add(speakerClass);
  const excluded = restrictedClassNames.filter((c) => !optedIn.has(c));
  if (excluded.length > 0) {
    leaves.push({
      not: { tags: excluded.map((c) => `profile_class:${c}`), match: "any" },
    });
  }
  return leaves;
}
