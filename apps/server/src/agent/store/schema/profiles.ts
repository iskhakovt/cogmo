import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import {
  MemoryCompartmentSchema,
  MemoryTrustSchema,
} from "../../evolution/memory-extraction-schema.js";
import { profileClasses } from "./profile-classes.js";
import { users } from "./users.js";

export const autoRecallMode = pgEnum("auto_recall_mode", ["off", "always", "heuristic", "llm"]);

/**
 * Voice mode preference. `auto` mirrors inbound modality (voice in → voice out).
 * Lives on profiles (default) and conversations (override, nullable). See
 * design/voice.md.
 */
export const voiceMode = pgEnum("voice_mode", ["auto", "always", "never"]);

/**
 * Per-profile auto-approve for the coding-delegation **plan gate**. `off`
 * (default) preserves the Telegram approve/revise/cancel round trip after
 * the plan streams; `on` stamps `plan_approved_at` and emits
 * `coding/task/plan-approved` automatically once the plan text is
 * persisted, so execute starts without waiting on a button tap. Toggled
 * via `/profile autoapprove`. Visibility is preserved — the plan still
 * streams to Telegram; only the approval round trip is skipped.
 *
 * Read only for `triggerSource = 'user'` tasks. Evolution /
 * signal-pipeline triggers have no interactive gate at all, so the plan
 * orchestrator clears theirs without consulting a profile.
 */
export const codingAutoapproveMode = pgEnum("coding_autoapprove_mode", ["off", "on"]);

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
     * Auto-approve coding-delegation plans without waiting for the Telegram
     * round trip. See `codingAutoapproveMode` enum docstring. Toggled via
     * `/profile autoapprove <name> on|off`.
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
