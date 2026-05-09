import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { jsonbZod, pk, ts } from "../../db/helpers.js";
import { MessageContentSchema } from "../../llm/types.js";
import { secrets } from "../../secrets/store/schema.js";
import {
  MemoryCompartmentSchema,
  MemoryTrustSchema,
} from "../evolution/memory-extraction-schema.js";

// --- Enums ---

export const autoRecallMode = pgEnum("auto_recall_mode", ["off", "always", "heuristic", "llm"]);

export const pendingMemorySource = pgEnum("pending_memory_source", ["live_retain", "migration"]);

/**
 * Voice mode preference. `auto` mirrors inbound modality (voice in → voice out).
 * Lives on profiles (default) and conversations (override, nullable). See
 * design/voice.md.
 */
export const voiceMode = pgEnum("voice_mode", ["auto", "always", "never"]);

/**
 * Lifecycle status of a conversation.
 *
 * `active` — normal; `handle-message` processes inbound. Default for new rows.
 * `errored` — `recover-conversation` marked the conversation irrecoverable
 *   after retries on `handle-message` exhausted (or it failed
 *   non-retriably). `handle-message` early-returns with
 *   `{ status: "skipped", reason: "errored" }` for any inbound while in
 *   this state, refusing to spend more LLM calls on a known-broken
 *   conversation. Cleared back to `active` by future `/repair` (P3) or
 *   manually via psql.
 */
export const conversationStatus = pgEnum("conversation_status", ["active", "errored"]);

// --- JSONB shapes ---

/**
 * `llm_providers.attrs` — adapter-specific knobs. `promptCaching` enables
 * Anthropic-style cache_control hints for OpenRouter routing; `headers` sets
 * extra default headers on the OpenAI SDK client (e.g. `HTTP-Referer` for
 * OpenRouter usage attribution).
 */
export const ProviderAttrsSchema = z.object({
  promptCaching: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type ProviderAttrs = z.infer<typeof ProviderAttrsSchema>;

/**
 * `profiles.tool_set` — list of tool names enabled for this profile. Empty
 * array = no tools (chat-only profile). Tool names are matched against the
 * registered tool registry at request time; unknown names are silently
 * dropped (logged) rather than rejected, so deleting a tool doesn't brick
 * existing profiles.
 */
export const ToolSetSchema = z.array(z.string());
export type ToolSet = z.infer<typeof ToolSetSchema>;

/**
 * `profiles.memory_scope` — declares which compartment + trust + profile-class
 * tag combinations a profile is allowed to recall from Hindsight. Null = no
 * restriction (legacy default; all memories visible). When set, `compartments`
 * and `trust` must be non-empty — a profile that allows zero of either can
 * recall nothing, which is almost certainly a configuration mistake.
 * `profileClasses` is independent: if present and non-empty, only memories
 * tagged with one of the listed classes are recallable (speaker-driven
 * isolation); if omitted, recall is unrestricted on the class dimension. The
 * orchestrator folds these into a `tag_groups` filter at recall/reflect time
 * so that only memories matching
 * `compartment ∈ allowed AND trust ∈ allowed [AND profile_class ∈ allowed]`
 * are returned.
 */
export const ProfileMemoryScopeSchema = z.object({
  compartments: z.array(MemoryCompartmentSchema).min(1),
  trust: z.array(MemoryTrustSchema).min(1),
  profileClasses: z.array(z.string().min(1)).min(1).optional(),
});
export type ProfileMemoryScope = z.infer<typeof ProfileMemoryScopeSchema>;

// --- Tables ---

export const users = pgTable("users", {
  id: pk(),
  createdAt: ts(),
});

export const llmProviders = pgTable("llm_providers", {
  id: pk(),
  name: text("name").notNull().unique(),
  type: text("type").notNull(), // 'anthropic' | 'openai_compatible'
  baseUrl: text("base_url"), // NULL = SDK default endpoint
  secretId: uuid("secret_id")
    .notNull()
    .references(() => secrets.id),
  attrs: jsonbZod("attrs", ProviderAttrsSchema).notNull(),
  createdAt: ts(),
});

/** For a given model, which providers can serve it and in what order. */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: pk(),
    model: text("model").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => llmProviders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(), // 0 = primary, 1 = first fallback, ...
    userSelectable: boolean("user_selectable").notNull(), // false = internal-only (hidden from /model picker)
    createdAt: ts(),
  },
  (t) => [
    unique("uq_model_provider").on(t.model, t.providerId),
    unique("uq_model_position").on(t.model, t.position),
  ],
);

