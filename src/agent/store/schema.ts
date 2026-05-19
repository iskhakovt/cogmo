import { desc, sql } from "drizzle-orm";
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
import { EvolutionEventPayloadSchema } from "../evolution/event-schema.js";
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
 * Per-profile auto-approve mode for coding-delegation permission prompts.
 * `off` (default) preserves the policy gate's Telegram round trip for
 * prompt-worthy operations (`git push`, `gh pr/issue` mutations, publishes,
 * external HTTP writes). `on` short-circuits the prompt path to allow —
 * useful for trusted profiles where the user accepts the cost of unattended
 * mutations in exchange for not interrupting a delegated task. The static
 * `policy.deny` set still denies; only the `prompt` decision flips to allow.
 */
export const codingAutoapproveMode = pgEnum("coding_autoapprove_mode", ["off", "on"]);

/**
 * Zod schema for `conversations.cooldown_state`. The column's column
 * comment carries the lifecycle and atomicity contract; see also
 * `design/agent-resilience.md` → Auto-repair.
 */
export const CooldownStateSchema = z.object({
  lastErroredAt: z.string().datetime({ offset: true }),
  cooldownSeconds: z.number().int().positive(),
  consecutiveFailures: z.number().int().positive(),
});
export type CooldownState = z.infer<typeof CooldownStateSchema>;

/**
 * LLM provider adapter discriminator. Maps to which `LlmProvider` class is
 * constructed in `buildProvider` (`src/llm/resolver.ts`). Adding a new value
 * is always a code change (new adapter constructor) AND a migration anyway,
 * so the enum cost equals the prior text-column cost while gaining
 * exhaustive `switch` checking.
 */
export const llmProviderType = pgEnum("llm_provider_type", ["anthropic", "openai_compatible"]);
export type LlmProviderTypeValue = (typeof llmProviderType.enumValues)[number];

/**
 * Image provider adapter discriminator. `fal` uses `@ai-sdk/fal` (no base
 * URL), `openai_compatible` uses `@ai-sdk/openai-compatible` against
 * `${base_url}/images/generations`, `venice` uses a hand-rolled adapter
 * against Venice.ai's native `/image/generate` endpoint (Venice's
 * OpenAI-compat path strict-rejects its own bespoke knobs like
 * `safe_mode` / `negative_prompt`). See `design/image-generation.md` →
 * Providers.
 */
export const imageProviderType = pgEnum("image_provider_type", [
  "fal",
  "openai_compatible",
  "venice",
]);
export type ImageProviderTypeValue = (typeof imageProviderType.enumValues)[number];

/**
 * `scheduled_tasks.kind` — recurrence discriminator. `recurring` rows carry a
 * non-null `cron` and re-advance `next_run_at` on every fire. `one_off` rows
 * carry `cron IS NULL` and flip `enabled = false` after firing (no second
 * fire). One-offs ≤1y typically skip the table entirely via
 * `inngest.send({ ts })`; this kind is for >1y delays or one-shots the agent
 * wants to inspect/cancel before they fire. See design/scheduling.md.
 */
export const scheduleKind = pgEnum("schedule_kind", ["recurring", "one_off"]);
export type ScheduleKindValue = (typeof scheduleKind.enumValues)[number];

/**
 * `scheduled_tasks.source` — authorship of the row. `agent` = an LLM tool
 * call (`schedule_task`); `wizard` = setup wizard's recurring-tasks step;
 * `manual` = direct psql / admin CLI insert. Used for audit, rate limits
 * per source, and UI grouping in `/schedules`.
 */
export const scheduleSource = pgEnum("schedule_source", ["agent", "wizard", "manual"]);
export type ScheduleSourceValue = (typeof scheduleSource.enumValues)[number];

/**
 * `evolution_events.triggered_by` — discriminates the autonomous idle fire
 * from a `/reflect`-driven manual run. Used by `/learned` to surface the
 * source in the digest and detail views.
 */
export const evolutionTrigger = pgEnum("evolution_trigger", ["idle", "manual"]);
export type EvolutionTriggerValue = (typeof evolutionTrigger.enumValues)[number];

