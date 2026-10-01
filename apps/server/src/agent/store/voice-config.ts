import { desc } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { type SttProviderTypeValue, type TtsProviderTypeValue, voiceConfig } from "./schema.js";

/** The singleton `voice_config` row: which TTS and STT providers voice runs on. */
export interface VoiceConfigStore {
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
}

export class DrizzleVoiceConfigStore implements VoiceConfigStore {
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
}