/**
 * Per-user registry of named "custom compartments" — extensions of the
 * curated `MemoryCompartmentSchema` enum. The classifier loads these per
 * Observer fire and templates `description` into the prompt alongside the
 * core `personal/work/health/financial/technical/misc` definitions, then
 * emits `compartment:<name>` tags at retain time. `description` is **not**
 * documentation here — the LLM reads it. Use a 1–2 sentence definition that
 * tells the classifier when to pick this bucket.
 *
 * Forward-only: deleting a row drops the option from future classifications
 * but leaves existing `compartment:<name>` Hindsight tags untouched. Profile
 * scopes that include the deleted compartment continue to recall those
 * historical memories until the operator clears them (manual SQL on
 * Hindsight, or rename via re-create + Hindsight reclassification).
 */
export const customCompartments = pgTable(
  "custom_compartments",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_custom_compartments_user_name").on(t.userId, t.name)],
);

/**
 * Per-user registry of named "profile classes" — labels emitted as
 * `profile_class:<name>` tags by the Observer at retain time, then matched
 * against `profiles.memory_scope.profileClasses` at recall time. Speaker-
 * driven isolation: any number of profiles can share a class, classes
 * outlive the profiles that reference them (so memory tags don't dangle
 * when a profile is deleted and recreated). `description` is human-facing
 * documentation only — the LLM classifier never reads it.
 */
export const profileClasses = pgTable(
  "profile_classes",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_profile_classes_user_name").on(t.userId, t.name)],
);

export const profiles = pgTable(
  "profiles",
  {
    id: pk(),
    userId: uuid("user_id").references(() => users.id), // NULL = org profile (read-only via Transport); set = user profile
    name: text("name").notNull(),
    basePrompt: text("base_prompt").notNull(),
    model: text("model").notNull(),
    summarizationModel: text("summarization_model"), // null = use main model
    extractionModel: text("extraction_model"), // null = use main model
    autoRecall: autoRecallMode("auto_recall").notNull().default("heuristic"),
    /**
     * Profile-level voice mode default. Overridden per-conversation via
     * `conversations.voice_mode` (nullable). Default `auto` = mirror inbound
     * modality. See design/voice.md.
     */
    voiceMode: voiceMode("voice_mode").notNull().default("auto"),
    toolSet: jsonbZod("tool_set", ToolSetSchema).notNull(),
    memoryScope: jsonbZod("memory_scope", ProfileMemoryScopeSchema), // null = no restriction
    /**
     * Profile class — speaker-isolation label. NULL = unclassed (Observer
     * emits no `profile_class:*` tag for this profile's conversations).
     * Validated against `profile_classes` for the profile's user via the
     * composite FK below; org profiles (`user_id IS NULL`) bypass the FK
     * check (MATCH SIMPLE) and so are rejected at the store boundary
     * (`setProfileClass`) instead.
     */
    profileClass: text("profile_class"),
    createdAt: ts(),
  },
  (t) => [
    unique("uq_profiles_user_name").on(t.userId, t.name).nullsNotDistinct(),
    /**
     * Composite FK enforcing that any non-null `(user_id, profile_class)`
     * pair on a profile references an existing row in `profile_classes`.
     * `ON DELETE RESTRICT`: deleting a class while any profile still
     * references it fails atomically at the DB layer. Replaces the
     * earlier check-then-write pattern in the store, which raced under
     * concurrent setProfileClass / deleteProfileClass. MATCH SIMPLE
     * (the default): when either column is NULL the constraint is not
     * checked, so org profiles (user_id IS NULL) bypass it — that gap
     * is closed at the store boundary.
     */
    foreignKey({
      columns: [t.userId, t.profileClass],
      foreignColumns: [profileClasses.userId, profileClasses.name],
      name: "fk_profiles_profile_class",
    }).onDelete("restrict"),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    isPrivate: boolean("is_private").notNull(),
    /**
     * `active` (default) — normal processing; `errored` — `recover-conversation`
     * marked the conversation as irrecoverable after `handle-message` exhausted
     * retries (or failed non-retriably). The orchestrator refuses to spend
     * more LLM calls until status flips back to `active`. See
     * `conversationStatus` enum and `recover-conversation`.
     */
    status: conversationStatus("status").notNull().default("active"),
    /**
     * Per-conversation voice mode override. NULL = follow profile default.
     * The conversation override is what `/voice` mutates; clearing it
     * (`/voice clear`) restores profile-level behaviour.
     */
    voiceMode: voiceMode("voice_mode"),
    createdAt: ts(),
  },
  (t) => [index("idx_conversations_profile_id").on(t.profileId)],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: jsonbZod("content", MessageContentSchema).notNull(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id), // profile active for the turn this row belongs to
    model: text("model").notNull(), // model active for the turn; legacy backfill = '<legacy>' sentinel
    lastInboundMessageId: uuid("last_inbound_message_id").notNull(),
    inputTokens: integer("input_tokens"), // nullable — only set on assistant messages
    // NOT NULL, no default — callers must pass explicitly for assistant rows
    // (via `lastMessageOutputTokens`). Backfilled to -1 for pre-migration rows
    // and used as a sentinel on non-assistant rows where output is N/A; the
    // fast path (`shouldSkipCounting`) treats -1 as "unknown → force count".
    outputTokens: integer("output_tokens").notNull(),
    createdAt: ts(),
  },
  (t) => [
    index("idx_messages_conv_id").on(t.conversationId, t.id),
    index("idx_messages_profile_id").on(t.profileId),
  ],
);