/**
 * TTS provider adapter discriminator. Maps to which `TtsProvider` class the
 * voice resolver builds (`src/voice/resolver.ts`). `openai` and
 * `openai_compatible` both use `OpenAIVoiceProvider`; the enum split keeps
 * the operator's intent visible (and lets the wizard prompt for a baseURL on
 * `openai_compatible` only). `elevenlabs` builds `ElevenLabsTtsProvider`.
 */
export const ttsProviderType = pgEnum("tts_provider_type", [
  "openai",
  "openai_compatible",
  "elevenlabs",
]);
export type TtsProviderTypeValue = (typeof ttsProviderType.enumValues)[number];

/**
 * STT provider adapter discriminator. ElevenLabs is intentionally absent —
 * only TTS routes through ElevenLabs in this slice; STT stays on OpenAI's
 * `/v1/audio/transcriptions` (or any compatible provider that serves the
 * same endpoint, e.g. Groq).
 */
export const sttProviderType = pgEnum("stt_provider_type", ["openai", "openai_compatible"]);
export type SttProviderTypeValue = (typeof sttProviderType.enumValues)[number];

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

/**
 * Provider-level image-generation defaults. Adapter-specific knobs the
 * operator pins for every call (the LLM never sees or chooses these).
 * Today shaped by Venice's native API but the field name is provider-neutral
 * so future providers can layer their own defaults under the same key without
 * another migration.
 *
 * - `safe_mode`: Venice defaults to `true` (blurs flagged content); set
 *   `false` to disable blur. When `safe_mode` is false the adapter throws on
 *   `x-venice-is-blurred: true` — an unwanted blur is a failed generation,
 *   not a delivery target.
 * - `cfg_scale`: classifier-free guidance strength (Venice). Lower = looser
 *   adherence to the prompt; higher = tighter. Venice's documented range is
 *   0–20.
 * - `hide_watermark`: strip the Venice watermark when supported.
 * - `style_preset`: Venice style preset name (e.g. `"3D Model"`,
 *   `"Anime"`). Free-form because the upstream list evolves.
 *
 * **Forward shape decision.** The current schema is flat — every field
 * sits at the top level. That's correct for one provider with a clean
 * keyspace. When a second provider's defaults land (Replicate, OpenAI
 * gpt-image-*, Together image, etc.), two options open up:
 *   (a) Stay flat. Works if the new fields don't collide with venice's.
 *       Risk: a future provider's `cfg_scale` with different semantics
 *       or range — same name, different meaning — would corrupt rows
 *       silently on swap or be unenforceable at the schema layer.
 *   (b) Namespace: `{ venice?: {...}, replicate?: {...} }`. Buys
 *       isolation at the cost of one extra level of indirection in
 *       every adapter that reads its slice. Adapters become "look up
 *       my namespace" rather than "spread my fields."
 * Pick (b) the moment any name collision is plausible or a second
 * provider adds three or more knobs. Pick (a) if the second provider
 * adds one or two with names obviously distinct from venice's.
 */
export const ImageGenerationDefaultsSchema = z.object({
  safe_mode: z.boolean().optional(),
  cfg_scale: z.number().min(0).max(20).optional(),
  hide_watermark: z.boolean().optional(),
  style_preset: z.string().optional(),
});
export type ImageGenerationDefaults = z.infer<typeof ImageGenerationDefaultsSchema>;

/**
 * `image_providers.attrs` — adapter-specific knobs. `headers` sets extra
 * default headers on the OpenAI-compatible SDK client (e.g. for tenant
 * routing or usage attribution). `imageGenerationDefaults` carries the
 * provider-level call defaults the operator wants pinned (see
 * `ImageGenerationDefaultsSchema`). Fal has no documented use today.
 */
export const ImageProviderAttrsSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  imageGenerationDefaults: ImageGenerationDefaultsSchema.optional(),
});
export type ImageProviderAttrs = z.infer<typeof ImageProviderAttrsSchema>;

