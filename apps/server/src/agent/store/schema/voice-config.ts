import { sql } from "drizzle-orm";
import { boolean, check, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { secrets } from "../../../secrets/store/schema.js";

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