export const aliases = pgTable(
  "aliases",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id)
      .unique(),
    alias: text("alias").notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_aliases_user_alias").on(t.userId, t.alias)],
);

export const coreMemoryBlocks = pgTable(
  "core_memory_blocks",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(), // 'user_profile', 'active_projects', etc.
    content: text("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: ts(),
  },
  (t) => [unique("uq_core_memory_user_key").on(t.userId, t.key)],
);

/**
 * Memory writes awaiting Observer classification before retention to
 * Hindsight. User-scoped (not conversation-scoped) so /reset doesn't
 * destroy pending rows; drain on any subsequent conversation/idle.
 *
 * `profile_id` snapshots the profile that staged the row so the drain
 * can stamp the correct `profile_class:<class>` tag at retain time —
 * without it, a row staged by profile A but drained by an idle on a
 * profile B conversation would be tagged with B's class and leak across
 * the speaker-isolation boundary. Nullable because migration-sourced
 * rows (`source: "migration"`) and any pre-existing live retains have
 * no staging-time profile lineage. `ON DELETE SET NULL` so deleting a
 * profile doesn't cascade-destroy the user's pending writes — the row
 * just loses its class lineage and drains untagged on that dimension.
 */
export const pendingMemories = pgTable(
  "pending_memories",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    profileId: uuid("profile_id").references(() => profiles.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    context: text("context"),
    source: pendingMemorySource("source").notNull(),
    createdAt: ts(),
  },
  (t) => [index("idx_pending_memories_user").on(t.userId, t.createdAt)],
);

/**
 * Voice provider configuration — singleton row by convention (zero or one).
 * Credentials live in the encrypted `secrets` table (no env-only path); the
 * FKs decouple TTS from STT so swapping providers is a single secret-id
 * update, not a wholesale rewire. Slice 1 supports `tts_provider = 'openai'`
 * and `stt_provider = 'openai'`; ElevenLabs / Deepgram pluggable later.
 * See design/voice.md.
 */
export const voiceConfig = pgTable(
  "voice_config",
  {
    id: pk(),
    ttsSecretId: uuid("tts_secret_id")
      .notNull()
      .references(() => secrets.id),
    sttSecretId: uuid("stt_secret_id")
      .notNull()
      .references(() => secrets.id),
    ttsProvider: text("tts_provider").notNull(),
    ttsModel: text("tts_model").notNull(),
    ttsVoice: text("tts_voice").notNull(),
    ttsBaseUrl: text("tts_base_url"), // NULL = SDK default
    sttProvider: text("stt_provider").notNull(),
    sttModel: text("stt_model").notNull(),
    sttBaseUrl: text("stt_base_url"), // NULL = SDK default
    /**
     * Singleton enforcement — `singleton` is always TRUE (the CHECK
     * constraint pins the value); UNIQUE on a single-valued column means
     * at most one row can exist. Inserting a second row violates the
     * UNIQUE constraint at the DB level rather than relying on
     * convention. `getVoiceConfig` also `ORDER BY created_at DESC` as
     * defense-in-depth in case the constraint is somehow bypassed
     * (manual psql, broken migration).
     */
    singleton: boolean("singleton").notNull().default(true),
    createdAt: ts(),
  },
  (t) => [
    unique("uq_voice_config_singleton").on(t.singleton),
    check("chk_voice_config_singleton", sql`singleton = true`),
  ],
);

export const steeringRules = pgTable("steering_rules", {
  id: pk(),
  rule: text("rule").notNull(),
  category: text("category").notNull(), // 'safety' | 'style' | 'domain' | 'memory'
  active: boolean("active").notNull(),
  source: text("source").notNull(), // 'manual' | 'correction' | 'signal_pipeline' | 'evolution'
  priority: integer("priority").notNull(),
  observationCount: integer("observation_count").notNull(),
  profileId: uuid("profile_id").references(() => profiles.id), // NULL = applies to all profiles
  channelType: text("channel_type"), // NULL = applies to all channels
  createdAt: ts(),
});
