import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as R from "remeda";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { CacheDialect } from "../../llm/cache-dialect.js";
import { NOT_TURN_ROW_JSONPATH } from "../../llm/content.js";
import type { ContentBlock, Message } from "../../llm/types.js";
import { skills } from "../../skills/store/schema.js";
import { previewInboundText } from "../../transport/content.js";
import { inboundMessages } from "../../transport/store/schema.js";
import { truncate } from "../../util/string.js";
import { IDENTITY_BLOCK_KEY, type ScopedCoreMemoryBlock } from "../core-memory/scope.js";
import type { EvolutionEventPayload } from "../evolution/event-schema.js";
import { isCoreCompartment } from "../evolution/memory-extraction-schema.js";
import { imageModelSlug } from "../image-tools.js";
import type { AutoRecallMode } from "../recall-gate.js";
import {
  RULE_SECTIONS,
  type RuleSection,
  ruleSection,
  type SectionedRule,
} from "../rule-sections.js";
import type { TurnContext } from "../turn-context.js";
import {
  CustomCompartmentCapExceededError,
  ImageModelSlugCollisionError,
  InvalidNameError,
  InvalidProviderConfigError,
  ProfileClassInUseError,
  ProfileInUseError,
  ReservedCompartmentNameError,
  RuleGroupChangedError,
  translateReferentialViolation,
  translateUniqueViolation,
  UnknownProfileClassError,
} from "./errors.js";
import {
  aliases,
  type CooldownState,
  conversationSummaries,
  conversations,
  coreMemoryBlocks,
  customCompartments,
  type EvolutionTriggerValue,
  evolutionEvents,
  type ImageModelCapabilities,
  type ImageProviderAttrs,
  type ImageProviderTypeValue,
  INSTRUCTION_RULE_KEY,
  imageModels,
  imageProviders,
  LIVE_INSTRUCTION_RULE,
  type LlmProviderTypeValue,
  llmProviders,
  messages,
  modelProviders,
  normalizedRuleText,
  type ProfileMemoryScope,
  type ProviderAttrs,
  ProviderAttrsSchema,
  pendingMemories,
  profileClasses,
  profiles,
  type SteeringRuleSourceValue,
  type SttProviderTypeValue,
  type SummarySourceValue,
  scheduledTasks,
  steeringRules,
  subAgents,
  systemPromptSnapshots,
  type ToolSet,
  type TtsProviderTypeValue,
  turnContexts,
  users,
  voiceConfig,
} from "./schema.js";

/**
 * Hard cap on per-user custom compartments. Keeps the classifier prompt
 * bounded and protects accuracy — beyond ~10 buckets the LLM's
 * compartment choice degrades, and the prompt grows linearly with the
 * count. Cap is enforced at insert time (count + insert in one tx).
 */
export const CUSTOM_COMPARTMENT_LIMIT = 10;

/**
 * The most live instruction rules a user holds, which keeps `# Rules` near 45
 * rules (design/evolution.md → Explicit Instructions → Tools). Two concurrent
 * sets can pass it by one: snapshot isolation doesn't predicate-lock, and the
 * residual is benign at single-user scale.
 */
export const INSTRUCTION_RULE_LIMIT = 20;

/** The retired rules `listRules` returns, most recently retired first. */
const RETIRED_RULES_LISTED = 20;

/**
 * Canonical shape for compartment + profile-class names. Lowercase ASCII
 * letters / digits / hyphen / underscore, must start with a letter, ≤32
 * chars. Mirrors the format of `CORE_COMPARTMENTS` values so the merged
 * set is uniform, prevents `Work` / `work` conceptual duplicates, and
 * avoids weird Unicode or whitespace landing in Hindsight tag values.
 */
const CANONICAL_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Sentinel for `messages.output_tokens` meaning "unknown — force a full token
 * count on next turn." Used on:
 *   1. Rows migrated from before the column existed (backfill in 0008).
 *   2. Rows that never had a meaningful output count (user rows, intermediate
 *      tool turns) — harmless because the fast path only reads the most
 *      recent **assistant** row, which always carries the real count.
 */
export const UNKNOWN_OUTPUT_TOKENS = -1;

/** Voice mode preference. Mirrors the `voice_mode` pgEnum exactly. */
export type VoiceMode = "auto" | "always" | "never";

/** Mirrors the `pending_memory_source` PG enum. */
export type PendingMemorySource = "live_retain" | "migration" | "skill";

/** The sources that name no skill. */
export type UnnamedMemorySource = Exclude<PendingMemorySource, "skill">;

/** A skill's write: a `skill` row names its skill. */
export interface SkillMemoryOrigin {
  source: "skill";
  skillName: string;
}

/**
 * Who staged a pending row. Only a `skill` row names a skill
 * (`chk_pending_memories_skill_name`).
 */
export type PendingMemoryOrigin = { source: UnnamedMemorySource } | SkillMemoryOrigin;

/** Mirrors the `schedule_kind` PG enum. */
export type ScheduleKind = "recurring" | "one_off";

/** Mirrors the `schedule_source` PG enum. */
export type ScheduleSource = "agent" | "wizard" | "manual";

/**
 * A user/agent-defined scheduled task. `cron` is null for one-off rows
 * (the row fires once at `nextRunAt` and then flips `enabled = false`),
 * non-null for recurring rows (the ticker advances `nextRunAt` on every
 * fire). `timezone` anchors the cron expression so DST transitions don't
 * drift; `nextRunAt` itself is stored in UTC. See design/scheduling.md.
 */
export interface ScheduledTask {
  id: string;
  userId: string;
  profileId: string;
  kind: ScheduleKind;
  cron: string | null;
  timezone: string;
  prompt: string;
  nextRunAt: Date;
  lastRunAt: Date | null;
  enabled: boolean;
  catchupMissed: boolean;
  source: ScheduleSource;
  createdAt: Date;
}

/**
 * A memory write awaiting Observer classification before retention to
 * Hindsight. `profileClass` is denormalised onto the row at read time via
 * a JOIN on `profiles` so the drain can stamp the correct
 * `profile_class:<class>` tag without having to look up the profile per
 * row (or worse, per-row group). `null` when either the staging profile
 * was unclassed or the lineage isn't available — pre-feature live
 * retains, migration backfill, or rows whose staging profile was deleted
 * (`profile_id` SET NULL). `profileId` is the staging profile, whose
 * `memory`-category rules the drain applies; null where it has none or it
 * belongs to another user.
 * `skillName` names the staging skill on a `skill` row and is null otherwise.
 */
export interface PendingMemory {
  id: string;
  content: string;
  context: string | null;
  source: PendingMemorySource;
  profileId: string | null;
  profileClass: string | null;
  skillName: string | null;
  createdAt: Date;
}

export interface Profile {
  id: string;
  userId: string | null; // null = org profile (read-only via Transport)
  name: string;
  basePrompt: string;
  model: string;
  summarizationModel: string | null;
  extractionModel: string | null;
  autoRecall: AutoRecallMode;
  /** Profile-level voice mode default; overridden per-conversation. */
  voiceMode: VoiceMode;
  toolSet: ToolSet;
  memoryScope: ProfileMemoryScope | null; // null = no compartment/trust/class restriction
  /** Speaker-isolation label; null = unclassed (Observer emits no class tag). */
  profileClass: string | null;
  /**
   * Soft cap on a single outbound message's source-text length before the
   * streaming adapter rotates to a new message. Lower for short-burst UX.
   */
  streamChunkChars: number;
  /**
   * When false, the streaming adapter never edits a message mid-stream — it
   * only emits whole chunks on boundary / finish, drops tool/status banners,
   * and falls back to a native typing indicator while in flight.
   */
  streamEdits: boolean;
  /**
   * When `on`, the plan orchestrator auto-stamps `plan_approved_at` and
   * emits `coding/task/plan-approved` once the plan text is persisted,
   * skipping the Telegram approve/revise/cancel round trip. The plan
   * still streams to Telegram for visibility. Default `off`. Toggled via
   * `/profile autoapprove`.
   */
  codingAutoapproveMode: CodingAutoapproveMode;
}

export type CodingAutoapproveMode = "off" | "on";

export interface ProfileUpdates {
  name?: string;
  basePrompt?: string;
  model?: string;
  summarizationModel?: string | null;
  extractionModel?: string | null;
  autoRecall?: AutoRecallMode;
  voiceMode?: VoiceMode;
  toolSet?: ToolSet;
  memoryScope?: ProfileMemoryScope | null;
  streamChunkChars?: number;
  streamEdits?: boolean;
  codingAutoapproveMode?: CodingAutoapproveMode;
}

/** Per-user registry row for `profiles.profile_class`. */
export interface ProfileClass {
  id: string;
  userId: string;
  name: string;
  description: string;
  /**
   * When true, memories tagged `profile_class:<name>` are hidden from any
   * profile that doesn't explicitly opt the class into its
   * `memory_scope.profileClasses` (and that doesn't speak as the class
   * itself). Recall fail-closed for sensitive classes.
   */
  restricted: boolean;
  createdAt: Date;
}

/** What `upsertCoreMemoryBlock` did to the block. */
export type CoreMemoryUpsertOutcome = "created" | "updated" | "unchanged";

/**
 * Per-user registry row for a custom compartment. `description` is loaded
 * by the Observer on each fire and templated into the classifier prompt
 * (`buildCompartmentDefinitions`) — it's an LLM-facing definition, not
 * documentation.
 */
export interface CustomCompartment {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: Date;
}

export interface ConversationSummary {
  id: string;
  profileName: string;
  alias: string | null;
  lastMessagePreview: string;
  lastMessageAt: Date;
}

/**
 * A row from `conversation_summaries` — the persisted output of the summarize
 * compaction strategy. Distinct from `ConversationSummary`, which is the
 * `/sessions` listing row.
 */
export interface CompactionSummary {
  id: string;
  conversationId: string;
  summary: string;
  throughMessageId: string;
  messagesSummarized: number;
  model: string;
  source: SummarySourceValue;
  createdAt: Date;
}

/** An Observer extraction phase that keeps a cursor on the conversation. */
export type ObservedPhase = "corrections" | "memories";

/** See `AgentStore.getObserverBounds`. */
export interface ObserverBounds {
  messageCount: number;
  lastMessageId: string | null;
  /** Per phase, the last message it extracted from; null until it has. */
  observedThrough: Readonly<Record<ObservedPhase, string | null>>;
}

/** A row from `turn_contexts`: the block a turn-starting user message was sent with. */
export interface StoredTurnContext {
  messageId: string;
  rendered: string;
  context: TurnContext;
}

/** A row from `system_prompt_snapshots`: one epoch's system prompt. */
export interface SystemPromptSnapshot {
  id: string;
  conversationId: string;
  openedBy: string;
  historyStart: string;
  rendered: string;
  configDigest: string;
  createdAt: Date;
}

/**
 * One past turn for the web chat history read — `text` is the message's
 * displayable prose. Mirrored in `@cogmo/contracts`; see that definition for
 * why tool-call cards aren't reconstructed here.
 */
export interface ChatHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** A row from `image_providers`. `type` is narrowed via the `pgEnum`. */
export interface ImageProviderRow {
  id: string;
  name: string;
  type: ImageProviderTypeValue;
  baseUrl: string | null;
  secretId: string;
  attrs: ImageProviderAttrs;
}

/** A row from `image_models`. `capabilities` is the validated JSONB bag. */
export interface ImageModelRow {
  id: string;
  providerId: string;
  name: string;
  modelString: string;
  description: string;
  capabilities: ImageModelCapabilities;
  userSelectable: boolean;
}

/**
 * Joined view: an `image_models` row with its owning `image_providers` row
 * inlined. Returned by `listImageModelsWithProvider` so bootstrap can build
 * the tool catalog without a second round-trip per row.
 */
export interface ImageModelWithProvider extends ImageModelRow {
  provider: ImageProviderRow;
}

/**
 * A row from `sub_agents`. `systemPrompt` is null for a pure model-as-tool
 * sub-agent (no standing persona); `model` routes via the LlmProviderResolver.
 */
export interface SubAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string | null;
  model: string;
}

/**
 * The rules one turn can see: global and `profileId`'s own, and among
 * instruction rules only `userId`'s. A null `userId` sees none, which is how a
 * third-party or unloadable profile withholds them.
 */
export interface RuleScope {
  profileId: string;
  userId: string | null;
}

/** A standing instruction the user stated; see `setInstructionRule`. */
export interface InstructionRuleParams {
  rule: string;
  category: "style" | "domain" | "memory";
  userId: string;
  /** Null for every profile; a restricted-class profile's own id otherwise. */
  profileId: string | null;
  /** Null for every channel. */
  channelType: string | null;
  /** The user's words that state it. */
  quote: string;
}

/**
 * The live instruction rule a set wrote (`new`) or found (`existing`), whether
 * an earlier call or a retry of this one wrote it; `createdAt` tells them apart.
 */
export interface InstructionRuleRow {
  kind: "new" | "existing";
  id: string;
  createdAt: Date;
}

/**
 * `at_limit`: the user holds `INSTRUCTION_RULE_LIMIT` live rules and nothing
 * was written. A value, not a throw: `rule_set` turns it into a tool error,
 * throwing it only to roll back its `replaces` retirements.
 */
export type SetInstructionRuleResult = InstructionRuleRow | { kind: "at_limit"; live: number };

/** A rule whose text matched, as `retireRulesByText` returns it. */
export interface RuleMatch {
  id: string;
  rule: string;
  source: SteeringRuleSourceValue;
  profileId: string | null;
  channelType: string | null;
  /** When the rule was retired; null while it is live. */
  retractedAt: Date | null;
}

/** The rules visible to a scope whose text matched, by what retiring did to them. */
export interface RetireRulesResult {
  /** Retired by this call. */
  retired: ReadonlyArray<RuleMatch>;
  /** Retired before it, so a repeat finds what the first call retired. */
  alreadyRetired: ReadonlyArray<RuleMatch>;
  /** Live, and not the scope's to retire: an operator rule, a channel default, or a wider rule in a restricted class. */
  notRemovable: ReadonlyArray<RuleMatch>;
}

/** A steering rule with what review shows of it. */
export interface ReviewedRule {
  id: string;
  rule: string;
  category: string;
  source: SteeringRuleSourceValue;
  section: RuleSection;
  profileId: string | null;
  channelType: string | null;
  observationCount: number;
  quote: string | null;
  createdAt: Date;
  retractedAt: Date | null;
}

/** The rules a scope sees: live in `# Rules` order, then learning, then the latest retired. */
export interface RuleReview {
  live: ReadonlyArray<ReviewedRule>;
  learning: ReadonlyArray<ReviewedRule>;
  retired: ReadonlyArray<ReviewedRule>;
}

/** The sources a user may retire: their instructions and what was learned from them. */
const REMOVABLE_RULE_SOURCES: ReadonlyArray<SteeringRuleSourceValue> = [
  "instruction",
  "correction",
  "evolution",
];

/** The sources consolidation merges. */
const LEARNED_RULE_SOURCES: ReadonlyArray<SteeringRuleSourceValue> = ["correction", "evolution"];

/**
 * `# Rules` order within a section: `safety` first (only operators write it),
 * then the narrower scope, so it is listed before a wider rule it conflicts
 * with, then priority, then the newest, which supersedes an older rule on
 * equal scope and priority. The `id` also keeps the order fixed across an
 * in-place update, which moves a row in the heap.
 */
const RULE_ORDER = [
  desc(eq(steeringRules.category, "safety")),
  asc(isNull(steeringRules.profileId)),
  asc(isNull(steeringRules.channelType)),
  asc(steeringRules.priority),
  desc(steeringRules.id),
];

function visibleTo(scope: RuleScope): SQL | undefined {
  return and(
    or(isNull(steeringRules.profileId), eq(steeringRules.profileId, scope.profileId)),
    scope.userId === null
      ? isNull(steeringRules.userId)
      : or(isNull(steeringRules.userId), eq(steeringRules.userId, scope.userId)),
  );
}