/**
 * `image_models.capabilities` — per-model knob bag. Read by the LLM (via the
 * tool description) and by the tool handler (to validate the LLM's pick).
 *
 * `aspectRatios` — ratios the LLM may pick for this model. Absent or empty
 *   array → the model accepts no custom aspect ratio (fixed-size models like
 *   recraft-v3 character/embedding variants). Both states are treated
 *   identically by the handler: if the LLM still passes `aspectRatio`, the
 *   handler returns a text error the LLM can recover from (re-pick a ratio
 *   or a different model) rather than dropping it silently.
 * `seed` — whether `seed` is honored. Absent treated as false; advertised in
 *   the tool description so the LLM doesn't ask for reproducibility from a
 *   non-deterministic model. Handler silently drops `seed` for models that
 *   don't honor it (lower stakes than a bad ratio — the image still renders).
 * `imageInput` — declares whether the model accepts a reference image (image-
 *   to-image / kontext-style editing). `"required"` means the model only
 *   works with a reference (e.g. `fal/flux-kontext`); the handler returns a
 *   text error if the LLM picks the model without supplying `referenceImage`.
 *   `"optional"` means the model accepts an image but doesn't require one.
 *   Absent → the model is text-only; passing `referenceImage` is rejected.
 *   Today only honored by `kind: "fal"` providers (via the AI SDK's
 *   `prompt: { text, images }` shape); openai-compatible providers reject
 *   image input at the handler boundary until a validated path lands.
 * `negativePrompt` — declares whether the model accepts a free-form
 *   negative prompt ("don't draw X"). True opts in to the per-call
 *   `negativePrompt` field in the tool input; absent or false → the field
 *   is dropped before the provider call, preventing accidental forwarding
 *   to providers that strict-reject the parameter. Today honored by fal
 *   (via `providerOptions.fal.negative_prompt`) and venice (native body
 *   field); openai-compatible models typically don't accept it.
 *
 * Forward-extensible: add `maxPromptLength`, `outputMediaType`, etc.
 * without a migration as new providers land.
 */
/**
 * Canonical aspect-ratio vocabulary. Shared between the schema (for the
 * stored JSONB shape) and the wizard / CLI input parsers (for operator-typed
 * validation) so adding a new ratio is a single-source change.
 */
export const IMAGE_ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
  "9:21",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ALLOWED_ASPECT_RATIOS)[number];

export const ImageModelCapabilitiesSchema = z.object({
  aspectRatios: z.array(z.enum(IMAGE_ALLOWED_ASPECT_RATIOS)).optional(),
  seed: z.boolean().optional(),
  imageInput: z.enum(["required", "optional"]).optional(),
  negativePrompt: z.boolean().optional(),
});
export type ImageModelCapabilities = z.infer<typeof ImageModelCapabilitiesSchema>;

// --- Tables ---

export const users = pgTable("users", {
  id: pk(),
  createdAt: ts(),
});

export const llmProviders = pgTable("llm_providers", {
  id: pk(),
  name: text("name").notNull().unique(),
  type: llmProviderType("type").notNull(),
  baseUrl: text("base_url"), // NULL = SDK default endpoint
  secretId: uuid("secret_id")
    .notNull()
    .references(() => secrets.id),
  attrs: jsonbZod("attrs", ProviderAttrsSchema).notNull(),
  createdAt: ts(),
});

/**
 * For a given model, which providers can serve it and in what order.
 *
 * `contextWindow` / `maxOutputTokens` are nullable user-set overrides. The
 * resolver layers them: row override → bundled LiteLLM JSON snapshot →
 * conservative default. Operators only need to set them when LiteLLM doesn't
 * know the model id and the conservative default (128k/4k) is too small.
 */
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
    contextWindow: integer("context_window"), // null → resolver falls back
    maxOutputTokens: integer("max_output_tokens"), // null → resolver falls back
    createdAt: ts(),
  },
  (t) => [
    unique("uq_model_provider").on(t.model, t.providerId),
    unique("uq_model_position").on(t.model, t.position),
  ],
);

/**
 * Provider rows for image generation. `type` discriminates the adapter:
 * `fal` uses `@ai-sdk/fal` (no base URL), `openai_compatible` uses
 * `@ai-sdk/openai-compatible` against `${base_url}/images/generations`.
 *
 * The CHECK constraint pins the base_url invariant at the DB layer
 * (`fal ↔ NULL`, `openai_compatible ↔ NOT NULL`). The store layer adds URL
 * hygiene (https, no trailing slash) on top with a typed
 * `InvalidProviderConfigError`.
 *
 * No fallback chain — unlike `llm_providers` + `model_providers`, image
 * generation has no transparent cross-provider retry. A failed image gen
 * surfaces directly to the LLM via the tool result.
 *
 * **Extending `image_provider_type`:** the CHECK below is written as
 * per-value implications, not a closed disjunction. A new enum value (say
 * `replicate`) is unconstrained by default — it can land with or without
 * `base_url`. If the new type needs its own base_url rule, add another
 * implication clause in the same migration that adds the enum value.
 * The closed-disjunction form (`(type = 'fal' AND ...) OR (type = 'oai' AND ...)`)
 * rejects every row of a newly-added type until the constraint is
 * rewritten — surprising failure mode we deliberately avoid.
 */
