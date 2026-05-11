import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as R from "remeda";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { ContentBlock, Message } from "../../llm/types.js";
import { truncate } from "../../util/string.js";
import { isCoreCompartment } from "../evolution/memory-extraction-schema.js";
import type { AutoRecallMode } from "../recall-gate.js";
import {
  CustomCompartmentCapExceededError,
  InvalidNameError,
  ProfileClassInUseError,
  ProfileInUseError,
  ReservedCompartmentNameError,
  translateForeignKeyViolation,
  translateUniqueViolation,
  UnknownProfileClassError,
} from "./errors.js";
import {
  aliases,
  conversations,
  coreMemoryBlocks,
  customCompartments,
  llmProviders,
  messages,
  modelProviders,
  type ProfileMemoryScope,
  type ProviderAttrs,
  pendingMemories,
  profileClasses,
  profiles,
  steeringRules,
  type ToolSet,
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

/** Mirrors the `conversation_status` PG enum. */
export type ConversationStatus = "active" | "errored";

/** Voice mode preference. Mirrors the `voice_mode` pgEnum exactly. */
export type VoiceMode = "auto" | "always" | "never";

/** Mirrors the `pending_memory_source` PG enum. */
export type PendingMemorySource = "live_retain" | "migration";

/**
 * A memory write awaiting Observer classification before retention to
 * Hindsight. `profileClass` is denormalised onto the row at read time via
 * a JOIN on `profiles` so the drain can stamp the correct
 * `profile_class:<class>` tag without having to look up the profile per
 * row (or worse, per-row group). `null` when either the staging profile
 * was unclassed or the lineage isn't available — pre-feature live
 * retains, migration backfill, or rows whose staging profile was deleted
 * (`profile_id` SET NULL).
 */
export interface PendingMemory {
  id: string;
  content: string;
  context: string | null;
  source: PendingMemorySource;
  profileClass: string | null;
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
}

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
  if (typeof content === "string") return truncate(content, PREVIEW_MAX_CHARS);
  if (!Array.isArray(content)) return "";
  const block = R.find(content, isTextBlock);
  return block ? truncate(block.text, PREVIEW_MAX_CHARS) : "";
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
        status: ConversationStatus;
        /** Per-conversation voice mode override; null = follow profile default. */
        voiceMode: VoiceMode | null;
      }
    | undefined
  >;

  /**
   * Update a conversation's status. Used by `recover-conversation` to mark
   * a conversation as `errored` after retries on `handle-message` exhausted,
   * and by future `/repair` to flip back to `active`. The orchestrator
   * early-returns with `{ status: "skipped", reason: "errored" }` for any
   * inbound while `errored`, refusing to spend more LLM calls on a
   * known-broken conversation.
   */
  setConversationStatus(
    tx: Transaction,
    conversationId: string,
    status: ConversationStatus,
  ): Promise<void>;

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
        ttsProvider: string;
        ttsModel: string;
        ttsVoice: string;
        ttsBaseUrl: string | null;
        sttProvider: string;
        sttModel: string;
        sttBaseUrl: string | null;
      }
    | undefined
  >;

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

  /** Get the most recent assistant message for a conversation (for cursor chain). */
  getLastAssistantMessage(
    tx: Transaction,
    conversationId: string,
  ): Promise<{ id: string; lastInboundMessageId: string } | undefined>;

  /** Load full message history for a conversation, ordered by id. */
  getHistory(tx: Transaction, conversationId: string): Promise<ReadonlyArray<Message>>;

  /** Load a profile by ID. */
  getProfile(tx: Transaction, profileId: string): Promise<Profile | undefined>;

  /** Get the first user (for bootstrapping). */
  getFirstUser(tx: Transaction): Promise<{ id: string } | undefined>;

  /** Get the first profile (for bootstrapping). */
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
   * Delete a profile atomically: checks `conversations` and `messages` references inside the
   * same transaction and throws `ProfileInUseError` if any exist. Historical messages pin the
   * profile as audit data — a profile that has ever been used in a turn stays undeletable.
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
   * Cap is enforced via a count-then-insert in the same transaction. At
   * single-user scale + UI-only writes, the residual race (concurrent
   * inserts both seeing count=N-1) is acceptable; tighten with a
   * REPEATABLE READ outer tx if multi-tenant adds real concurrency.
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

  /** Load active steering rules for a profile + active channels (ordered by priority). */
  getActiveRules(
    tx: Transaction,
    profileId: string,
    channelTypes: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<{ rule: string }>>;

  /** Get all core memory blocks for a user, ordered by key. */
  getCoreMemoryBlocks(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<{ key: string; content: string }>>;

  /** Upsert a core memory block. Creates if key doesn't exist, updates if it does. */
  upsertCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; key: string; content: string },
  ): Promise<void>;

  /** Get the timestamp of the most recent message in a conversation (any role). `undefined` when no messages. */
  getLastMessageTime(tx: Transaction, conversationId: string): Promise<Date | undefined>;

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
      type: string;
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
        type: string;
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
      type: string;
    }>
  >;

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

  /** Resolve the best provider for a model (lowest position). */
  resolveProviderForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    | {
        id: string;
        name: string;
        type: string;
        baseUrl: string | null;
        secretId: string;
        attrs: ProviderAttrs;
        contextWindow: number | null;
        maxOutputTokens: number | null;
      }
    | undefined
  >;

  /**
   * List every provider registered for a model, ordered by position ASC
   * (primary first, then fallbacks). Empty array when no provider is
   * registered for the model.
   */
  listProvidersForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: string;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
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

  // --- Evolution: correction extraction ---

  /** Check if any channel-specific rules exist for a given channel type. */
  hasChannelRules(tx: Transaction, channelType: string): Promise<boolean>;

  /** Insert a manual steering rule (already active). Used by seed/setup. */
  insertManualRule(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      profileId?: string | null;
      channelType?: string | null;
      priority: number;
    },
  ): Promise<{ id: string }>;

  /** Get all correction-sourced rules (active + inactive) for dedup during extraction. */
  getCorrections(
    tx: Transaction,
    profileId: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      rule: string;
      category: string;
      active: boolean;
      observationCount: number;
      channelType: string | null;
    }>
  >;

  /** Insert a new correction or increment an existing one. Promotes to active when observationCount reaches 2. */
  upsertCorrection(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      profileId: string | null;
      channelType?: string | null;
      existingRuleId?: string;
    },
  ): Promise<{ id: string; promoted: boolean }>;

  /** Count active steering rules for a profile (global + profile-specific). */
  countActiveRules(tx: Transaction, profileId: string): Promise<number>;

  /** Atomically replace a set of old rules with a single consolidated rule. */
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

  // --- Pending memories (staging for Observer classification) ---

  /**
   * Insert a single row into the staging table. Returns the new row id.
   *
   * `profileId` snapshots which profile staged the row so the Observer
   * drain stamps the correct `profile_class:<class>` tag at retain
   * time. Pass `null` for non-conversational stages (the migration
   * backfill loop) where there's no staging profile.
   */
  stagePendingMemory(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string | null;
      content: string;
      context?: string;
      source: PendingMemorySource;
    },
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
      source: PendingMemorySource;
    }>,
  ): Promise<void>;

  /**
   * Read pending rows for a user, oldest first (FIFO drain order).
   *
   * `limit` caps the result size — callers running inside an Inngest step
   * pass a bounded value so the row payload never exceeds the run-state
   * size limit. Omit to read every pending row (tests, ad-hoc tooling).
   */
  getPendingMemories(
    tx: Transaction,
    userId: string,
    limit?: number,
  ): Promise<ReadonlyArray<PendingMemory>>;

  /** Delete pending rows by id. Used by the Observer drain step after successful retain. */
  deletePendingMemories(tx: Transaction, ids: ReadonlyArray<string>): Promise<void>;
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
        status: ConversationStatus;
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
        status: conversations.status,
        voiceMode: conversations.voiceMode,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return rows[0];
  }

  async setConversationStatus(
    tx: Transaction,
    conversationId: string,
    status: ConversationStatus,
  ): Promise<void> {
    await tx.update(conversations).set({ status }).where(eq(conversations.id, conversationId));
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
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
      .orderBy(desc(messages.id))
      .limit(1);
    return rows[0];
  }

  async getHistory(tx: Transaction, conversationId: string): Promise<ReadonlyArray<Message>> {
    const rows = await tx
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.id));
    return rows as ReadonlyArray<Message>;
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
      })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    return rows[0];
  }

  async getFirstUser(tx: Transaction): Promise<{ id: string } | undefined> {
    const rows = await tx.select({ id: users.id }).from(users).limit(1);
    return rows[0];
  }

  async getDefaultProfile(tx: Transaction): Promise<{ id: string } | undefined> {
    const rows = await tx.select({ id: profiles.id }).from(profiles).limit(1);
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
        }),
      );
      return row as Profile;
    });
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
    const [convRows, msgRows] = await Promise.all([
      tx
        .select({ value: count() })
        .from(conversations)
        .where(eq(conversations.profileId, profileId)),
      tx.select({ value: count() }).from(messages).where(eq(messages.profileId, profileId)),
    ]);
    const convCount = convRows[0]?.value ?? 0;
    const msgCount = msgRows[0]?.value ?? 0;
    if (convCount > 0 || msgCount > 0) {
      throw new ProfileInUseError(convCount, msgCount);
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
    return translateForeignKeyViolation(
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
    await translateForeignKeyViolation(
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

  async getActiveRules(
    tx: Transaction,
    profileId: string,
    channelTypes: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<{ rule: string }>> {
    return tx
      .select({ rule: steeringRules.rule })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, true),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
          or(
            isNull(steeringRules.channelType),
            ...(channelTypes.length > 0 ? [inArray(steeringRules.channelType, channelTypes)] : []),
          ),
        ),
      )
      .orderBy(asc(steeringRules.priority));
  }

  async getCoreMemoryBlocks(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<{ key: string; content: string }>> {
    return tx
      .select({ key: coreMemoryBlocks.key, content: coreMemoryBlocks.content })
      .from(coreMemoryBlocks)
      .where(eq(coreMemoryBlocks.userId, userId))
      .orderBy(asc(coreMemoryBlocks.key));
  }

  async upsertCoreMemoryBlock(
    tx: Transaction,
    params: {
      userId: string;
      key: string;
      content: string;
    },
  ): Promise<void> {
    await tx
      .insert(coreMemoryBlocks)
      .values(params)
      .onConflictDoUpdate({
        target: [coreMemoryBlocks.userId, coreMemoryBlocks.key],
        set: { content: params.content, updatedAt: new Date() },
      });
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
      type: string;
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
        type: string;
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
      type: string;
    }>
  > {
    return tx
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        type: llmProviders.type,
      })
      .from(llmProviders);
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

  async resolveProviderForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    | {
        id: string;
        name: string;
        type: string;
        baseUrl: string | null;
        secretId: string;
        attrs: ProviderAttrs;
        contextWindow: number | null;
        maxOutputTokens: number | null;
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
        contextWindow: modelProviders.contextWindow,
        maxOutputTokens: modelProviders.maxOutputTokens,
      })
      .from(modelProviders)
      .innerJoin(llmProviders, eq(modelProviders.providerId, llmProviders.id))
      .where(eq(modelProviders.model, model))
      .orderBy(asc(modelProviders.position))
      .limit(1);
    return rows[0];
  }

  async listProvidersForModel(
    tx: Transaction,
    model: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      name: string;
      type: string;
      baseUrl: string | null;
      secretId: string;
      attrs: ProviderAttrs;
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
        contextWindow: modelProviders.contextWindow,
        maxOutputTokens: modelProviders.maxOutputTokens,
      })
      .from(modelProviders)
      .innerJoin(llmProviders, eq(modelProviders.providerId, llmProviders.id))
      .where(eq(modelProviders.model, model))
      .orderBy(asc(modelProviders.position));
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

  async hasChannelRules(tx: Transaction, channelType: string): Promise<boolean> {
    const rows = await tx
      .select({ id: steeringRules.id })
      .from(steeringRules)
      .where(eq(steeringRules.channelType, channelType))
      .limit(1);
    return rows.length > 0;
  }

  async insertManualRule(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      profileId?: string | null;
      channelType?: string | null;
      priority: number;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(steeringRules)
        .values({
          rule: params.rule,
          category: params.category,
          source: "manual",
          active: true,
          priority: params.priority,
          observationCount: 0,
          profileId: params.profileId ?? null,
          channelType: params.channelType ?? null,
        })
        .returning({ id: steeringRules.id }),
    );
  }

  // --- Evolution: correction extraction ---

  async getCorrections(
    tx: Transaction,
    profileId: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      rule: string;
      category: string;
      active: boolean;
      observationCount: number;
      channelType: string | null;
    }>
  > {
    return tx
      .select({
        id: steeringRules.id,
        rule: steeringRules.rule,
        category: steeringRules.category,
        active: steeringRules.active,
        observationCount: steeringRules.observationCount,
        channelType: steeringRules.channelType,
      })
      .from(steeringRules)
      .where(
        and(
          inArray(steeringRules.source, ["correction", "evolution"]),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
        ),
      )
      .orderBy(asc(steeringRules.priority));
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
  ): Promise<{ id: string; promoted: boolean }> {
    if (params.existingRuleId) {
      const rows = await tx
        .update(steeringRules)
        .set({
          observationCount: sql`${steeringRules.observationCount} + 1`,
          active: sql`CASE WHEN ${steeringRules.observationCount} + 1 >= 2 THEN true ELSE ${steeringRules.active} END`,
        })
        .where(eq(steeringRules.id, params.existingRuleId))
        .returning({
          id: steeringRules.id,
          active: steeringRules.active,
          observationCount: steeringRules.observationCount,
        });
      const row = rows[0];
      if (!row) throw new Error(`upsertCorrection: rule not found: ${params.existingRuleId}`);
      return { id: row.id, promoted: row.observationCount === 2 && row.active };
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

  async countActiveRules(tx: Transaction, profileId: string): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, true),
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
    await tx.delete(steeringRules).where(inArray(steeringRules.id, params.oldIds));
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

  async stagePendingMemory(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string | null;
      content: string;
      context?: string;
      source: PendingMemorySource;
    },
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
      source: PendingMemorySource;
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

  async getPendingMemories(
    tx: Transaction,
    userId: string,
    limit?: number,
  ): Promise<ReadonlyArray<PendingMemory>> {
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
        profileClass: profiles.profileClass,
        createdAt: pendingMemories.createdAt,
      })
      .from(pendingMemories)
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
      .where(eq(pendingMemories.userId, userId))
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
}