/** The user's live instruction rules. */
function liveInstructionRulesOf(userId: string): SQL | undefined {
  return and(
    eq(steeringRules.source, "instruction"),
    isNull(steeringRules.retractedAt),
    eq(steeringRules.userId, userId),
  );
}

/** What correction extraction reads of a rule. */
const EXTRACTION_RULE_COLUMNS = {
  id: steeringRules.id,
  rule: steeringRules.rule,
  category: steeringRules.category,
  active: steeringRules.active,
  observationCount: steeringRules.observationCount,
  priority: steeringRules.priority,
  channelType: steeringRules.channelType,
};

/** A steering rule as correction extraction reads it. */
export type ExtractionRule = Pick<
  typeof steeringRules.$inferSelect,
  keyof typeof EXTRACTION_RULE_COLUMNS
>;

/** A live `memory`-category rule, as `getMemoryRules` returns it. */
export interface MemoryRule {
  rule: string;
  /** Null for every profile. */
  profileId: string | null;
  /** An instruction rule the user set, which a third-party profile doesn't see. */
  fromUser: boolean;
}

/** The rules of `rules` that a staging profile sees; a null profile sees the global ones. */
export function memoryRulesFor(
  rules: ReadonlyArray<MemoryRule>,
  profileId: string | null,
): ReadonlyArray<MemoryRule> {
  return rules.filter((r) => r.profileId === null || r.profileId === profileId);
}

/**
 * Whether `rules` hold one of the user's own rules that a profile not seeing
 * the user's instruction rules (`seesUserRules` false) would be bound by
 * without being shown it.
 */
export function bindsUnseenUserRule(
  rules: ReadonlyArray<MemoryRule>,
  seesUserRules: boolean,
): boolean {
  return !seesUserRules && rules.some((r) => r.fromUser);
}

/** Which of a user's pending rows a read takes. */
export interface PendingMemoryFilter {
  /** Only rows staged by this profile. */
  stagedBy?: string;
  /** Only rows of these sources. */
  sources?: ReadonlyArray<PendingMemorySource>;
  /** Only these rows. */
  ids?: ReadonlyArray<string>;
}

/** A user's pending rows, narrowed by `filter`. */
function pendingRowsOf(userId: string, filter: PendingMemoryFilter | undefined): SQL | undefined {
  return and(
    eq(pendingMemories.userId, userId),
    filter?.stagedBy === undefined ? undefined : eq(pendingMemories.profileId, filter.stagedBy),
    filter?.sources === undefined
      ? undefined
      : inArray(pendingMemories.source, [...filter.sources]),
    filter?.ids === undefined ? undefined : inArray(pendingMemories.id, [...filter.ids]),
  );
}

function textMatches(text: string): SQL {
  return eq(normalizedRuleText(steeringRules.rule), normalizedRuleText(sql`${text}`));
}

/**
 * `''` shares `uq_steering_rules_instruction`'s key with NULL (every channel)
 * but matches only itself in `inScope`, so a set would answer `existing` for
 * another scope's rule.
 */
function assertChannelType(channelType: string | null): void {
  if (channelType === "") {
    throw new Error("empty channel type: pass null for every channel");
  }
}

/** Exactly this profile and channel scope, NULL matching NULL. */
function inScope(profileId: string | null, channelType: string | null): SQL | undefined {
  return and(
    profileId === null ? isNull(steeringRules.profileId) : eq(steeringRules.profileId, profileId),
    channelType === null
      ? isNull(steeringRules.channelType)
      : eq(steeringRules.channelType, channelType),
  );
}

/**
 * Keyed insert on `uq_steering_rules_instruction`: see `.claude/rules/inngest.md`.
 * Raw SQL because `onConflictDoUpdate` takes column targets only, and the
 * index's key is expressions.
 */
async function upsertInstructionRule(
  tx: Transaction,
  params: InstructionRuleParams,
): Promise<InstructionRuleRow> {
  const upserted = tx
    .$with("upserted", {
      id: sql<string>`id`.as("id"),
      createdAt: sql<Date>`created_at`.mapWith(steeringRules.createdAt).as("created_at"),
      inserted: sql<boolean>`inserted`.as("inserted"),
    })
    .as(sql`
      INSERT INTO ${steeringRules}
        (rule, category, active, source, priority, observation_count, user_id, profile_id,
          channel_type, quote)
      VALUES (${params.rule}, ${params.category}, true, 'instruction', 100, 1, ${params.userId},
        ${params.profileId}, ${params.channelType}, ${params.quote})
      ON CONFLICT (${sql.join([...INSTRUCTION_RULE_KEY], sql`, `)}) WHERE ${LIVE_INSTRUCTION_RULE}
      DO UPDATE SET user_id = excluded.user_id
      RETURNING id, created_at, (xmax = 0) AS inserted
    `);
  const { inserted, ...row } = single(await tx.with(upserted).select().from(upserted));
  return { kind: inserted ? "new" : "existing", ...row };
}

const RULE_MATCH_COLUMNS = {
  id: steeringRules.id,
  rule: steeringRules.rule,
  source: steeringRules.source,
  profileId: steeringRules.profileId,
  channelType: steeringRules.channelType,
  retractedAt: steeringRules.retractedAt,
};

const REVIEWED_RULE_COLUMNS = {
  ...RULE_MATCH_COLUMNS,
  category: steeringRules.category,
  observationCount: steeringRules.observationCount,
  quote: steeringRules.quote,
  createdAt: steeringRules.createdAt,
};

const PREVIEW_MAX_CHARS = 120;

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  return (
    typeof b === "object" &&
    b !== null &&
    "type" in b &&
    (b as { type: unknown }).type === "text" &&
    "text" in b &&
    typeof (b as { text: unknown }).text === "string"
  );
}

/** Extract a short preview string from a `messages.content` jsonb value. */
function previewFromContent(content: unknown): string {
  if (typeof content === "string") return truncate(previewInboundText(content), PREVIEW_MAX_CHARS);
  if (!Array.isArray(content)) return "";
  const block = R.find(content, isTextBlock);
  return block ? truncate(previewInboundText(block.text), PREVIEW_MAX_CHARS) : "";
}

/**
 * Validate `(type, base_url)` for an image provider. Throws
 * `InvalidProviderConfigError` with a wizard-friendly reason for the
 * cases the DB CHECK can't express. The DB CHECK still enforces the
 * coarser `openai_compatible ↔ NOT NULL`, `venice ↔ NOT NULL`,
 * `fal ↔ NULL` invariant — this guard fires first so the wizard gets a
 * useful message instead of an opaque 23514.
 */
function validateImageProviderBaseUrl(type: ImageProviderTypeValue, baseUrl: string | null): void {
  // Exhaustive switch over `image_provider_type` — adding an enum value
  // without a matching case is a compile error. Same pattern as
  // `buildProvider` in src/llm/resolver.ts.
  switch (type) {
    case "fal":
      if (baseUrl !== null) {
        throw new InvalidProviderConfigError("fal does not accept a base_url");
      }
      return;
    case "openai_compatible":
    case "venice": {
      if (baseUrl === null) {
        throw new InvalidProviderConfigError(`${type} requires a base_url`);
      }
      let parsed: URL;
      try {
        parsed = new URL(baseUrl);
      } catch {
        throw new InvalidProviderConfigError(`base_url is not a valid URL: ${baseUrl}`);
      }
      if (parsed.protocol !== "https:") {
        throw new InvalidProviderConfigError(`base_url must be https (got ${parsed.protocol})`);
      }
      if (baseUrl.endsWith("/")) {
        throw new InvalidProviderConfigError("base_url must not end with a trailing slash");
      }
      return;
    }
  }
}

export interface AgentStore {
  /** Create a new user. */
  createUser(tx: Transaction): Promise<{ id: string }>;