export const imageProviders = pgTable(
  "image_providers",
  {
    id: pk(),
    name: text("name").notNull().unique(),
    type: imageProviderType("type").notNull(),
    baseUrl: text("base_url"), // NULL for fal, NOT NULL for openai_compatible / venice (CHECK enforced)
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id),
    attrs: jsonbZod("attrs", ImageProviderAttrsSchema).notNull(),
    createdAt: ts(),
  },
  (t) => [
    check(
      "chk_image_providers_base_url",
      // Per-value implications: each clause means "if type = X then base_url
      // satisfies Y." A type not mentioned here passes both clauses by
      // vacuous truth — see the docstring for why this matters when
      // extending the enum.
      sql`(${t.type} <> 'openai_compatible' OR ${t.baseUrl} IS NOT NULL)
        AND (${t.type} <> 'venice' OR ${t.baseUrl} IS NOT NULL)
        AND (${t.type} <> 'fal' OR ${t.baseUrl} IS NULL)`,
    ),
  ],
);

/**
 * Catalog of image models the LLM can pick from. `name` is the LLM-facing
 * key (globally unique, round-trips via the tool's `model` arg) — convention
 * is `<provider-name>/<slug>` e.g. `fal/flux-dev`, `venice/flux-uncensored`.
 * `model_string` is the API-facing identifier passed to
 * `provider.image(...)` / `provider.imageModel(...)`. `description` is read
 * by the LLM at every turn — write a one-line "use when..." hint, same
 * voice as the legacy `MODEL_CATALOG` blurbs. `capabilities` declares the
 * per-model knobs (see schema). `user_selectable` is the catalog-visibility
 * gate: false keeps the row in `image_models` but omits it from the
 * `generate_image` tool's `model` enum and per-model description block.
 * Image gen has no end-user model picker (unlike `model_providers.user_selectable`
 * which gates `/model`), so the only consumer this hides the row from is
 * the LLM itself. Use for deprecation and experimental models the operator
 * wants to stage without exposing.
 */