  /** Create a new conversation. */
  createConversation(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      isPrivate: boolean;
    },
  ): Promise<{ id: string }>;

  /** Load a conversation by ID. */
  getConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        id: string;
        userId: string;
        profileId: string;
        isPrivate: boolean;
        /** Auto-repair cooldown blob; null = CLOSED (normal operation). */
        cooldownState: CooldownState | null;
        /** Per-conversation voice mode override; null = follow profile default. */
        voiceMode: VoiceMode | null;
      }
    | undefined
  >;

  /**
   * Write the auto-repair cooldown blob. Called by `recover-conversation`
   * after `handle-message` exhausts retries — the caller computes the
   * next blob from the prior one via `nextCooldownState` and passes it
   * here. The store is unaware of the curve; it just persists the row.
   */
  writeCooldownState(tx: Transaction, conversationId: string, state: CooldownState): Promise<void>;

  /**
   * Clear the auto-repair cooldown blob to `NULL`. Called on the first
   * successful turn past the cooldown threshold (half-open success), by
   * `/repair`, and by `/model` / `/profile` switches. Idempotent — clearing
   * an already-clear row is a no-op write.
   */
  clearCooldown(tx: Transaction, conversationId: string): Promise<void>;

  /**
   * Set or clear the per-conversation voice mode override. `null` clears
   * the override (the conversation falls back to the profile default).
   * Used by `Transport.conversations.setVoiceMode` (`/voice` command).
   */
  setConversationVoiceMode(
    tx: Transaction,
    conversationId: string,
    mode: VoiceMode | null,
  ): Promise<void>;

  /**
   * Load the singleton voice configuration row, if present. Returns
   * `undefined` when voice is unconfigured (no wizard step run, no
   * environment fallback). Bootstrap consumers handle this gracefully by
   * leaving `ttsProvider` / `sttProvider` undefined on `HandleMessageDeps`,
   * which means voice-mode resolution always returns false.
   */
  getVoiceConfig(tx: Transaction): Promise<
    | {
        id: string;
        ttsSecretId: string;
        sttSecretId: string;
        ttsProvider: TtsProviderTypeValue;
        ttsModel: string;
        ttsVoice: string;
        ttsBaseUrl: string | null;
        sttProvider: SttProviderTypeValue;
        sttModel: string;
        sttBaseUrl: string | null;
        createdAt: Date;
      }
    | undefined
  >;

  /**
   * Insert or overwrite the singleton voice configuration row. The
   * `singleton` column carries a UNIQUE constraint, so `ON CONFLICT
   * (singleton) DO UPDATE` rotates the existing row in place — the row id
   * and `created_at` are preserved across config updates so they reflect
   * when voice was first configured, not last touched.
   */
  upsertVoiceConfig(
    tx: Transaction,
    params: {
      ttsSecretId: string;
      sttSecretId: string;
      ttsProvider: TtsProviderTypeValue;
      ttsModel: string;
      ttsVoice: string;
      ttsBaseUrl?: string | null;
      sttProvider: SttProviderTypeValue;
      sttModel: string;
      sttBaseUrl?: string | null;
    },
  ): Promise<{ id: string }>;

  /** Delete the singleton voice configuration row. No-op when none exists. */
  deleteVoiceConfig(tx: Transaction): Promise<void>;

  /** Insert a message (user or assistant). Returns the new message ID. `profileId` + `model` stamp the turn snapshot (see design/transport/overview.md → Profile and Model Stamping). */
  insertMessage(
    tx: Transaction,
    params: {
      conversationId: string;
      role: "user" | "assistant";
      content: string | ContentBlock[];
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      inputTokens?: number;
    },
  ): Promise<{ id: string }>;

  /**
   * The turn-starting user row whose cursor is `inboundId`: the newest user
   * row holding no `tool_result` block and no harness-tagged block. A turn's
   * tool results and its continuation prompt are later user rows on the same
   * cursor. Newest, because an insert re-run after its commit leaves two turn
   * rows on one cursor, and the turn that looks is the one that wrote the
   * last.
   */
  findUserMessageByInbound(
    tx: Transaction,
    conversationId: string,
    inboundId: string,
  ): Promise<{ id: string; createdAt: Date } | undefined>;

  /**
   * Insert multiple messages atomically in a single transaction. Returns the
   * last inserted ID. All rows share the same `profileId` + `model` snapshot.
   *
   * `lastMessageInputTokens` / `lastMessageOutputTokens` land on the **final**
   * row (the assistant's visible reply). Output is required — the fast-path
   * budget estimator (`shouldSkipCounting`) needs both, because the
   * assistant's reply is part of next turn's input. Non-final rows (tool
   * turns) get `output_tokens = -1` (sentinel: "unknown, force count").
   */
  insertMessages(
    tx: Transaction,
    params: {
      conversationId: string;
      messages: ReadonlyArray<Message>;
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      lastMessageInputTokens?: number;
      lastMessageOutputTokens: number;
    },
  ): Promise<{ id: string }>;

  /**
   * The newest assistant message answering chat input — its cursor is the
   * inbound batch the chat pipeline has consumed. Assistant messages a
   * pipeline stage wrote cursor on a `source='pipeline'` inbound and are
   * skipped: counting them would mark chat messages sent before the stage's
   * prompt as already answered.
   */
  getLastAssistantMessage(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | undefined>;

  /**
   * A conversation's complete message history with row ids, ordered by id.
   *
   * The raw transcript, not the compacted turn view — `loadTurnHistory` layers
   * durable summaries on top of this for the LLM-facing path, while the web
   * history read takes it as-is.
   */
  listMessages(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>>;

  /**
   * Widest durable summary for a conversation, or undefined when it has never
   * been compacted. The turn loader replaces every message up to and including
   * `throughMessageId` with this text.
   */
  getLatestSummary(tx: Transaction, conversationId: string): Promise<CompactionSummary | undefined>;

  /**
   * Store a turn's context, or return the one already stored for this message.
   * The message id is the idempotency key of the render step: a retry that
   * re-runs a committed insert gets the first attempt's text back, so the turn
   * sends the bytes later turns will load.
   */
  insertOrRecoverTurnContext(
    tx: Transaction,
    params: StoredTurnContext,
  ): Promise<StoredTurnContext>;

  /**
   * The stored turn contexts of a conversation's messages newer than
   * `afterMessageId` (every message when `null`), in no particular order: the
   * contexts of the rows `getHistoryAfter` / `listMessages` return.
   */
  listTurnContexts(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string | null,
  ): Promise<ReadonlyArray<StoredTurnContext>>;

  /** The conversation's current epoch: the snapshot opened latest in the transcript. */
  getLatestSystemPromptSnapshot(
    tx: Transaction,
    conversationId: string,
  ): Promise<SystemPromptSnapshot | undefined>;

  /**
   * Store the snapshot a turn opens, or return the one already stored for that
   * turn. `(conversationId, openedBy)` is the opening step's idempotency key: a
   * retry that re-runs a committed insert gets the first attempt's row back.
   */
  insertOrRecoverSystemPromptSnapshot(
    tx: Transaction,
    params: Omit<SystemPromptSnapshot, "id" | "createdAt">,
  ): Promise<SystemPromptSnapshot>;

  /**
   * Append a summary, or recover the existing row when this
   * (conversationId, throughMessageId) pair was already written.
   *
   * The pair is the idempotency key for the Inngest step that writes it: a
   * retry that re-runs a committed insert lands on the conflict arm rather
   * than appending a second row for the same span. `kind` reports which arm
   * ran, so a caller can tell a fresh compaction from a replayed one.
   */
  insertOrRecoverSummary(
    tx: Transaction,
    params: {
      conversationId: string;
      summary: string;
      throughMessageId: string;
      messagesSummarized: number;
      model: string;
      source: SummarySourceValue;
    },
  ): Promise<{ kind: "new" | "recovered"; row: CompactionSummary }>;

  /**
   * Messages of a conversation newer than `afterMessageId`, ordered by id.
   * Backs the compacted turn view — the summary stands in for everything at or
   * before the cutoff. UUIDv7 ids are time-ordered, so the `>` comparison is
   * an ordering predicate, not just an identity one.
   */
  getHistoryAfter(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>>;

  /**
   * What an Observer fire's window is cut from, read in one snapshot: the
   * conversation's message count, its last message (null when it has none)
   * and each extraction phase's cursor.
   */
  getObserverBounds(tx: Transaction, conversationId: string): Promise<ObserverBounds>;

  /**
   * A conversation's messages after `after` (from its start when null) through
   * `through`, ordered by id: the first `limit` of them, or all when null.
   */
  listMessagesInRange(
    tx: Transaction,
    conversationId: string,
    range: { after: string | null; through: string; limit: number | null },
  ): Promise<ReadonlyArray<Message & { id: string }>>;

  /** The last `limit` messages of a conversation at or before `through`, ordered by id. */
  listMessagesThrough(
    tx: Transaction,
    conversationId: string,
    through: string,
    limit: number,
  ): Promise<ReadonlyArray<Message & { id: string }>>;

  /**
   * The widest durable summary that ends at or before `through`, or undefined
   * when none does: the Observer's context for messages it already processed.
   */
  getLatestSummaryThrough(
    tx: Transaction,
    conversationId: string,
    through: string,
  ): Promise<CompactionSummary | undefined>;

  /**
   * Move an extraction phase's cursor to `through`, forward only: a cursor
   * already at or past it stays. True when the cursor moved.
   */
  advanceObserverCursor(
    tx: Transaction,
    params: { conversationId: string; phase: ObservedPhase; through: string },
  ): Promise<boolean>;

  /** Load a profile by ID. */
  getProfile(tx: Transaction, profileId: string): Promise<Profile | undefined>;

  /** The oldest user by `id` (UUIDv7): the one setup creates, which bootstrap and the CLI act as. */
  getFirstUser(tx: Transaction): Promise<{ id: string } | undefined>;

  /** The oldest profile by `id`: the org profile setup seeds. */
  getDefaultProfile(tx: Transaction): Promise<{ id: string } | undefined>;

  /** Create a profile and return the full row. `userId: null` = org profile (read-only via Transport); `userId: <id>` = user profile (owned by that user). Throws `UniqueViolationError` on (user_id, name) collision. */
  createProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
      memoryScope?: ProfileMemoryScope | null;
    },
  ): Promise<Profile>;

  /**
   * Keyed insert on `uq_profiles_user_name` (`.claude/rules/inngest.md`): a
   * repeated `(userId, name)`, including `userId: null`, returns the stored
   * profile's id as `recovered`, leaving the row as it was.
   */
  insertOrRecoverProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
    },
  ): Promise<{ kind: "new" | "recovered"; id: string }>;

  /** List profiles visible to `userId`: org profiles (user_id IS NULL) + the user's own profiles. */
  listProfiles(tx: Transaction, userId: string): Promise<ReadonlyArray<Profile>>;

  /** Return ownership info for a profile, or `undefined` if the profile doesn't exist. The inner `userId: null` means "org profile" — that's a real value stored in the row, distinct from "row not found". */
  getProfileOwner(
    tx: Transaction,
    profileId: string,
  ): Promise<{ userId: string | null } | undefined>;

  /** Update a profile in place. Caller must verify ownership. Throws `UniqueViolationError` on name collision. */
  updateProfile(tx: Transaction, profileId: string, changes: ProfileUpdates): Promise<Profile>;

  /**
   * Count live references to a profile — active conversations + stamped message history.
   * Useful for UX (warn before delete). `deleteProfile` performs the authoritative check-in-tx.
   */
  countProfileReferences(
    tx: Transaction,
    profileId: string,
  ): Promise<{ conversations: number; messages: number }>;

  /**
   * Delete a profile atomically: checks `conversations`, `messages`, the schedules that run as
   * it (`scheduled_tasks`, `skills.run_as_profile_id`) and the steering rules scoped to it inside
   * the same transaction and throws `ProfileInUseError` if any exist. Historical messages pin the profile as audit data — a
   * profile that has ever been used in a turn stays undeletable.
   */
  deleteProfile(tx: Transaction, profileId: string): Promise<void>;

  // --- Profile classes (speaker-isolation registry) ---

  /** List the user's registered profile classes, ordered by name. */
  listProfileClasses(tx: Transaction, userId: string): Promise<ReadonlyArray<ProfileClass>>;

  /** Create a new profile class. Throws `UniqueViolationError` on (user_id, name) collision. */
  createProfileClass(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<ProfileClass>;

  /**
   * Delete a profile class by name. Throws `ProfileClassInUseError` if any
   * of the user's profiles still reference it via `profile_class`. Returns
   * `{ deleted: false }` if no row matches; `{ deleted: true }` on success.
   */
  deleteProfileClass(tx: Transaction, userId: string, name: string): Promise<{ deleted: boolean }>;

  /**
   * Flip the `restricted` flag on a profile class. Returns
   * `{ updated: false }` when no row matches the name (idempotent absence).
   * Independent of whether any profile currently references the class:
   * marking restricted while in use is the common case (an existing
   * `intimate` class becoming sensitive after the fact).
   */
  setProfileClassRestricted(
    tx: Transaction,
    userId: string,
    name: string,
    restricted: boolean,
  ): Promise<{ updated: boolean }>;

  /**
   * Set or clear a profile's `profile_class`. `className: null` clears it.
   * When `className` is non-null, validates the class exists in the
   * profile's user's registry and throws `UnknownProfileClassError`
   * otherwise. Org profiles (`user_id IS NULL`) cannot be classed —
   * passing `className !== null` for one throws `UnknownProfileClassError`.
   */
  setProfileClass(tx: Transaction, profileId: string, className: string | null): Promise<void>;

  // --- Custom compartments (memory-domain extension registry) ---

  /** List the user's registered custom compartments, ordered by name. */
  listCustomCompartments(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<CustomCompartment>>;

  /**
   * Create a new custom compartment for the user. Enforces:
   *   - reserved-name check against `CORE_COMPARTMENTS` →
   *     `ReservedCompartmentNameError`
   *   - per-user cap of `CUSTOM_COMPARTMENT_LIMIT` →
   *     `CustomCompartmentCapExceededError`
   *   - unique `(user_id, name)` → `UniqueViolationError`
   *
   * Cap is enforced via a count-then-insert in the same transaction.
   * REPEATABLE READ (the project default) doesn't catch this predicate
   * race — snapshot isolation doesn't predicate-lock. At single-user
   * scale + UI-only writes the residual race (concurrent inserts both
   * seeing count=N-1) is acceptable; when multi-tenant lands, prevent it
   * with an advisory lock taken before the snapshot, not SERIALIZABLE —
   * see `.claude/rules/store-pattern.md`.
   */
  createCustomCompartment(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<CustomCompartment>;

  /**
   * Delete a custom compartment by name. Returns `{ deleted: false }` if no
   * row matches; `{ deleted: true }` on success. Forward-only: existing
   * `compartment:<name>` Hindsight tags survive (Cogmo doesn't store the
   * memory rows itself, so an FK-style RESTRICT isn't possible). Profiles
   * whose `memory_scope.compartments` array references the deleted name
   * remain valid — recall-time predicate just stops matching new memories.
   */
  deleteCustomCompartment(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<{ deleted: boolean }>;

  /** Load a single message by ID. */
  getMessage(
    tx: Transaction,
    messageId: string,
  ): Promise<{ id: string; role: string; content: string | ContentBlock[] } | undefined>;

  /**
   * The live steering rules `scope` sees, every channel's included, each with
   * its `# Rules` section and channel, in the order `# Rules` lists them
   * within a section.
   */
  getActiveRules(tx: Transaction, scope: RuleScope): Promise<ReadonlyArray<SectionedRule>>;

  /**
   * The user's core memory blocks visible to one scope. `profileClass: null`
   * reads every NULL-class block in key order. A class reads the shared
   * `identity`, then the class's blocks: its `identity` override first, the
   * rest in key order.
   */
  getCoreMemoryBlocks(
    tx: Transaction,
    userId: string,
    profileClass: string | null,
  ): Promise<ReadonlyArray<ScopedCoreMemoryBlock>>;

  /**
   * Create or replace the block at `(userId, profileClass, key)`. Writing the
   * content it already holds leaves the row, `updated_at` included, as it was.
   */
  upsertCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string | null; key: string; content: string },
  ): Promise<CoreMemoryUpsertOutcome>;

  /** Delete the block at `(userId, profileClass, key)`, if any; true when one was deleted. */
  deleteCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string; key: string },
  ): Promise<boolean>;

  /** When each of the user's core memory blocks last changed, in every scope. */
  getCoreMemoryUpdateTimes(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<{ profileClass: string | null; key: string; updatedAt: Date }>>;

  /** The keys of one class's own blocks, in key order. */
  listCoreMemoryKeys(
    tx: Transaction,
    userId: string,
    profileClass: string,
  ): Promise<ReadonlyArray<string>>;

  /** Get the timestamp of the most recent message in a conversation (any role). `undefined` when no messages. */
  getLastMessageTime(tx: Transaction, conversationId: string): Promise<Date | undefined>;

  /**
   * Most recent private conversation for `(userId, profileId)` and the
   * timestamp of its last message (`null` when the conversation has no
   * messages yet, `undefined` when no such conversation exists).
   */
  findMostRecentConversationForUserProfile(
    tx: Transaction,
    userId: string,
    profileId: string,
  ): Promise<{ id: string; lastMessageAt: Date | null } | undefined>;

  /**
   * Get `{ inputTokens, outputTokens }` from the most recent assistant
   * message, for the fast-path budget estimator. Returns `undefined` if no
   * assistant row exists. The inner `inputTokens` may be `null` (column was
   * never written for legacy rows) or the actual integer; `-1` is the
   * pre-migration sentinel for `outputTokens`. The fast path treats both
   * as "unknown → force count".
   */
  getLastTokens(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        inputTokens: number | null;
        outputTokens: number;
      }
    | undefined
  >;

  // --- Conversation admin (Transport-facing) ---

  /** List private conversations owned by a user with last-message preview + alias + profile name. */
  listConversationsForUser(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<ConversationSummary>>;

  /** Update a conversation's active profile. Takes effect on the next turn (current in-flight turn keeps its snapshot). */
  setConversationProfile(tx: Transaction, conversationId: string, profileId: string): Promise<void>;

  /** Upsert or clear a conversation's alias. `alias: null` removes the alias row. Throws `UniqueViolationError` if the alias is taken. */
  setAlias(
    tx: Transaction,
    userId: string,
    conversationId: string,
    alias: string | null,
  ): Promise<void>;

  /** Resolve an alias to a conversation ID for a user. Returns `undefined` if no match. */
  findConversationByAlias(
    tx: Transaction,
    userId: string,
    alias: string,
  ): Promise<{ conversationId: string } | undefined>;

  /**
   * Resolve a conversation's alias scoped to `userId` — the SQL filter
   * matches on `(userId, conversationId)`, so a conversation owned by a
   * different user returns `null` (no separate ownership check at the
   * call site needed). Also returns `null` when the conversation has no
   * alias set.
   */
  getAliasForConversation(
    tx: Transaction,
    userId: string,
    conversationId: string,
  ): Promise<string | undefined>;

  /**
   * Conversation lifecycle stats — `createdAt`, total `messageCount`, and the
   * timestamp of the most recent message (`lastMessageAt`, `null` when no
   * messages yet). Returned in one transaction. Used by `/status` to surface
   * conversation age and activity without forcing the caller to make three
   * separate round-trips.
   */
  getConversationStats(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ createdAt: Date; messageCount: number; lastMessageAt: Date | null } | undefined>;

  // --- Model discovery (Transport-facing) ---

  /** Distinct models that are user-selectable (user_selectable = true). Used by the `/model` picker. */
  listDistinctUserSelectableModels(tx: Transaction): Promise<ReadonlyArray<string>>;

  /** True if at least one `model_providers` row has `user_selectable = true` for this model. Used to validate `profiles.update({ model })`. */
  isModelUserSelectable(tx: Transaction, model: string): Promise<boolean>;

  // --- LLM Providers ---

  /** Create an LLM provider configuration. */
  createProvider(
    tx: Transaction,
    params: {
      name: string;
      type: LlmProviderTypeValue;
      baseUrl?: string;
      secretId: string;
      attrs: ProviderAttrs;
    },
  ): Promise<{ id: string }>;

  /** Get a provider by ID. */
  getProvider(
    tx: Transaction,
    providerId: string,
  ): Promise<
    | {
        id: string;
        name: string;
        type: LlmProviderTypeValue;
        baseUrl: string | null;
        secretId: string;
        attrs: ProviderAttrs;
      }
    | undefined
  >;

  /** List all providers. */
  listProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      attrs: ProviderAttrs;
    }>
  >;

  /**
   * Set a provider's `attrs.cacheDialect`, keeping its other attrs. False when
   * no provider has this id.
   */
  setProviderCacheDialect(
    tx: Transaction,
    providerId: string,
    cacheDialect: CacheDialect,
  ): Promise<boolean>;

  /** Delete a provider by ID (cascades to model_providers). */
  deleteProvider(tx: Transaction, providerId: string): Promise<void>;

  // --- Model → Provider routing ---

  /**
   * Register a provider for a model at a given position (lower = preferred).
   *
   * `userSelectable: false` hides the model from the user-facing `/model` picker
   * — use for internal-only models (summarization, experimental).
   *
   * `contextWindow` / `maxOutputTokens` are optional explicit overrides. Leave
   * undefined to let the resolver fall back through LiteLLM JSON → conservative
   * default. Set them only when the model is unknown to LiteLLM and the
   * default doesn't fit (e.g., a niche local model with a 1M context window).
   */
  addModelProvider(
    tx: Transaction,
    params: {
      model: string;
      providerId: string;
      position: number;
      userSelectable: boolean;
      contextWindow?: number | null;
      maxOutputTokens?: number | null;
    },
  ): Promise<{ id: string }>;

  /**
   * List every provider registered for a model, ordered by position ASC
   * (primary first, then fallbacks). Empty array when no provider is
   * registered for the model. `position` reflects the actual stored
   * value — non-sequential after intermediate rows are deleted, so
   * callers should never use an array index as a substitute.
   */
  listProvidersForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
    }>
  >;

  /**
   * Every `model_providers` row joined with its owning `llm_providers`,
   * ordered by `(model, position)`. Single round trip for the whole
   * routing table — used by `cogmo model list` so the command doesn't
   * fan out one query per model.
   */
  listAllModelProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      model: string;
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
    }>
  >;

  /** Get the next available position for a model (MAX(position) + 1, or 0 if none). */
  getNextModelProviderPosition(tx: Transaction, model: string): Promise<number>;

  /** Remove all model_providers entries for a given provider. */
  removeModelProvidersByProvider(tx: Transaction, providerId: string): Promise<void>;

  /** Remove a single model_providers row by `(model, providerId)`. */
  removeModelProvider(tx: Transaction, model: string, providerId: string): Promise<void>;

  /** Distinct list of every model id with at least one routing row. */
  listAllModels(tx: Transaction): Promise<ReadonlyArray<string>>;

  // --- Image Providers ---

  /**
   * Create an image-gen provider row. Validates the base_url shape at the
   * store boundary (https, no trailing slash, parseable) — the DB CHECK
   * pins the coarser `openai_compatible ↔ NOT NULL`, `fal ↔ NULL`
   * invariant. Unique-name collisions surface as `UniqueViolationError`.
   *
   * `baseUrl` is REQUIRED for `openai_compatible` and FORBIDDEN for `fal`
   * — the guard raises `InvalidProviderConfigError` with a wizard-friendly
   * reason before the row reaches the DB.
   */
  createImageProvider(
    tx: Transaction,
    params: {
      name: string;
      type: ImageProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ImageProviderAttrs;
    },
  ): Promise<{ id: string }>;

  /** Get an image provider by ID. */
  getImageProvider(tx: Transaction, providerId: string): Promise<ImageProviderRow | undefined>;

  /** Look up an image provider by its unique name. */
  findImageProviderByName(tx: Transaction, name: string): Promise<ImageProviderRow | undefined>;

  /** List every image provider. */
  listImageProviders(tx: Transaction): Promise<ReadonlyArray<ImageProviderRow>>;

  /** Delete an image provider; cascades to its `image_models` rows. */
  deleteImageProvider(tx: Transaction, providerId: string): Promise<void>;

  // --- Image Models ---

  /**
   * Create an image-model catalog row. Exact-name collisions surface as
   * `UniqueViolationError`; slug collisions (e.g. `replicate/flux-pro`
   * when `fal-ai/flux-pro` already exists) surface as
   * `ImageModelSlugCollisionError`. The Zod schema on `capabilities` (run
   * inside `jsonbZod`) validates the bag at write time — invalid aspect
   * ratios or unexpected fields throw before reaching the DB.
   */
  createImageModel(
    tx: Transaction,
    params: {
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    },
  ): Promise<{ id: string }>;

  /**
   * Bulk-insert image models keyed on `(providerId, name)`. Rows whose
   * `name` already exists are skipped (idempotent re-run). Returns the
   * count of rows actually inserted — operator edits to existing rows
   * are preserved. Used by `ensureFalImageDefaults`. A new row whose
   * `name` slug-collides with an existing or sibling row throws
   * `ImageModelSlugCollisionError`.
   */
  upsertImageModelsByName(
    tx: Transaction,
    rows: ReadonlyArray<{
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    }>,
  ): Promise<number>;

  /**
   * List every image model. When `userSelectableOnly: true`, filters to
   * rows the LLM is allowed to pick — bootstrap uses that filter to build
   * the `generate_image` tool's `model` enum.
   */
  listImageModels(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelRow>>;

  /**
   * Like `listImageModels`, but joins in the owning `image_providers` row
   * so the caller can build a single tool catalog without per-row
   * follow-up queries. Sorted by model `name` for stable tool-description
   * output across boots.
   */
  listImageModelsWithProvider(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelWithProvider>>;

  /** Delete a single image model. */
  deleteImageModel(tx: Transaction, modelId: string): Promise<void>;

  // --- Sub-agents ---

  /**
   * List a user's sub-agents, ordered by name for stable tool-catalog output
   * across turns. The per-turn tool builder turns each into a
   * `subagent__<name>` tool; `profiles.tool_set` then gates which surface for
   * a given profile.
   */
  listSubAgents(tx: Transaction, userId: string): Promise<ReadonlyArray<SubAgent>>;

  /**
   * Insert a sub-agent. A `(user_id, name)` collision surfaces as
   * `UniqueViolationError`. The caller (the create-sub-agent use case)
   * validates the name shape and that `model` exists in `model_providers`
   * first.
   */
  createSubAgent(
    tx: Transaction,
    params: {
      userId: string;
      name: string;
      description: string;
      systemPrompt: string | null;
      model: string;
    },
  ): Promise<{ id: string }>;

  /** Delete a sub-agent by name. `deleted: false` when no row matched. */
  deleteSubAgent(tx: Transaction, userId: string, name: string): Promise<{ deleted: boolean }>;

  // --- Evolution: correction extraction ---

  /** Whether a channel's defaults have been seeded. */
  hasChannelDefaults(tx: Transaction, channelType: string): Promise<boolean>;

  /** Insert an active channel default (`source = 'seed'`) for every profile. */
  insertSeedRule(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      channelType: string;
      priority: number;
    },
  ): Promise<{ id: string }>;

  /** The unretired learned rules, active and learning, for extraction and consolidation. */
  getCorrections(tx: Transaction, profileId: string): Promise<ReadonlyArray<ExtractionRule>>;

  /**
   * The user's live instruction rules the profile sees, for extraction:
   * listed apart from `getCorrections` so consolidation never loads them.
   */
  getInstructionRules(
    tx: Transaction,
    scope: { profileId: string; userId: string },
  ): Promise<ReadonlyArray<ExtractionRule>>;

  /**
   * Whether a live instruction rule of the user's with this text (normalized)
   * covers a rule in `channelType` (null for every channel), seen from
   * `profileId`'s conversation: the instruction is global or that profile's,
   * and on every channel or that one. A channel rule doesn't cover another
   * channel or every channel.
   */
  hasInstructionRule(
    tx: Transaction,
    params: { userId: string; text: string; profileId: string; channelType: string | null },
  ): Promise<boolean>;

  /**
   * Insert a new correction or reinforce an existing one, which promotes a
   * learned rule to active when observationCount reaches 2; reinforcing an
   * instruction rule only counts. Null when `existingRuleId` names no
   * unretired rule: it was retired or merged since the caller read it, and
   * nothing is written.
   */
  upsertCorrection(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      profileId: string | null;
      channelType?: string | null;
      existingRuleId?: string;
    },
  ): Promise<{ id: string; promoted: boolean } | null>;

  /**
   * Apply a contradiction citing the message `messageId` to a learned rule
   * still learning. The first resets its observation count to 0 and records
   * the message (`reset`); one citing any other message, of the same
   * conversation or another, retires it and records that message instead
   * (`retired`). One citing the recorded message writes nothing and reports
   * what it did, so re-extracting a message (a retried step, a re-planned
   * chunk) applies it once and counts the same. Every other retirement clears
   * the record, so one against a rule that is active, retired otherwise or not
   * learned writes nothing (`unchanged`).
   */
  contradictLearningRule(
    tx: Transaction,
    params: { id: string; messageId: string },
  ): Promise<"reset" | "retired" | "unchanged">;

  /**
   * The live `memory`-category rules, of every source, that any of
   * `profileIds` sees: global ones and each profile's own, among instruction
   * rules only `userId`'s. `memoryRulesFor` picks one profile's out of them.
   */
  getMemoryRules(
    tx: Transaction,
    scope: { profileIds: ReadonlyArray<string>; userId: string },
  ): Promise<ReadonlyArray<MemoryRule>>;

  /** Count the active learned rules (`correction`, `evolution`) a profile sees: what consolidation merges. */
  countActiveLearnedRules(tx: Transaction, profileId: string): Promise<number>;

  /**
   * Replace a group of learned rules with one consolidated rule. Throws
   * `RuleGroupChangedError` when a rule in the group is retired, gone, or not
   * a learned rule. The DELETE has run by then, so the caller must let the
   * error propagate out of the transaction, which rolls it back, and catch it
   * outside.
   */
  replaceRules(
    tx: Transaction,
    params: {
      oldIds: string[];
      newRule: {
        rule: string;
        category: string;
        profileId: string | null;
        channelType: string | null;
        priority: number;
        observationCount: number;
      };
    },
  ): Promise<{ id: string }>;

  // --- Explicit instructions ---

  /**
   * Set a standing instruction as a live rule, unless a live instruction rule
   * with the same text (normalized) and scope is already there, or the user
   * holds `INSTRUCTION_RULE_LIMIT`. Throws on an empty `channelType`. A set or an existing rule retires the
   * unretired learned rules with the same text and scope: the instruction
   * supersedes them. Keyed on `uq_steering_rules_instruction`: a concurrent
   * identical set fails with 40001, and the transactor's retry returns the
   * winner's row as `existing`.
   */
  setInstructionRule(
    tx: Transaction,
    params: InstructionRuleParams,
  ): Promise<SetInstructionRuleResult>;

  /**
   * Retire the live `instruction`, `correction` and `evolution` rules visible
   * to the scope whose text matches `text` (normalized); `restricted` limits
   * that to the rules scoped to `profileId`. Returns every live or retired
   * visible match. Fits `rule_remove`; `replaces` needs its own shape
   * (design/evolution.md → Implementation Outline, step 3).
   */
  retireRulesByText(
    tx: Transaction,
    params: { text: string; userId: string; profileId: string; restricted: boolean },
  ): Promise<RetireRulesResult>;

  /**
   * The rules a profile shows its user, for review: every live rule it sees,
   * the user's instruction rules included, the learning ones and the most
   * recently retired.
   */
  listRules(tx: Transaction, scope: { profileId: string; userId: string }): Promise<RuleReview>;

  // --- Pending memories (staging for Observer classification) ---

  /**
   * Insert a single row into the staging table. Returns the new row id.
   *
   * `profileId` snapshots which profile staged the row so the Observer
   * drain stamps the correct `profile_class:<class>` tag at retain
   * time. Pass `null` for non-conversational stages (the migration
   * backfill loop) where there's no staging profile. A `skill` row names
   * its skill in `skillName`, and no other source carries one
   * (`chk_pending_memories_skill_name`).
   */
  stagePendingMemory(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string | null;
      content: string;
      context?: string;
    } & PendingMemoryOrigin,
  ): Promise<{ id: string }>;

  /**
   * Bulk insert via a single statement. Used by the migration script to
   * stage thousands of rows in one round-trip. `profileId` is null on
   * every row — the migration script has no per-row profile lineage.
   */
  bulkStagePendingMemories(
    tx: Transaction,
    rows: ReadonlyArray<{
      userId: string;
      content: string;
      context?: string;
      source: UnnamedMemorySource;
    }>,
  ): Promise<void>;

  /**
   * Read pending rows for a user, oldest first (FIFO drain order).
   *
   * `limit` caps the result size — callers running inside an Inngest step
   * pass a bounded value so the row payload never exceeds the run-state
   * size limit. Omit to read every pending row (tests, ad-hoc tooling).
   * `filter` narrows the rows before the limit applies.
   */
  getPendingMemories(
    tx: Transaction,
    userId: string,
    limit?: number,
    filter?: PendingMemoryFilter,
  ): Promise<ReadonlyArray<PendingMemory>>;

  /** Count a user's pending rows, `filter` narrowing them as `getPendingMemories` does. */
  countPendingMemories(
    tx: Transaction,
    userId: string,
    filter?: PendingMemoryFilter,
  ): Promise<number>;

  /** Delete pending rows by id. Used by the Observer drain step after successful retain. */
  deletePendingMemories(tx: Transaction, ids: ReadonlyArray<string>): Promise<void>;

  /**
   * Insert a scheduled task. Caller is responsible for cron / timezone
   * validation (done at the tool layer via `croner` + `Intl.DateTimeFormat`)
   * and for computing `nextRunAt` from the cron expression in the user's tz. The
   * DB CHECK pins the `kind ↔ cron` invariant: passing `cron: null` for a
   * `recurring` row (or non-null for `one_off`) raises a 23514 the caller
   * must translate. See design/scheduling.md.
   */
  createScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
    },
  ): Promise<ScheduledTask>;

  /**
   * Idempotent schedule creation. A second call carrying the same key returns
   * `kind: "recovered"` and the original row rather than scheduling a second
   * fire — the one duplicate on the durable-tool list that repeats forever.
   * Separate from {@link AgentStore.createScheduledTask} because this one can
   * decline to insert. Mirrors `CodingStore.insertOrRecoverTask`.
   */
  createOrRecoverScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
      idempotencyKey: string;
    },
  ): Promise<{ kind: "new" | "recovered"; row: ScheduledTask }>;

  /** Load a single scheduled task by id. Returns undefined when not found. */
  getScheduledTask(tx: Transaction, id: string): Promise<ScheduledTask | undefined>;

  /**
   * Load a scheduled task by its idempotency key. Lets a caller recognise a
   * retry before spending a cap check on it — the row a retry is recovering
   * counts toward that cap.
   */
  getScheduledTaskByIdempotencyKey(
    tx: Transaction,
    key: string,
  ): Promise<ScheduledTask | undefined>;

  /**
   * List scheduled tasks for a user, newest-first. Used by `/schedules`
   * and `list_tasks`. `includeDisabled` defaults to `true` — `/schedules`
   * wants to show disabled rows; `list_tasks` callers that only want
   * "what's currently going to fire" pass `false`.
   */
  listScheduledTasks(
    tx: Transaction,
    userId: string,
    opts?: { includeDisabled?: boolean },
  ): Promise<ReadonlyArray<ScheduledTask>>;

  /**
   * Count scheduled tasks for a user. Faster than `listScheduledTasks`
   * when the caller only needs the total (e.g. the per-user cap check
   * in `SchedulingService.create`). Counts BOTH enabled and disabled
   * rows so a graveyard of disabled tasks can't bypass the cap by
   * toggling — same scope as `listScheduledTasks` default.
   */
  countScheduledTasks(tx: Transaction, userId: string): Promise<number>;

  /**
   * Lock and return up to `limit` rows whose `next_run_at <= now` and that
   * are enabled, in `next_run_at` order. Uses `FOR UPDATE SKIP LOCKED` so
   * concurrent ticker runs (e.g. a retried Inngest step) don't double-pick
   * the same row. Caller MUST advance every returned row in the same
   * transaction via `advanceScheduledTask` before commit, otherwise the
   * row will re-fire on the next tick.
   *
   * Replay-safety note: this method does NOT need to be deterministic
   * across invocations — its return value is captured inside the
   * ticker's `step.run("lock-and-advance", ...)`, and Inngest replays
   * the cached step result on retry rather than re-invoking the body.
   * `now` is just the timestamp the caller snapshots once (outside
   * `step.run`) and passes in so the SQL predicate is explicit, not a
   * determinism mechanism.
   */
  lockDueScheduledTasks(
    tx: Transaction,
    params: { now: Date; limit: number },
  ): Promise<ReadonlyArray<ScheduledTask>>;

  /**
   * Advance a row after the ticker has picked it: stamp `last_run_at` to
   * the timestamp that was just fired, set `next_run_at` to the next
   * occurrence (or leave unchanged for one-offs — the row's `enabled` flips
   * to false instead). Caller computes `nextRunAt` from `croner` for
   * recurring rows and passes `disable: true` for one-offs so the same
   * row isn't picked again on the next tick.
   */
  advanceScheduledTask(
    tx: Transaction,
    id: string,
    params: { lastRunAt: Date; nextRunAt: Date; disable?: boolean },
  ): Promise<void>;

  /**
   * Flip `enabled` for a scheduled task. Used by `/disable` /` /enable`
   * channel commands and by `remove_task` (which deletes outright instead).
   * No-ops if the row doesn't exist — caller checks existence via
   * `getScheduledTask` when it needs to distinguish "disabled" from
   * "didn't exist".
   */
  setScheduledTaskEnabled(tx: Transaction, id: string, enabled: boolean): Promise<void>;

  /** Delete a scheduled task by id. No-ops if the row doesn't exist. */
  deleteScheduledTask(tx: Transaction, id: string): Promise<void>;

  // --- Evolution: audit log ---

  /**
   * Append one `evolution_events` row capturing a processed Observer fire.
   * Called by the Observer (autonomous + manual). `userId` is resolved by
   * the caller from the conversation — the denormalised column lets the
   * `/learned` digest scan by user without joining `conversations`.
   */
  recordEvolutionEvent(
    tx: Transaction,
    params: {
      conversationId: string;
      userId: string;
      triggeredBy: EvolutionTriggerValue;
      payload: EvolutionEventPayload;
    },
  ): Promise<{ id: string }>;

  /**
   * List evolution events for a user, newest-first. Used by the `/learned`
   * digest. `limit` caps the result; default 10 — the Telegram digest
   * shows at most ten rows and any more would scroll off screen anyway.
   */
  listEvolutionEvents(
    tx: Transaction,
    userId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<EvolutionEventRow>>;

  /**
   * Load a single evolution event by id. Returns undefined when not found
   * OR when the row belongs to another user — same probing-protection
   * shape as `scheduling.*` and `/repair`. Caller passes their resolved
   * `userId` and surfaces undefined as "not found" without leaking the
   * existence of another user's rows.
   */
  getEvolutionEvent(
    tx: Transaction,
    userId: string,
    id: string,
  ): Promise<EvolutionEventRow | undefined>;
}

/**
 * One persisted row from `evolution_events`. `payload` carries the validated
 * `EvolutionEventPayloadSchema` shape (the `ObserverResult` projection).
 */
export interface EvolutionEventRow {
  id: string;
  conversationId: string;
  userId: string;
  triggeredBy: EvolutionTriggerValue;
  payload: EvolutionEventPayload;
  createdAt: Date;
}

/** Column values shared by both scheduled-task insert paths. */
function scheduleValues(params: {
  userId: string;
  profileId: string;
  kind: ScheduleKind;
  cron: string | null;
  timezone: string;
  prompt: string;
  nextRunAt: Date;
  enabled: boolean;
  catchupMissed: boolean;
  source: ScheduleSource;
}) {
  return {
    userId: params.userId,
    profileId: params.profileId,
    kind: params.kind,
    cron: params.cron,
    timezone: params.timezone,
    prompt: params.prompt,
    nextRunAt: params.nextRunAt,
    enabled: params.enabled,
    catchupMissed: params.catchupMissed,
    source: params.source,
  };
}

export class DrizzleAgentStore implements AgentStore {
  async createUser(tx: Transaction): Promise<{ id: string }> {
    return single(await tx.insert(users).values({}).returning({ id: users.id }));
  }

  async createConversation(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      isPrivate: boolean;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx.insert(conversations).values(params).returning({ id: conversations.id }),
    );
  }

  async getConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        id: string;
        userId: string;
        profileId: string;
        isPrivate: boolean;
        cooldownState: CooldownState | null;
        voiceMode: VoiceMode | null;
      }
    | undefined
  > {
    const rows = await tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        profileId: conversations.profileId,
        isPrivate: conversations.isPrivate,
        cooldownState: conversations.cooldownState,
        voiceMode: conversations.voiceMode,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return rows[0];
  }

  async writeCooldownState(
    tx: Transaction,
    conversationId: string,
    state: CooldownState,
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({ cooldownState: state })
      .where(eq(conversations.id, conversationId));
  }

  async clearCooldown(tx: Transaction, conversationId: string): Promise<void> {
    await tx
      .update(conversations)
      .set({ cooldownState: null })
      .where(eq(conversations.id, conversationId));
  }

  async setConversationVoiceMode(
    tx: Transaction,
    conversationId: string,
    mode: VoiceMode | null,
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({ voiceMode: mode })
      .where(eq(conversations.id, conversationId));
  }

  async getVoiceConfig(tx: Transaction) {
    // ORDER BY created_at DESC defends against the singleton constraint
    // somehow being bypassed (manual psql, broken migration) — return
    // the most recent config rather than picking arbitrarily.
    const rows = await tx.select().from(voiceConfig).orderBy(desc(voiceConfig.createdAt)).limit(1);
    return rows[0];
  }

  async upsertVoiceConfig(
    tx: Transaction,
    params: {
      ttsSecretId: string;
      sttSecretId: string;
      ttsProvider: TtsProviderTypeValue;
      ttsModel: string;
      ttsVoice: string;
      ttsBaseUrl?: string | null;
      sttProvider: SttProviderTypeValue;
      sttModel: string;
      sttBaseUrl?: string | null;
    },
  ): Promise<{ id: string }> {
    const values = {
      ttsSecretId: params.ttsSecretId,
      sttSecretId: params.sttSecretId,
      ttsProvider: params.ttsProvider,
      ttsModel: params.ttsModel,
      ttsVoice: params.ttsVoice,
      ttsBaseUrl: params.ttsBaseUrl ?? null,
      sttProvider: params.sttProvider,
      sttModel: params.sttModel,
      sttBaseUrl: params.sttBaseUrl ?? null,
    };
    return single(
      await tx
        .insert(voiceConfig)
        .values(values)
        .onConflictDoUpdate({
          target: voiceConfig.singleton,
          set: values,
        })
        .returning({ id: voiceConfig.id }),
    );
  }

  async deleteVoiceConfig(tx: Transaction): Promise<void> {
    await tx.delete(voiceConfig);
  }

  async insertMessage(
    tx: Transaction,
    params: {
      conversationId: string;
      role: "user" | "assistant";
      content: string | ContentBlock[];
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      inputTokens?: number;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(messages)
        .values({
          conversationId: params.conversationId,
          role: params.role,
          content: params.content,
          profileId: params.profileId,
          model: params.model,
          lastInboundMessageId: params.lastInboundMessageId,
          ...(params.inputTokens != null && { inputTokens: params.inputTokens }),
          // Singular insert is only used for user rows (and the orchestrator's
          // initial synthesized user message) — they never have an output
          // count. Sentinel -1 tells the fast path "unknown, force count" if
          // this row were ever the most-recent assistant (it isn't).
          outputTokens: UNKNOWN_OUTPUT_TOKENS,
        })
        .returning({ id: messages.id }),
    );
  }

  async findUserMessageByInbound(
    tx: Transaction,
    conversationId: string,
    inboundId: string,
  ): Promise<{ id: string; createdAt: Date } | undefined> {
    // Drizzle has no operator for a JSON path, so the predicate is raw; the
    // path is `isTurnRowContent`'s rule, bound as a parameter.
    const rows = await tx
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.lastInboundMessageId, inboundId),
          eq(messages.role, "user"),
          not(sql`jsonb_path_exists(${messages.content}, ${NOT_TURN_ROW_JSONPATH}::jsonpath)`),
        ),
      )
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0];
  }

  async insertMessages(
    tx: Transaction,
    params: {
      conversationId: string;
      messages: ReadonlyArray<Message>; // must be non-empty
      profileId: string;
      model: string;
      lastInboundMessageId: string;
      lastMessageInputTokens?: number;
      lastMessageOutputTokens: number;
    },
  ): Promise<{ id: string }> {
    if (params.messages.length === 0) {
      throw new Error("insertMessages requires at least one message");
    }
    const lastIdx = params.messages.length - 1;
    const values = R.map(params.messages, (msg, i) => ({
      conversationId: params.conversationId,
      role: msg.role,
      content: msg.content,
      profileId: params.profileId,
      model: params.model,
      lastInboundMessageId: params.lastInboundMessageId,
      ...(i === lastIdx &&
        params.lastMessageInputTokens != null && {
          inputTokens: params.lastMessageInputTokens,
        }),
      // Intermediate tool turns get the sentinel — only the final assistant
      // row carries the real aggregated outputTokens for the fast path.
      outputTokens: i === lastIdx ? params.lastMessageOutputTokens : UNKNOWN_OUTPUT_TOKENS,
    }));
    const rows = await tx.insert(messages).values(values).returning({ id: messages.id });
    const last = R.last(rows);
    if (!last) throw new Error("insertMessages: no rows returned");
    return last;
  }

  async getLastAssistantMessage(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | undefined> {
    const rows = await tx
      .select({
        id: messages.id,
        lastInboundMessageId: messages.lastInboundMessageId,
      })
      .from(messages)
      // Left join: the cursor is not a foreign key, and a row whose cursor has
      // no inbound (fixtures, pruned buffers) is still a chat turn.
      .leftJoin(inboundMessages, eq(inboundMessages.id, messages.lastInboundMessageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, "assistant"),
          or(isNull(inboundMessages.source), ne(inboundMessages.source, "pipeline")),
        ),
      )
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0];
  }

  async listMessages(
    tx: Transaction,
    conversationId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>> {
    const rows = await tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.id));
    return rows as ReadonlyArray<Message & { id: string }>;
  }

  async getLatestSummary(
    tx: Transaction,
    conversationId: string,
  ): Promise<CompactionSummary | undefined> {
    const rows = await tx
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      // Widest coverage, not last inserted — see the table's schema comment.
      .orderBy(desc(conversationSummaries.throughMessageId))
      .limit(1);
    return rows[0];
  }

  async insertOrRecoverSummary(
    tx: Transaction,
    params: {
      conversationId: string;
      summary: string;
      throughMessageId: string;
      messagesSummarized: number;
      model: string;
      source: SummarySourceValue;
    },
  ): Promise<{ kind: "new" | "recovered"; row: CompactionSummary }> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    const rows = await tx
      .insert(conversationSummaries)
      .values(params)
      .onConflictDoUpdate({
        target: [conversationSummaries.conversationId, conversationSummaries.throughMessageId],
        set: { throughMessageId: params.throughMessageId },
      })
      .returning({
        ...getTableColumns(conversationSummaries),
        inserted: sql<boolean>`(xmax = 0)`,
      });
    const { inserted, ...row } = single(rows);
    return { kind: inserted ? "new" : "recovered", row };
  }

  async insertOrRecoverTurnContext(
    tx: Transaction,
    params: StoredTurnContext,
  ): Promise<StoredTurnContext> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    return single(
      await tx
        .insert(turnContexts)
        .values(params)
        .onConflictDoUpdate({
          target: turnContexts.messageId,
          set: { messageId: params.messageId },
        })
        .returning({
          messageId: turnContexts.messageId,
          rendered: turnContexts.rendered,
          context: turnContexts.context,
        }),
    );
  }

  async listTurnContexts(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string | null,
  ): Promise<ReadonlyArray<StoredTurnContext>> {
    return tx
      .select({
        messageId: turnContexts.messageId,
        rendered: turnContexts.rendered,
        context: turnContexts.context,
      })
      .from(turnContexts)
      .innerJoin(messages, eq(messages.id, turnContexts.messageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          afterMessageId === null ? undefined : gt(messages.id, afterMessageId),
        ),
      );
  }

  async getLatestSystemPromptSnapshot(
    tx: Transaction,
    conversationId: string,
  ): Promise<SystemPromptSnapshot | undefined> {
    const rows = await tx
      .select()
      .from(systemPromptSnapshots)
      .where(eq(systemPromptSnapshots.conversationId, conversationId))
      .orderBy(desc(systemPromptSnapshots.openedBy))
      .limit(1);
    return rows[0];
  }

  async insertOrRecoverSystemPromptSnapshot(
    tx: Transaction,
    params: Omit<SystemPromptSnapshot, "id" | "createdAt">,
  ): Promise<SystemPromptSnapshot> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    return single(
      await tx
        .insert(systemPromptSnapshots)
        .values(params)
        .onConflictDoUpdate({
          target: [systemPromptSnapshots.conversationId, systemPromptSnapshots.openedBy],
          set: { openedBy: params.openedBy },
        })
        .returning(),
    );
  }

  async getHistoryAfter(
    tx: Transaction,
    conversationId: string,
    afterMessageId: string,
  ): Promise<ReadonlyArray<Message & { id: string }>> {
    const rows = await tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.id, afterMessageId)))
      .orderBy(asc(messages.id));
    return rows as ReadonlyArray<Message & { id: string }>;
  }

  async getObserverBounds(tx: Transaction, conversationId: string): Promise<ObserverBounds> {
    const [conversation] = await tx
      .select({
        corrections: conversations.correctionsObservedThrough,
        memories: conversations.memoriesObservedThrough,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const [stats] = await tx
      .select({ messageCount: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const [last] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.id))
      .limit(1);
    return {
      messageCount: stats?.messageCount ?? 0,
      lastMessageId: last?.id ?? null,
      observedThrough: {
        corrections: conversation?.corrections ?? null,
        memories: conversation?.memories ?? null,
      },
    };
  }

  async listMessagesInRange(
    tx: Transaction,
    conversationId: string,
    range: { after: string | null; through: string; limit: number | null },
  ): Promise<ReadonlyArray<Message & { id: string }>> {
    const query = tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          range.after === null ? undefined : gt(messages.id, range.after),
          lte(messages.id, range.through),
        ),
      )
      .orderBy(asc(messages.id))
      .$dynamic();
    const rows = await (range.limit === null ? query : query.limit(range.limit));
    return rows as ReadonlyArray<Message & { id: string }>;
  }

  async listMessagesThrough(
    tx: Transaction,
    conversationId: string,
    through: string,
    limit: number,
  ): Promise<ReadonlyArray<Message & { id: string }>> {
    const rows = await tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), lte(messages.id, through)))
      .orderBy(desc(messages.id))
      .limit(limit);
    return (rows as Array<Message & { id: string }>).reverse();
  }

  async getLatestSummaryThrough(
    tx: Transaction,
    conversationId: string,
    through: string,
  ): Promise<CompactionSummary | undefined> {
    const rows = await tx
      .select()
      .from(conversationSummaries)
      .where(
        and(
          eq(conversationSummaries.conversationId, conversationId),
          lte(conversationSummaries.throughMessageId, through),
        ),
      )
      .orderBy(desc(conversationSummaries.throughMessageId))
      .limit(1);
    return rows[0];
  }

  async advanceObserverCursor(
    tx: Transaction,
    params: { conversationId: string; phase: ObservedPhase; through: string },
  ): Promise<boolean> {
    const corrections = params.phase === "corrections";
    const cursor = corrections
      ? conversations.correctionsObservedThrough
      : conversations.memoriesObservedThrough;
    const moved = await tx
      .update(conversations)
      .set(
        corrections
          ? { correctionsObservedThrough: params.through }
          : { memoriesObservedThrough: params.through },
      )
      .where(
        and(
          eq(conversations.id, params.conversationId),
          or(isNull(cursor), lt(cursor, params.through)),
        ),
      )
      .returning({ id: conversations.id });
    return moved.length > 0;
  }

  async getProfile(tx: Transaction, profileId: string): Promise<Profile | undefined> {
    const rows = await tx
      .select({
        id: profiles.id,
        userId: profiles.userId,
        name: profiles.name,
        basePrompt: profiles.basePrompt,
        model: profiles.model,
        summarizationModel: profiles.summarizationModel,
        extractionModel: profiles.extractionModel,
        autoRecall: profiles.autoRecall,
        voiceMode: profiles.voiceMode,
        toolSet: profiles.toolSet,
        memoryScope: profiles.memoryScope,
        profileClass: profiles.profileClass,
        streamChunkChars: profiles.streamChunkChars,
        streamEdits: profiles.streamEdits,
        codingAutoapproveMode: profiles.codingAutoapproveMode,
      })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    return rows[0];
  }

  async getFirstUser(tx: Transaction): Promise<{ id: string } | undefined> {
    const rows = await tx.select({ id: users.id }).from(users).orderBy(asc(users.id)).limit(1);
    return rows[0];
  }

  async getDefaultProfile(tx: Transaction): Promise<{ id: string } | undefined> {
    const rows = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .orderBy(asc(profiles.id))
      .limit(1);
    return rows[0];
  }

  async createProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
      memoryScope?: ProfileMemoryScope | null;
    },
  ): Promise<Profile> {
    return translateUniqueViolation(async () => {
      const row = single(
        await tx.insert(profiles).values(params).returning({
          id: profiles.id,
          userId: profiles.userId,
          name: profiles.name,
          basePrompt: profiles.basePrompt,
          model: profiles.model,
          summarizationModel: profiles.summarizationModel,
          extractionModel: profiles.extractionModel,
          autoRecall: profiles.autoRecall,
          voiceMode: profiles.voiceMode,
          toolSet: profiles.toolSet,
          memoryScope: profiles.memoryScope,
          profileClass: profiles.profileClass,
          streamChunkChars: profiles.streamChunkChars,
          streamEdits: profiles.streamEdits,
          codingAutoapproveMode: profiles.codingAutoapproveMode,
        }),
      );
      return row as Profile;
    });
  }

  async insertOrRecoverProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
    },
  ): Promise<{ kind: "new" | "recovered"; id: string }> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    const rows = await tx
      .insert(profiles)
      .values(params)
      .onConflictDoUpdate({ target: [profiles.userId, profiles.name], set: { name: params.name } })
      .returning({ id: profiles.id, inserted: sql<boolean>`(xmax = 0)` });
    const { id, inserted } = single(rows);
    return { kind: inserted ? "new" : "recovered", id };
  }

  async listProfiles(tx: Transaction, userId: string): Promise<ReadonlyArray<Profile>> {
    const rows = await tx
      .select({
        id: profiles.id,
        userId: profiles.userId,
        name: profiles.name,
        basePrompt: profiles.basePrompt,
        model: profiles.model,
        summarizationModel: profiles.summarizationModel,
        extractionModel: profiles.extractionModel,
        autoRecall: profiles.autoRecall,
        voiceMode: profiles.voiceMode,
        toolSet: profiles.toolSet,
        memoryScope: profiles.memoryScope,
        profileClass: profiles.profileClass,
        streamChunkChars: profiles.streamChunkChars,
        streamEdits: profiles.streamEdits,
        codingAutoapproveMode: profiles.codingAutoapproveMode,
      })
      .from(profiles)
      .where(or(isNull(profiles.userId), eq(profiles.userId, userId)))
      .orderBy(asc(profiles.name));
    return rows as ReadonlyArray<Profile>;
  }

  async getProfileOwner(
    tx: Transaction,
    profileId: string,
  ): Promise<{ userId: string | null } | undefined> {
    const rows = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    return rows[0];
  }

  async updateProfile(
    tx: Transaction,
    profileId: string,
    changes: ProfileUpdates,
  ): Promise<Profile> {
    return translateUniqueViolation(async () => {
      const rows = await tx
        .update(profiles)
        .set(changes)
        .where(eq(profiles.id, profileId))
        .returning({
          id: profiles.id,
          userId: profiles.userId,
          name: profiles.name,
          basePrompt: profiles.basePrompt,
          model: profiles.model,
          summarizationModel: profiles.summarizationModel,
          extractionModel: profiles.extractionModel,
          autoRecall: profiles.autoRecall,
          voiceMode: profiles.voiceMode,
          toolSet: profiles.toolSet,
          memoryScope: profiles.memoryScope,
          profileClass: profiles.profileClass,
          streamChunkChars: profiles.streamChunkChars,
          streamEdits: profiles.streamEdits,
          codingAutoapproveMode: profiles.codingAutoapproveMode,
        });
      return single(rows) as Profile;
    });
  }

  async countProfileReferences(
    tx: Transaction,
    profileId: string,
  ): Promise<{ conversations: number; messages: number }> {
    const [convRows, msgRows] = await Promise.all([
      tx
        .select({ value: count() })
        .from(conversations)
        .where(eq(conversations.profileId, profileId)),
      tx.select({ value: count() }).from(messages).where(eq(messages.profileId, profileId)),
    ]);
    return {
      conversations: convRows[0]?.value ?? 0,
      messages: msgRows[0]?.value ?? 0,
    };
  }

  async deleteProfile(tx: Transaction, profileId: string): Promise<void> {
    // Check refs + delete in one transaction so a concurrent conversation create / message insert
    // can't sneak in between count and delete. Without this, callers would see a raw FK error
    // instead of the typed ProfileInUseError.
    const [convRows, msgRows, taskRows, skillRows, ruleRows] = await Promise.all([
      tx
        .select({ value: count() })
        .from(conversations)
        .where(eq(conversations.profileId, profileId)),
      tx.select({ value: count() }).from(messages).where(eq(messages.profileId, profileId)),
      tx
        .select({ value: count() })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.profileId, profileId)),
      tx.select({ value: count() }).from(skills).where(eq(skills.runAsProfileId, profileId)),
      tx
        .select({ value: count() })
        .from(steeringRules)
        .where(eq(steeringRules.profileId, profileId)),
    ]);
    const refs = {
      conversations: convRows[0]?.value ?? 0,
      messages: msgRows[0]?.value ?? 0,
      schedules: (taskRows[0]?.value ?? 0) + (skillRows[0]?.value ?? 0),
      steeringRules: ruleRows[0]?.value ?? 0,
    };
    if (Object.values(refs).some((n) => n > 0)) {
      throw new ProfileInUseError(refs);
    }
    await tx.delete(profiles).where(eq(profiles.id, profileId));
  }

  async listProfileClasses(tx: Transaction, userId: string): Promise<ReadonlyArray<ProfileClass>> {
    const rows = await tx
      .select({
        id: profileClasses.id,
        userId: profileClasses.userId,
        name: profileClasses.name,
        description: profileClasses.description,
        restricted: profileClasses.restricted,
        createdAt: profileClasses.createdAt,
      })
      .from(profileClasses)
      .where(eq(profileClasses.userId, userId))
      .orderBy(asc(profileClasses.name));
    return rows;
  }

  async createProfileClass(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<ProfileClass> {
    if (!CANONICAL_NAME_RE.test(params.name)) {
      throw new InvalidNameError(params.name, "profile_class");
    }
    return translateUniqueViolation(async () => {
      return single(
        await tx.insert(profileClasses).values(params).returning({
          id: profileClasses.id,
          userId: profileClasses.userId,
          name: profileClasses.name,
          description: profileClasses.description,
          restricted: profileClasses.restricted,
          createdAt: profileClasses.createdAt,
        }),
      );
    });
  }

  async setProfileClassRestricted(
    tx: Transaction,
    userId: string,
    name: string,
    restricted: boolean,
  ): Promise<{ updated: boolean }> {
    const updated = await tx
      .update(profileClasses)
      .set({ restricted })
      .where(and(eq(profileClasses.userId, userId), eq(profileClasses.name, name)))
      .returning({ id: profileClasses.id });
    return { updated: updated.length > 0 };
  }

  async deleteProfileClass(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<{ deleted: boolean }> {
    // Atomicity comes from the composite FK on `profiles(user_id, profile_class)`
    // with ON DELETE RESTRICT — the DELETE fails at the DB level if any
    // profile still references this class, even when a concurrent
    // setProfileClass slipped its UPDATE in after our count. The count
    // below is informational only; a stale value is harmless because the
    // FK is the authoritative check.
    const refRows = await tx
      .select({ value: count() })
      .from(profiles)
      .where(and(eq(profiles.userId, userId), eq(profiles.profileClass, name)));
    const refCount = refRows[0]?.value ?? 0;
    return translateReferentialViolation(
      async () => {
        const deleted = await tx
          .delete(profileClasses)
          .where(and(eq(profileClasses.userId, userId), eq(profileClasses.name, name)))
          .returning({ id: profileClasses.id });
        return { deleted: deleted.length > 0 };
      },
      {
        constraintName: "fk_profiles_profile_class",
        // refCount may be 0 here (the violating UPDATE landed AFTER we
        // counted) — that's fine; the message is informational and the
        // important fact is "in use right now", which the FK confirmed.
        rethrow: () => new ProfileClassInUseError(Math.max(refCount, 1)),
      },
    );
  }

  async setProfileClass(
    tx: Transaction,
    profileId: string,
    className: string | null,
  ): Promise<void> {
    if (className === null) {
      await tx.update(profiles).set({ profileClass: null }).where(eq(profiles.id, profileId));
      return;
    }
    // Composite FK with MATCH SIMPLE skips its check when either column is
    // NULL — so for org profiles (user_id IS NULL) the FK would silently
    // allow any class name. Reject org-profile classing here so the
    // contract holds for that path too.
    const owner = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    const found = owner[0];
    if (!found || found.userId === null) {
      throw new UnknownProfileClassError(className);
    }
    // For non-org profiles, the FK is the authoritative check: an unknown
    // class name surfaces as a 23503 on `fk_profiles_profile_class`.
    // Concurrent deleteProfileClass landing between this UPDATE and
    // commit fails the same way, so stale-snapshot races can't leave a
    // dangling pointer.
    await translateReferentialViolation(
      async () => {
        await tx
          .update(profiles)
          .set({ profileClass: className })
          .where(eq(profiles.id, profileId));
      },
      {
        constraintName: "fk_profiles_profile_class",
        rethrow: () => new UnknownProfileClassError(className),
      },
    );
  }

  async listCustomCompartments(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<CustomCompartment>> {
    return tx
      .select({
        id: customCompartments.id,
        userId: customCompartments.userId,
        name: customCompartments.name,
        description: customCompartments.description,
        createdAt: customCompartments.createdAt,
      })
      .from(customCompartments)
      .where(eq(customCompartments.userId, userId))
      .orderBy(asc(customCompartments.name));
  }

  async createCustomCompartment(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<CustomCompartment> {
    if (!CANONICAL_NAME_RE.test(params.name)) {
      throw new InvalidNameError(params.name, "compartment");
    }
    if (isCoreCompartment(params.name)) {
      throw new ReservedCompartmentNameError(params.name);
    }
    const countRows = await tx
      .select({ value: count() })
      .from(customCompartments)
      .where(eq(customCompartments.userId, params.userId));
    const current = countRows[0]?.value ?? 0;
    if (current >= CUSTOM_COMPARTMENT_LIMIT) {
      throw new CustomCompartmentCapExceededError(CUSTOM_COMPARTMENT_LIMIT, current);
    }
    return translateUniqueViolation(async () => {
      return single(
        await tx.insert(customCompartments).values(params).returning({
          id: customCompartments.id,
          userId: customCompartments.userId,
          name: customCompartments.name,
          description: customCompartments.description,
          createdAt: customCompartments.createdAt,
        }),
      );
    });
  }

  async deleteCustomCompartment(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<{ deleted: boolean }> {
    const deleted = await tx
      .delete(customCompartments)
      .where(and(eq(customCompartments.userId, userId), eq(customCompartments.name, name)))
      .returning({ id: customCompartments.id });
    return { deleted: deleted.length > 0 };
  }

  async getMessage(
    tx: Transaction,
    messageId: string,
  ): Promise<{ id: string; role: string; content: string | ContentBlock[] } | undefined> {
    const rows = await tx
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    return rows[0];
  }

  async getActiveRules(tx: Transaction, scope: RuleScope): Promise<ReadonlyArray<SectionedRule>> {
    const rows = await tx
      .select({
        rule: steeringRules.rule,
        source: steeringRules.source,
        channelType: steeringRules.channelType,
      })
      .from(steeringRules)
      .where(and(eq(steeringRules.active, true), visibleTo(scope)))
      .orderBy(...RULE_ORDER);
    return rows.map((r) => ({
      rule: r.rule,
      section: ruleSection(r.source),
      channelType: r.channelType,
    }));
  }

  async getCoreMemoryBlocks(
    tx: Transaction,
    userId: string,
    profileClass: string | null,
  ): Promise<ReadonlyArray<ScopedCoreMemoryBlock>> {
    const columns = {
      profileClass: coreMemoryBlocks.profileClass,
      key: coreMemoryBlocks.key,
      content: coreMemoryBlocks.content,
    };
    if (profileClass === null) {
      return tx
        .select(columns)
        .from(coreMemoryBlocks)
        .where(and(eq(coreMemoryBlocks.userId, userId), isNull(coreMemoryBlocks.profileClass)))
        .orderBy(asc(coreMemoryBlocks.key));
    }
    return tx
      .select(columns)
      .from(coreMemoryBlocks)
      .where(
        and(
          eq(coreMemoryBlocks.userId, userId),
          or(
            and(
              isNull(coreMemoryBlocks.profileClass),
              eq(coreMemoryBlocks.key, IDENTITY_BLOCK_KEY),
            ),
            eq(coreMemoryBlocks.profileClass, profileClass),
          ),
        ),
      )
      .orderBy(
        asc(isNotNull(coreMemoryBlocks.profileClass)),
        asc(ne(coreMemoryBlocks.key, IDENTITY_BLOCK_KEY)),
        asc(coreMemoryBlocks.key),
      );
  }

  async upsertCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string | null; key: string; content: string },
  ): Promise<CoreMemoryUpsertOutcome> {
    const [row] = await tx
      .insert(coreMemoryBlocks)
      .values(params)
      .onConflictDoUpdate({
        target: [coreMemoryBlocks.userId, coreMemoryBlocks.profileClass, coreMemoryBlocks.key],
        // The database clock, which also times snapshots and turn contexts.
        set: { content: params.content, updatedAt: sql`now()` },
        setWhere: ne(coreMemoryBlocks.content, params.content),
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (row === undefined) return "unchanged";
    return row.inserted ? "created" : "updated";
  }

  async deleteCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string; key: string },
  ): Promise<boolean> {
    const deleted = await tx
      .delete(coreMemoryBlocks)
      .where(
        and(
          eq(coreMemoryBlocks.userId, params.userId),
          eq(coreMemoryBlocks.profileClass, params.profileClass),
          eq(coreMemoryBlocks.key, params.key),
        ),
      )
      .returning({ id: coreMemoryBlocks.id });
    return deleted.length > 0;
  }

  async getCoreMemoryUpdateTimes(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<{ profileClass: string | null; key: string; updatedAt: Date }>> {
    return tx
      .select({
        profileClass: coreMemoryBlocks.profileClass,
        key: coreMemoryBlocks.key,
        updatedAt: coreMemoryBlocks.updatedAt,
      })
      .from(coreMemoryBlocks)
      .where(eq(coreMemoryBlocks.userId, userId));
  }

  async listCoreMemoryKeys(
    tx: Transaction,
    userId: string,
    profileClass: string,
  ): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .select({ key: coreMemoryBlocks.key })
      .from(coreMemoryBlocks)
      .where(
        and(eq(coreMemoryBlocks.userId, userId), eq(coreMemoryBlocks.profileClass, profileClass)),
      )
      .orderBy(asc(coreMemoryBlocks.key));
    return rows.map((r) => r.key);
  }

  async getLastTokens(
    tx: Transaction,
    conversationId: string,
  ): Promise<
    | {
        inputTokens: number | null;
        outputTokens: number;
      }
    | undefined
  > {
    const rows = await tx
      .select({
        inputTokens: messages.inputTokens,
        outputTokens: messages.outputTokens,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0];
  }

  async getLastMessageTime(tx: Transaction, conversationId: string): Promise<Date | undefined> {
    const rows = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0]?.createdAt;
  }

  async findMostRecentConversationForUserProfile(
    tx: Transaction,
    userId: string,
    profileId: string,
  ): Promise<{ id: string; lastMessageAt: Date | null } | undefined> {
    // Two queries instead of a correlated subquery: under PGlite,
    // Drizzle wraps the FROM in a sub-select for the trailing LIMIT and
    // the inner reference to `conversations.id` loses correlation.
    const convRows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.profileId, profileId),
          eq(conversations.isPrivate, true),
        ),
      )
      .orderBy(desc(conversations.id))
      .limit(1);
    const conv = convRows[0];
    if (!conv) return undefined;

    const msgRows = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.id))
      .limit(1);
    return { id: conv.id, lastMessageAt: msgRows[0]?.createdAt ?? null };
  }

  // --- Conversation admin ---

  async listConversationsForUser(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<ConversationSummary>> {
    // One round-trip: pull every private conversation for the user with its profile name and
    // (optional) alias. Last-message preview is a correlated subquery — we want the latest row
    // regardless of role so /sessions shows the most recent activity.
    const rows = await tx
      .select({
        id: conversations.id,
        profileName: profiles.name,
        alias: aliases.alias,
        content: sql<unknown>`(
          SELECT ${messages.content}
          FROM ${messages}
          WHERE ${messages.conversationId} = ${conversations.id}
          ORDER BY ${messages.id} DESC
          LIMIT 1
        )`,
        lastMessageAt: sql<string | Date | null>`(
          SELECT ${messages.createdAt}
          FROM ${messages}
          WHERE ${messages.conversationId} = ${conversations.id}
          ORDER BY ${messages.id} DESC
          LIMIT 1
        )`,
      })
      .from(conversations)
      .innerJoin(profiles, eq(profiles.id, conversations.profileId))
      .leftJoin(aliases, eq(aliases.conversationId, conversations.id))
      .where(and(eq(conversations.userId, userId), eq(conversations.isPrivate, true)))
      .orderBy(desc(conversations.id));

    return rows
      .filter((r) => r.lastMessageAt != null) // skip conversations with no messages yet
      .map((r) => {
        // Correlated subquery loses the Drizzle column type mapper — driver returns either
        // a Date (postgres-js) or an ISO string (PGlite); normalize.
        const raw = r.lastMessageAt as Date | string;
        const lastMessageAt = raw instanceof Date ? raw : new Date(raw);
        return {
          id: r.id,
          profileName: r.profileName,
          alias: r.alias,
          lastMessagePreview: previewFromContent(r.content),
          lastMessageAt,
        };
      });
  }

  async setConversationProfile(
    tx: Transaction,
    conversationId: string,
    profileId: string,
  ): Promise<void> {
    await tx.update(conversations).set({ profileId }).where(eq(conversations.id, conversationId));
  }

  async setAlias(
    tx: Transaction,
    userId: string,
    conversationId: string,
    alias: string | null,
  ): Promise<void> {
    await translateUniqueViolation(async () => {
      if (alias === null) {
        await tx.delete(aliases).where(eq(aliases.conversationId, conversationId));
        return;
      }
      await tx.insert(aliases).values({ userId, conversationId, alias }).onConflictDoUpdate({
        target: aliases.conversationId,
        set: { alias },
      });
    });
  }

  async findConversationByAlias(
    tx: Transaction,
    userId: string,
    alias: string,
  ): Promise<{ conversationId: string } | undefined> {
    const rows = await tx
      .select({ conversationId: aliases.conversationId })
      .from(aliases)
      .where(and(eq(aliases.userId, userId), eq(aliases.alias, alias)))
      .limit(1);
    return rows[0];
  }

  async getAliasForConversation(
    tx: Transaction,
    userId: string,
    conversationId: string,
  ): Promise<string | undefined> {
    const rows = await tx
      .select({ alias: aliases.alias })
      .from(aliases)
      .where(and(eq(aliases.userId, userId), eq(aliases.conversationId, conversationId)))
      .limit(1);
    return rows[0]?.alias;
  }

  async getConversationStats(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ createdAt: Date; messageCount: number; lastMessageAt: Date | null } | undefined> {
    const convRows = await tx
      .select({ createdAt: conversations.createdAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const conv = convRows[0];
    if (!conv) return undefined;
    const [countRows, lastRows] = await Promise.all([
      tx
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.conversationId, conversationId)),
      tx
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.id))
        .limit(1),
    ]);
    return {
      createdAt: conv.createdAt,
      messageCount: countRows[0]?.value ?? 0,
      lastMessageAt: lastRows[0]?.createdAt ?? null,
    };
  }

  // --- Model discovery ---

  async listDistinctUserSelectableModels(tx: Transaction): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .selectDistinct({ model: modelProviders.model })
      .from(modelProviders)
      .where(eq(modelProviders.userSelectable, true))
      .orderBy(asc(modelProviders.model));
    return rows.map((r) => r.model);
  }

  async isModelUserSelectable(tx: Transaction, model: string): Promise<boolean> {
    const rows = await tx
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(and(eq(modelProviders.model, model), eq(modelProviders.userSelectable, true)))
      .limit(1);
    return rows.length > 0;
  }

  // --- LLM Providers ---

  async createProvider(
    tx: Transaction,
    params: {
      name: string;
      type: LlmProviderTypeValue;
      baseUrl?: string;
      secretId: string;
      attrs: ProviderAttrs;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(llmProviders)
        .values({
          name: params.name,
          type: params.type,
          baseUrl: params.baseUrl,
          secretId: params.secretId,
          attrs: params.attrs,
        })
        .returning({ id: llmProviders.id }),
    );
  }

  async getProvider(
    tx: Transaction,
    providerId: string,
  ): Promise<
    | {
        id: string;
        name: string;
        type: LlmProviderTypeValue;
        baseUrl: string | null;
        secretId: string;
        attrs: ProviderAttrs;
      }
    | undefined
  > {
    const rows = await tx
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        secretId: llmProviders.secretId,
        attrs: llmProviders.attrs,
      })
      .from(llmProviders)
      .where(eq(llmProviders.id, providerId))
      .limit(1);
    return rows[0];
  }

  async listProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      attrs: ProviderAttrs;
    }>
  > {
    return tx
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        attrs: llmProviders.attrs,
      })
      .from(llmProviders);
  }

  async setProviderCacheDialect(
    tx: Transaction,
    providerId: string,
    cacheDialect: CacheDialect,
  ): Promise<boolean> {
    // JSONB `||` merges the key into the row's attrs in one UPDATE, bypassing
    // the column's write validation, so the patch is validated here.
    const patch = ProviderAttrsSchema.parse({ cacheDialect });
    const rows = await tx
      .update(llmProviders)
      .set({ attrs: sql`${llmProviders.attrs} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(llmProviders.id, providerId))
      .returning({ id: llmProviders.id });
    return rows.length > 0;
  }

  async deleteProvider(tx: Transaction, providerId: string): Promise<void> {
    // model_providers cascade-deletes via ON DELETE CASCADE
    await tx.delete(llmProviders).where(eq(llmProviders.id, providerId));
  }

  // --- Model → Provider routing ---

  async addModelProvider(
    tx: Transaction,
    params: {
      model: string;
      providerId: string;
      position: number;
      userSelectable: boolean;
      contextWindow?: number | null;
      maxOutputTokens?: number | null;
    },
  ): Promise<{ id: string }> {
    const { contextWindow, maxOutputTokens, ...rest } = params;
    return single(
      await tx
        .insert(modelProviders)
        .values({
          ...rest,
          contextWindow: contextWindow ?? null,
          maxOutputTokens: maxOutputTokens ?? null,
        })
        .returning({ id: modelProviders.id }),
    );
  }

  async listProvidersForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
    }>
  > {
    const rows = await tx
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        secretId: llmProviders.secretId,
        attrs: llmProviders.attrs,
        position: modelProviders.position,
        contextWindow: modelProviders.contextWindow,
        maxOutputTokens: modelProviders.maxOutputTokens,
      })
      .from(modelProviders)
      .innerJoin(llmProviders, eq(modelProviders.providerId, llmProviders.id))
      .where(eq(modelProviders.model, model))
      .orderBy(asc(modelProviders.position));
    return rows;
  }

  async listAllModelProviders(tx: Transaction): Promise<
    ReadonlyArray<{
      model: string;
      id: string;
      name: string;
      type: LlmProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
      position: number;
      contextWindow: number | null;
      maxOutputTokens: number | null;
    }>
  > {
    const rows = await tx
      .select({
        model: modelProviders.model,
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
        baseUrl: llmProviders.baseUrl,
        secretId: llmProviders.secretId,
        attrs: llmProviders.attrs,
        position: modelProviders.position,
        contextWindow: modelProviders.contextWindow,
        maxOutputTokens: modelProviders.maxOutputTokens,
      })
      .from(modelProviders)
      .innerJoin(llmProviders, eq(modelProviders.providerId, llmProviders.id))
      .orderBy(asc(modelProviders.model), asc(modelProviders.position));
    return rows;
  }

  async getNextModelProviderPosition(tx: Transaction, model: string): Promise<number> {
    const rows = await tx
      .select({ position: modelProviders.position })
      .from(modelProviders)
      .where(eq(modelProviders.model, model))
      .orderBy(desc(modelProviders.position))
      .limit(1);
    return rows[0] ? rows[0].position + 1 : 0;
  }

  async removeModelProvidersByProvider(tx: Transaction, providerId: string): Promise<void> {
    await tx.delete(modelProviders).where(eq(modelProviders.providerId, providerId));
  }

  async removeModelProvider(tx: Transaction, model: string, providerId: string): Promise<void> {
    await tx
      .delete(modelProviders)
      .where(and(eq(modelProviders.model, model), eq(modelProviders.providerId, providerId)));
  }

  async listAllModels(tx: Transaction): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .selectDistinct({ model: modelProviders.model })
      .from(modelProviders)
      .orderBy(asc(modelProviders.model));
    return rows.map((r) => r.model);
  }

  // --- Image Providers ---

  async createImageProvider(
    tx: Transaction,
    params: {
      name: string;
      type: ImageProviderTypeValue;
      baseUrl: string | null;
      secretId: string;
      attrs: ImageProviderAttrs;
    },
  ): Promise<{ id: string }> {
    validateImageProviderBaseUrl(params.type, params.baseUrl);
    return translateUniqueViolation(async () =>
      single(
        await tx
          .insert(imageProviders)
          .values({
            name: params.name,
            type: params.type,
            baseUrl: params.baseUrl,
            secretId: params.secretId,
            attrs: params.attrs,
          })
          .returning({ id: imageProviders.id }),
      ),
    );
  }

  async getImageProvider(
    tx: Transaction,
    providerId: string,
  ): Promise<ImageProviderRow | undefined> {
    const rows = await tx
      .select()
      .from(imageProviders)
      .where(eq(imageProviders.id, providerId))
      .limit(1);
    return rows[0];
  }

  async findImageProviderByName(
    tx: Transaction,
    name: string,
  ): Promise<ImageProviderRow | undefined> {
    const rows = await tx
      .select()
      .from(imageProviders)
      .where(eq(imageProviders.name, name))
      .limit(1);
    return rows[0];
  }

  async listImageProviders(tx: Transaction): Promise<ReadonlyArray<ImageProviderRow>> {
    return tx.select().from(imageProviders).orderBy(asc(imageProviders.name));
  }

  async deleteImageProvider(tx: Transaction, providerId: string): Promise<void> {
    // image_models rows cascade-delete via ON DELETE CASCADE.
    await tx.delete(imageProviders).where(eq(imageProviders.id, providerId));
  }

  // --- Image Models ---

  async createImageModel(
    tx: Transaction,
    params: {
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    },
  ): Promise<{ id: string }> {
    // Slug-collision pre-check (see ImageModelSlugCollisionError). Catalog
    // size is tiny (~10 rows in practice); a SELECT-then-check is simpler
    // than a SQL-expression unique index and surfaces a clear typed error.
    const slug = imageModelSlug(params.name);
    const existing = await tx.select({ name: imageModels.name }).from(imageModels);
    const collision = existing.find(
      (r) => r.name !== params.name && imageModelSlug(r.name) === slug,
    );
    if (collision) {
      throw new ImageModelSlugCollisionError(params.name, collision.name, slug);
    }
    return translateUniqueViolation(async () =>
      single(await tx.insert(imageModels).values(params).returning({ id: imageModels.id })),
    );
  }

  async upsertImageModelsByName(
    tx: Transaction,
    rows: ReadonlyArray<{
      providerId: string;
      name: string;
      modelString: string;
      description: string;
      capabilities: ImageModelCapabilities;
      userSelectable: boolean;
    }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    // Slug-collision pre-check across (existing rows ∪ new rows in this
    // batch). Rows whose `name` matches an existing row are skipped (the
    // idempotent path used by ensureFalImageDefaults); a different new
    // name with a colliding slug throws.
    const existingNames = (await tx.select({ name: imageModels.name }).from(imageModels)).map(
      (r) => r.name,
    );
    const existingByName = new Set(existingNames);
    const seenSlugs = new Map<string, string>(existingNames.map((n) => [imageModelSlug(n), n]));
    for (const row of rows) {
      if (existingByName.has(row.name)) continue;
      const slug = imageModelSlug(row.name);
      const collision = seenSlugs.get(slug);
      if (collision !== undefined && collision !== row.name) {
        throw new ImageModelSlugCollisionError(row.name, collision, slug);
      }
      seenSlugs.set(slug, row.name);
    }
    // Idempotent: skip rows whose `name` already exists. Operator edits to
    // existing rows survive re-runs of `ensureFalImageDefaults`.
    const inserted = await tx
      .insert(imageModels)
      .values([...rows])
      .onConflictDoNothing({ target: imageModels.name })
      .returning({ id: imageModels.id });
    return inserted.length;
  }

  async listImageModels(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelRow>> {
    const where = opts?.userSelectableOnly ? eq(imageModels.userSelectable, true) : undefined;
    const query = tx.select().from(imageModels).orderBy(asc(imageModels.name));
    return where ? query.where(where) : query;
  }

  async listImageModelsWithProvider(
    tx: Transaction,
    opts?: { userSelectableOnly?: boolean },
  ): Promise<ReadonlyArray<ImageModelWithProvider>> {
    const rows = await tx
      .select({ model: imageModels, provider: imageProviders })
      .from(imageModels)
      .innerJoin(imageProviders, eq(imageModels.providerId, imageProviders.id))
      .where(opts?.userSelectableOnly ? eq(imageModels.userSelectable, true) : undefined)
      .orderBy(asc(imageModels.name));
    return rows.map((r) => ({ ...r.model, provider: r.provider }));
  }

  async deleteImageModel(tx: Transaction, modelId: string): Promise<void> {
    await tx.delete(imageModels).where(eq(imageModels.id, modelId));
  }

  async listSubAgents(tx: Transaction, userId: string): Promise<ReadonlyArray<SubAgent>> {
    return tx
      .select()
      .from(subAgents)
      .where(eq(subAgents.userId, userId))
      .orderBy(asc(subAgents.name));
  }

  async createSubAgent(
    tx: Transaction,
    params: {
      userId: string;
      name: string;
      description: string;
      systemPrompt: string | null;
      model: string;
    },
  ): Promise<{ id: string }> {
    return translateUniqueViolation(async () =>
      single(await tx.insert(subAgents).values(params).returning({ id: subAgents.id })),
    );
  }

  async deleteSubAgent(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<{ deleted: boolean }> {
    const deleted = await tx
      .delete(subAgents)
      .where(and(eq(subAgents.userId, userId), eq(subAgents.name, name)))
      .returning({ id: subAgents.id });
    return { deleted: deleted.length > 0 };
  }

  async hasChannelDefaults(tx: Transaction, channelType: string): Promise<boolean> {
    const rows = await tx
      .select({ id: steeringRules.id })
      .from(steeringRules)
      .where(and(eq(steeringRules.channelType, channelType), eq(steeringRules.source, "seed")))
      .limit(1);
    return rows.length > 0;
  }

  async insertSeedRule(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      channelType: string;
      priority: number;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(steeringRules)
        .values({
          rule: params.rule,
          category: params.category,
          source: "seed",
          active: true,
          priority: params.priority,
          observationCount: 0,
          profileId: null,
          channelType: params.channelType,
        })
        .returning({ id: steeringRules.id }),
    );
  }

  // --- Evolution: correction extraction ---

  async getCorrections(tx: Transaction, profileId: string): Promise<ReadonlyArray<ExtractionRule>> {
    return tx
      .select(EXTRACTION_RULE_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          isNull(steeringRules.retractedAt),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
        ),
      )
      .orderBy(asc(steeringRules.priority), asc(steeringRules.id));
  }

  async getInstructionRules(
    tx: Transaction,
    scope: { profileId: string; userId: string },
  ): Promise<ReadonlyArray<ExtractionRule>> {
    return tx
      .select(EXTRACTION_RULE_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          liveInstructionRulesOf(scope.userId),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, scope.profileId)),
        ),
      )
      .orderBy(asc(steeringRules.priority), asc(steeringRules.id));
  }

  async hasInstructionRule(
    tx: Transaction,
    params: { userId: string; text: string; profileId: string; channelType: string | null },
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: steeringRules.id })
      .from(steeringRules)
      .where(
        and(
          liveInstructionRulesOf(params.userId),
          textMatches(params.text),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, params.profileId)),
          params.channelType === null
            ? isNull(steeringRules.channelType)
            : or(
                isNull(steeringRules.channelType),
                eq(steeringRules.channelType, params.channelType),
              ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async contradictLearningRule(
    tx: Transaction,
    params: { id: string; messageId: string },
  ): Promise<"reset" | "retired" | "unchanged"> {
    const learning = and(
      eq(steeringRules.id, params.id),
      eq(steeringRules.active, false),
      isNull(steeringRules.retractedAt),
      inArray(steeringRules.source, LEARNED_RULE_SOURCES),
    );
    const retired = await tx
      .update(steeringRules)
      .set({ retractedAt: sql`now()`, contradictedByMessageId: params.messageId })
      .where(
        and(
          learning,
          isNotNull(steeringRules.contradictedByMessageId),
          ne(steeringRules.contradictedByMessageId, params.messageId),
        ),
      )
      .returning({ id: steeringRules.id });
    if (retired.length > 0) return "retired";
    const reset = await tx
      .update(steeringRules)
      .set({ observationCount: 0, contradictedByMessageId: params.messageId })
      .where(and(learning, isNull(steeringRules.contradictedByMessageId)))
      .returning({ id: steeringRules.id });
    if (reset.length > 0) return "reset";
    const [applied] = await tx
      .select({ active: steeringRules.active, retractedAt: steeringRules.retractedAt })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.id, params.id),
          eq(steeringRules.contradictedByMessageId, params.messageId),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
        ),
      );
    if (applied === undefined || applied.active) return "unchanged";
    return applied.retractedAt === null ? "reset" : "retired";
  }

  async getMemoryRules(
    tx: Transaction,
    scope: { profileIds: ReadonlyArray<string>; userId: string },
  ): Promise<ReadonlyArray<MemoryRule>> {
    const rows = await tx
      .select({
        rule: steeringRules.rule,
        profileId: steeringRules.profileId,
        userId: steeringRules.userId,
      })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, true),
          eq(steeringRules.category, "memory"),
          scope.profileIds.length === 0
            ? isNull(steeringRules.profileId)
            : or(
                isNull(steeringRules.profileId),
                inArray(steeringRules.profileId, [...scope.profileIds]),
              ),
          or(isNull(steeringRules.userId), eq(steeringRules.userId, scope.userId)),
        ),
      )
      .orderBy(...RULE_ORDER);
    return rows.map((r) => ({ rule: r.rule, profileId: r.profileId, fromUser: r.userId !== null }));
  }

  async upsertCorrection(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      profileId: string | null;
      channelType?: string | null;
      existingRuleId?: string;
    },
  ): Promise<{ id: string; promoted: boolean } | null> {
    if (params.existingRuleId) {
      const rows = await tx
        .update(steeringRules)
        .set({
          observationCount: sql`${steeringRules.observationCount} + 1`,
          active: sql`CASE WHEN ${steeringRules.observationCount} + 1 >= 2 THEN true ELSE ${steeringRules.active} END`,
        })
        .where(and(eq(steeringRules.id, params.existingRuleId), isNull(steeringRules.retractedAt)))
        .returning({
          id: steeringRules.id,
          source: steeringRules.source,
          active: steeringRules.active,
          observationCount: steeringRules.observationCount,
        });
      const row = rows[0];
      if (row === undefined) return null;
      // An instruction rule is live from its set: a reinforcement never promotes it.
      const promoted = row.source !== "instruction" && row.observationCount === 2 && row.active;
      return { id: row.id, promoted };
    }

    const row = single(
      await tx
        .insert(steeringRules)
        .values({
          rule: params.rule,
          category: params.category,
          source: "correction",
          active: false,
          priority: 100,
          observationCount: 1,
          profileId: params.profileId,
          channelType: params.channelType ?? null,
        })
        .returning({ id: steeringRules.id }),
    );
    return { id: row.id, promoted: false };
  }

  async countActiveLearnedRules(tx: Transaction, profileId: string): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, true),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async replaceRules(
    tx: Transaction,
    params: {
      oldIds: string[];
      newRule: {
        rule: string;
        category: string;
        profileId: string | null;
        channelType: string | null;
        priority: number;
        observationCount: number;
      };
    },
  ): Promise<{ id: string }> {
    // A rule retired during consolidation's LLM call is never folded into a
    // live one: short of the whole group, throw so the transaction rolls back.
    // A retirement committed after this snapshot fails the delete with 40001,
    // and the transactor's retry comes up short here.
    const deleted = await tx
      .delete(steeringRules)
      .where(
        and(
          inArray(steeringRules.id, params.oldIds),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          isNull(steeringRules.retractedAt),
        ),
      )
      .returning({ id: steeringRules.id });
    if (deleted.length !== params.oldIds.length) {
      throw new RuleGroupChangedError(params.oldIds.length, deleted.length);
    }
    return single(
      await tx
        .insert(steeringRules)
        .values({
          rule: params.newRule.rule,
          category: params.newRule.category,
          source: "evolution",
          active: true,
          priority: params.newRule.priority,
          observationCount: params.newRule.observationCount,
          profileId: params.newRule.profileId,
          channelType: params.newRule.channelType,
        })
        .returning({ id: steeringRules.id }),
    );
  }

  async setInstructionRule(
    tx: Transaction,
    params: InstructionRuleParams,
  ): Promise<SetInstructionRuleResult> {
    assertChannelType(params.channelType);
    const [held] = await tx
      .select({ value: count() })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.userId, params.userId),
          eq(steeringRules.source, "instruction"),
          isNull(steeringRules.retractedAt),
        ),
      );
    const live = held?.value ?? 0;
    let result: InstructionRuleRow;
    if (live >= INSTRUCTION_RULE_LIMIT) {
      const [existing] = await tx
        .select({ id: steeringRules.id, createdAt: steeringRules.createdAt })
        .from(steeringRules)
        .where(
          and(
            eq(steeringRules.userId, params.userId),
            eq(steeringRules.source, "instruction"),
            isNull(steeringRules.retractedAt),
            textMatches(params.rule),
            inScope(params.profileId, params.channelType),
          ),
        );
      if (existing === undefined) return { kind: "at_limit", live };
      result = { kind: "existing", ...existing };
    } else {
      result = await upsertInstructionRule(tx, params);
    }
    await tx
      .update(steeringRules)
      // Not a contradiction's retirement: no chunk recorded it.
      .set({ active: false, retractedAt: sql`now()`, contradictedByMessageId: null })
      .where(
        and(
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          isNull(steeringRules.retractedAt),
          textMatches(params.rule),
          inScope(params.profileId, params.channelType),
        ),
      );
    return result;
  }

  async retireRulesByText(
    tx: Transaction,
    params: { text: string; userId: string; profileId: string; restricted: boolean },
  ): Promise<RetireRulesResult> {
    const scope = { profileId: params.profileId, userId: params.userId };
    const retired = await tx
      .update(steeringRules)
      // Not a contradiction's retirement: no chunk recorded it.
      .set({ active: false, retractedAt: sql`now()`, contradictedByMessageId: null })
      .where(
        and(
          textMatches(params.text),
          eq(steeringRules.active, true),
          inArray(steeringRules.source, REMOVABLE_RULE_SOURCES),
          visibleTo(scope),
          params.restricted ? eq(steeringRules.profileId, params.profileId) : undefined,
        ),
      )
      .returning(RULE_MATCH_COLUMNS);
    const retiredIds = new Set(retired.map((r) => r.id));
    const others = await tx
      .select(RULE_MATCH_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          textMatches(params.text),
          or(eq(steeringRules.active, true), isNotNull(steeringRules.retractedAt)),
          visibleTo(scope),
        ),
      )
      .orderBy(...RULE_ORDER);
    const [alreadyRetired, notRemovable] = R.partition(
      others.filter((m) => !retiredIds.has(m.id)),
      (m) => m.retractedAt !== null,
    );
    return { retired, alreadyRetired, notRemovable };
  }

  async listRules(
    tx: Transaction,
    scope: { profileId: string; userId: string },
  ): Promise<RuleReview> {
    const live = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(and(eq(steeringRules.active, true), visibleTo(scope)))
      .orderBy(...RULE_ORDER);
    const learning = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, false),
          isNull(steeringRules.retractedAt),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          visibleTo(scope),
        ),
      )
      .orderBy(desc(steeringRules.id));
    const retired = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(and(isNotNull(steeringRules.retractedAt), visibleTo(scope)))
      .orderBy(desc(steeringRules.retractedAt), desc(steeringRules.id))
      .limit(RETIRED_RULES_LISTED);
    const reviewed = (rows: typeof live): ReadonlyArray<ReviewedRule> =>
      rows.map((r) => ({ ...r, section: ruleSection(r.source) }));
    return {
      live: R.sortBy(reviewed(live), (r) => RULE_SECTIONS.indexOf(r.section)),
      learning: reviewed(learning),
      retired: reviewed(retired),
    };
  }

  async stagePendingMemory(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string | null;
      content: string;
      context?: string;
    } & PendingMemoryOrigin,
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(pendingMemories)
        .values({
          userId: params.userId,
          profileId: params.profileId,
          content: params.content,
          context: params.context ?? null,
          source: params.source,
          skillName: params.source === "skill" ? params.skillName : null,
        })
        .returning({ id: pendingMemories.id }),
    );
  }

  async bulkStagePendingMemories(
    tx: Transaction,
    rows: ReadonlyArray<{
      userId: string;
      content: string;
      context?: string;
      source: UnnamedMemorySource;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    // Postgres caps a single statement at 65,535 placeholders. Each row
    // binds 5 columns (profile_id is always null on this path — the
    // migration script has no per-row profile lineage); chunking at 5,000
    // stays well under the cap (and atomicity is preserved by the
    // surrounding transaction).
    for (const chunk of R.chunk([...rows], 5000)) {
      await tx.insert(pendingMemories).values(
        chunk.map((r) => ({
          userId: r.userId,
          profileId: null,
          content: r.content,
          context: r.context ?? null,
          source: r.source,
        })),
      );
    }
  }

  async countPendingMemories(
    tx: Transaction,
    userId: string,
    filter?: PendingMemoryFilter,
  ): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(pendingMemories)
      .where(pendingRowsOf(userId, filter));
    return rows[0]?.value ?? 0;
  }

  async getPendingMemories(
    tx: Transaction,
    userId: string,
    limit?: number,
    filter?: PendingMemoryFilter,
  ): Promise<ReadonlyArray<PendingMemory>> {
    const stagingProfiles = alias(profiles, "staging_profiles");
    // LEFT JOIN onto profiles so we surface the staging profile's CURRENT
    // class on each row at drain time. LEFT (not INNER) so rows whose
    // profile was deleted (`profile_id` SET NULL) or never had one
    // (migration backfill) still drain — they just stamp untagged on the
    // class dimension. Reading the profile's current class (rather than
    // a staging-time snapshot) means renaming a class re-flows all of
    // the user's pending rows under the new name without a backfill.
    const base = tx
      .select({
        id: pendingMemories.id,
        content: pendingMemories.content,
        context: pendingMemories.context,
        source: pendingMemories.source,
        profileId: stagingProfiles.id,
        profileClass: profiles.profileClass,
        skillName: pendingMemories.skillName,
        createdAt: pendingMemories.createdAt,
      })
      .from(pendingMemories)
      // The staging profile whose memory rules the drain applies: the user's
      // own or an org profile (`user_id` NULL), never another user's. An org
      // profile has no class, so the class join below keeps to the user's own.
      .leftJoin(
        stagingProfiles,
        and(
          eq(stagingProfiles.id, pendingMemories.profileId),
          or(isNull(stagingProfiles.userId), eq(stagingProfiles.userId, pendingMemories.userId)),
        ),
      )
      // Defence in depth on the join: require the joined profile to
      // belong to the SAME user as the pending row. The FK on
      // `pending_memories.profile_id → profiles.id` doesn't enforce
      // user ownership (profiles.user_id is independent), so if a row
      // ever drifts (manual SQL, future bug, data corruption) and
      // points to another user's profile, we'd otherwise surface that
      // user's `profile_class` here and leak across the speaker
      // boundary at retain time. With the second predicate, a
      // mismatched row falls back to NULL on the join and stamps
      // untagged on the class dimension.
      .leftJoin(
        profiles,
        and(
          eq(profiles.id, pendingMemories.profileId),
          eq(profiles.userId, pendingMemories.userId),
        ),
      )
      .where(pendingRowsOf(userId, filter))
      // Secondary sort by id breaks createdAt ties — bulk inserts share a
      // timestamp, but UUIDv7 ids are time-ordered, so the tiebreak preserves
      // insertion order for callers that care (drain FIFO, tests).
      .orderBy(asc(pendingMemories.createdAt), asc(pendingMemories.id));
    return limit !== undefined ? await base.limit(limit) : await base;
  }

  async deletePendingMemories(tx: Transaction, ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    await tx.delete(pendingMemories).where(inArray(pendingMemories.id, [...ids]));
  }

  async createScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
    },
  ): Promise<ScheduledTask> {
    return rowToScheduledTask(
      single(await tx.insert(scheduledTasks).values(scheduleValues(params)).returning()),
    );
  }

  async createOrRecoverScheduledTask(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string;
      kind: ScheduleKind;
      cron: string | null;
      timezone: string;
      prompt: string;
      nextRunAt: Date;
      enabled: boolean;
      catchupMissed: boolean;
      source: ScheduleSource;
      idempotencyKey: string;
    },
  ): Promise<{ kind: "new" | "recovered"; row: ScheduledTask }> {
    const key = params.idempotencyKey;
    // Keyed insert: see `.claude/rules/inngest.md`.
    //
    // `xmax = 0` distinguishes the outcomes, so the caller can recover a retry
    // inside the same transaction as its cap check rather than pre-reading in
    // one of its own.
    const rows = await tx
      .insert(scheduledTasks)
      .values({ ...scheduleValues(params), idempotencyKey: key })
      .onConflictDoUpdate({
        target: scheduledTasks.idempotencyKey,
        set: { idempotencyKey: key },
      })
      .returning({ ...getTableColumns(scheduledTasks), inserted: sql<boolean>`(xmax = 0)` });
    const { inserted, ...row } = single(rows);
    return { kind: inserted ? "new" : "recovered", row: rowToScheduledTask(row) };
  }

  async getScheduledTaskByIdempotencyKey(
    tx: Transaction,
    key: string,
  ): Promise<ScheduledTask | undefined> {
    const rows = await tx
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.idempotencyKey, key))
      .limit(1);
    const row = rows[0];
    return row ? rowToScheduledTask(row) : undefined;
  }

  async getScheduledTask(tx: Transaction, id: string): Promise<ScheduledTask | undefined> {
    const rows = await tx.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1);
    const row = rows[0];
    return row ? rowToScheduledTask(row) : undefined;
  }

  async listScheduledTasks(
    tx: Transaction,
    userId: string,
    opts?: { includeDisabled?: boolean },
  ): Promise<ReadonlyArray<ScheduledTask>> {
    const includeDisabled = opts?.includeDisabled ?? true;
    const where = includeDisabled
      ? eq(scheduledTasks.userId, userId)
      : and(eq(scheduledTasks.userId, userId), eq(scheduledTasks.enabled, true));
    const rows = await tx
      .select()
      .from(scheduledTasks)
      .where(where)
      .orderBy(desc(scheduledTasks.createdAt));
    return rows.map(rowToScheduledTask);
  }

  async countScheduledTasks(tx: Transaction, userId: string): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.userId, userId));
    return rows[0]?.value ?? 0;
  }

  async lockDueScheduledTasks(
    tx: Transaction,
    params: { now: Date; limit: number },
  ): Promise<ReadonlyArray<ScheduledTask>> {
    const rows = await tx
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, params.now)))
      .orderBy(asc(scheduledTasks.nextRunAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });
    return rows.map(rowToScheduledTask);
  }

  async advanceScheduledTask(
    tx: Transaction,
    id: string,
    params: { lastRunAt: Date; nextRunAt: Date; disable?: boolean },
  ): Promise<void> {
    const updates: {
      lastRunAt: Date;
      nextRunAt: Date;
      enabled?: boolean;
    } = {
      lastRunAt: params.lastRunAt,
      nextRunAt: params.nextRunAt,
    };
    if (params.disable) {
      updates.enabled = false;
    }
    await tx.update(scheduledTasks).set(updates).where(eq(scheduledTasks.id, id));
  }

  async setScheduledTaskEnabled(tx: Transaction, id: string, enabled: boolean): Promise<void> {
    await tx.update(scheduledTasks).set({ enabled }).where(eq(scheduledTasks.id, id));
  }

  async deleteScheduledTask(tx: Transaction, id: string): Promise<void> {
    await tx.delete(scheduledTasks).where(eq(scheduledTasks.id, id));
  }

  // --- Evolution: audit log ---

  async recordEvolutionEvent(
    tx: Transaction,
    params: {
      conversationId: string;
      userId: string;
      triggeredBy: EvolutionTriggerValue;
      payload: EvolutionEventPayload;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(evolutionEvents)
        .values({
          conversationId: params.conversationId,
          userId: params.userId,
          triggeredBy: params.triggeredBy,
          payload: params.payload,
        })
        .returning({ id: evolutionEvents.id }),
    );
  }

  async listEvolutionEvents(
    tx: Transaction,
    userId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<EvolutionEventRow>> {
    const limit = opts?.limit ?? 10;
    return tx
      .select()
      .from(evolutionEvents)
      .where(eq(evolutionEvents.userId, userId))
      .orderBy(desc(evolutionEvents.createdAt))
      .limit(limit);
  }

  async getEvolutionEvent(
    tx: Transaction,
    userId: string,
    id: string,
  ): Promise<EvolutionEventRow | undefined> {
    const rows = await tx
      .select()
      .from(evolutionEvents)
      .where(and(eq(evolutionEvents.id, id), eq(evolutionEvents.userId, userId)))
      .limit(1);
    return rows[0];
  }
}

function rowToScheduledTask(row: typeof scheduledTasks.$inferSelect): ScheduledTask {
  return {
    id: row.id,
    userId: row.userId,
    profileId: row.profileId,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    enabled: row.enabled,
    catchupMissed: row.catchupMissed,
    source: row.source,
    createdAt: row.createdAt,
  };
}