export const imageModels = pgTable("image_models", {
  id: pk(),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => imageProviders.id, { onDelete: "cascade" }),
  name: text("name").notNull().unique(),
  modelString: text("model_string").notNull(),
  description: text("description").notNull(),
  capabilities: jsonbZod("capabilities", ImageModelCapabilitiesSchema).notNull(),
  userSelectable: boolean("user_selectable").notNull(),
  createdAt: ts(),
});

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
 *
 * `restricted` flips recall to fail-closed for this class: memories tagged
 * with a restricted class are invisible to any profile whose
 * `memory_scope.profileClasses` doesn't explicitly include the class (and
 * which doesn't speak as the class itself). Default `false` preserves
 * today's open-by-default behaviour for unmarked classes.
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
    restricted: boolean("restricted").notNull().default(false),
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
    /**
     * Per-profile streaming presentation knobs honored by `StreamingAdapter`s
     * (today: Telegram only). `streamChunkChars` is the soft cap on a single
     * message's source length before the handle rotates to a fresh message —
     * lower it for a "burst of short messages" UX, leave at the default for
     * the long-edit UX. `streamEdits` toggles mid-message edits: when
     * `false`, the handle never edits — it only emits whole chunks on
     * boundary / finish, drops tool/status banners (they're a streaming-edit
     * affordance), and falls back to a native typing indicator while the
     * stream is in flight. Defaults preserve today's behavior.
     */
    streamChunkChars: integer("stream_chunk_chars").notNull().default(4000),
    streamEdits: boolean("stream_edits").notNull().default(true),
    /**
     * Bypass the Telegram permission round trip during coding-delegation
     * tool gating. See `codingAutoapproveMode` enum docstring for the
     * trade-off. Toggled via the `/profile autoapprove <name> on|off`
     * Telegram subcommand.
     */
    codingAutoapproveMode: codingAutoapproveMode("coding_autoapprove_mode")
      .notNull()
      .default("off"),
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
    // Bounds: 100 is the practical floor (anything smaller is sub-bubble noise
    // and would split mid-word frequently); 4000 leaves headroom under
    // Telegram's 4096 cap for HTML tag expansion. Defense in depth — the
    // /profile stream parser validates the same range with a friendly error.
    check(
      "chk_profiles_stream_chunk_chars",
      sql`${t.streamChunkChars} >= 100 AND ${t.streamChunkChars} <= 4000`,
    ),
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
     * Conversation-level circuit-breaker state. Set by
     * `recover-conversation` after `handle-message` exhausts retries;
     * cleared on the first successful turn past the cooldown threshold,
     * by `/repair`, or by `/model` / `/profile` switches.
     * `handle-message`'s entry guard reads this column and returns a
     * terse in-cooldown reply (without invoking the LLM) while
     * `now() < lastErroredAt + cooldownSeconds`.
     *
     * Atomic by construction — either `NULL` (CLOSED state) or all
     * three blob fields populated (OPEN state). `consecutiveFailures`
     * is stored rather than derived because `cooldownSeconds` collapses
     * to a constant past the 1h cap and the failure counter is the
     * most useful chronic-failure telemetry signal. See
     * `design/agent-resilience.md` → Auto-repair.
     */
    cooldownState: jsonbZod("cooldown_state", CooldownStateSchema),
    /**
     * Per-conversation voice mode override. NULL = follow profile default.
     * The conversation override is what `/voice` mutates; clearing it
     * (`/voice clear`) restores profile-level behaviour.
     */
    voiceMode: voiceMode("voice_mode"),
    createdAt: ts(),
  },
  (t) => [
    index("idx_conversations_profile_id").on(t.profileId),
    // Covers `findMostRecentConversationForUserProfile`'s filter on
    // (user_id, profile_id) restricted to private conversations,
    // ordered by id DESC. UUIDv7 makes `id DESC` a proxy for
    // created_at DESC, so the index can serve the order as well.
    index("idx_conversations_user_profile_private_id")
      .on(t.userId, t.profileId, desc(t.id))
      .where(sql`is_private = true`),
  ],
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
 * update, not a wholesale rewire. TTS supports `openai`, `openai_compatible`
 * (any provider serving `/v1/audio/speech`, e.g. self-hosted relays), and
 * `elevenlabs`. STT supports `openai` and `openai_compatible` (e.g. Groq,
 * which serves `/v1/audio/transcriptions`). See design/voice.md.
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
    ttsProvider: ttsProviderType("tts_provider").notNull(),
    ttsModel: text("tts_model").notNull(),
    ttsVoice: text("tts_voice").notNull(),
    ttsBaseUrl: text("tts_base_url"), // NULL for openai/elevenlabs (SDK default), NOT NULL for openai_compatible (CHECK enforced)
    sttProvider: sttProviderType("stt_provider").notNull(),
    sttModel: text("stt_model").notNull(),
    sttBaseUrl: text("stt_base_url"), // NULL for openai (SDK default), NOT NULL for openai_compatible (CHECK enforced)
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
    // Per-value implications: each clause is "if provider = X then base_url
    // satisfies Y." Mirrors `chk_image_providers_base_url`. A provider value
    // not mentioned passes by vacuous truth — extend this when adding a new
    // enum value (e.g. an elevenlabs STT in the future) so hand-edited rows
    // can't reach the resolver in an invalid shape.
    check(
      "chk_voice_config_tts_base_url",
      sql`(${t.ttsProvider} <> 'openai_compatible' OR ${t.ttsBaseUrl} IS NOT NULL)
        AND (${t.ttsProvider} = 'openai_compatible' OR ${t.ttsBaseUrl} IS NULL)`,
    ),
    check(
      "chk_voice_config_stt_base_url",
      sql`(${t.sttProvider} <> 'openai_compatible' OR ${t.sttBaseUrl} IS NOT NULL)
        AND (${t.sttProvider} = 'openai_compatible' OR ${t.sttBaseUrl} IS NULL)`,
    ),
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

/**
 * User/agent-defined scheduled tasks. Source of truth for the
 * `schedule_task` / `list_tasks` / `remove_task` agent tools, the setup
 * wizard's recurring-tasks step (morning briefing and friends), and any
 * ingestion polling. The 1-min ticker (`scheduled-task-ticker` Inngest
 * function) reads this table with `FOR UPDATE SKIP LOCKED`, fans out one
 * `agent/scheduled-task.fire` event per due row with idempotency key
 * `${id}:${next_run_at.toISOString()}`, and advances `next_run_at` in the
 * same tx. See design/scheduling.md → Agent Self-Scheduling.
 *
 * `cron` is nullable: required for `kind='recurring'`, must be NULL for
 * `kind='one_off'`. The CHECK below pins this at the DB layer using
 * per-value implications (same shape as `image_providers.base_url`) so a
 * future third kind doesn't have to rewrite the constraint.
 *
 * `timezone` is an IANA tz string (e.g. `Europe/London`) — validated at the
 * tool boundary via `croner` + `Intl.DateTimeFormat`. The schedule fires
 * anchored to that tz, so DST transitions don't drift. `next_run_at` is
 * stored in UTC like every other timestamptz.
 *
 * `catchup_missed` flips the post-outage behaviour: `false` (default at the
 * tool layer) fires once with the most recent `next_run_at` regardless of
 * how many ticks were missed; `true` backfills every missed occurrence.
 * The fire handler reads the scheduled-for timestamp out of the event so
 * the model is self-aware about lateness either way.
 */
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id), // RESTRICT — deleting a profile fails if schedules still reference it
    kind: scheduleKind("kind").notNull(),
    cron: text("cron"), // NULL for kind='one_off', NOT NULL for kind='recurring' (CHECK enforced)
    timezone: text("timezone").notNull(), // IANA tz, validated at tool boundary
    prompt: text("prompt").notNull(), // replayed as user-role message into the agent loop on fire
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }), // null = never fired
    enabled: boolean("enabled").notNull(),
    catchupMissed: boolean("catchup_missed").notNull(),
    source: scheduleSource("source").notNull(),
    createdAt: ts(),
  },
  (t) => [
    // Hot path: ticker `WHERE enabled AND next_run_at <= now() ORDER BY next_run_at`.
    index("idx_scheduled_tasks_due").on(t.enabled, t.nextRunAt),
    // List path: `/schedules` and `list_tasks` filter by user.
    index("idx_scheduled_tasks_user").on(t.userId, t.createdAt),
    check(
      "chk_scheduled_tasks_cron",
      // Per-value implications: each clause says "if kind = X then cron
      // satisfies Y." Adding a third kind is unconstrained until its own
      // clause is added — same convention as `image_providers.base_url`.
      sql`(${t.kind} <> 'recurring' OR ${t.cron} IS NOT NULL) AND (${t.kind} <> 'one_off' OR ${t.cron} IS NULL)`,
    ),
  ],
);

/**
 * Append-only audit log — one row per processed Observer fire. Source of
 * truth for the `/learned` digest and the `/reflect` reply. `skipped` fires
 * (conversation not found, profile not found, too_short) earn no row — there
 * is nothing to surface for those.
 *
 * `user_id` is denormalised from `conversations.user_id`. The `/learned`
 * digest scans by user; conversations is large, and the conversation→user
 * mapping is immutable, so the denormalisation can't drift. `payload` carries
 * the structured ObserverResult and is validated on read+write by
 * `EvolutionEventPayloadSchema`.
 *
 * No `outcome` / `superseded_at` columns yet — undo and per-rule revert are
 * deliberately deferred (see `design/evolution.md` → Audit Log & Manual
 * Trigger). When they land, follow the DGM pattern: append a reverse-event
 * row, never mutate the original.
 */
export const evolutionEvents = pgTable(
  "evolution_events",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    triggeredBy: evolutionTrigger("triggered_by").notNull(),
    payload: jsonbZod("payload", EvolutionEventPayloadSchema).notNull(),
    createdAt: ts(),
  },
  (t) => [
    // Digest path: `/learned` lists newest-first per user.
    index("idx_evolution_events_user").on(t.userId, desc(t.createdAt)),
  ],
);
