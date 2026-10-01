import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../../secrets/encryption.js";
import { DrizzleSecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleVoiceConfigStore } from "./voice-config.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let secretsStore: DrizzleSecretsStore;
const store = new DrizzleVoiceConfigStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleVoiceConfigStore", () => {
  describe("voice config", () => {
    it("returns undefined when no row is present", async () => {
      expect(await tx((trx) => store.getVoiceConfig(trx))).toBeUndefined();
    });

    it("returns the singleton row when present", async () => {
      // FK precondition: voice_config.tts_secret_id / stt_secret_id reference
      // the `secrets` table. Seed one row first; the same id is used for both
      // columns since the wizard stores a single OpenAI key for voice.
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: "openai_voice_key",
          plaintext: "sk-test-voice",
        }),
      );
      await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretId,
          sttSecretId: secretId,
          ttsProvider: "openai",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );

      const cfg = await tx((trx) => store.getVoiceConfig(trx));
      expect(cfg).toBeDefined();
      expect(cfg).toMatchObject({
        ttsSecretId: secretId,
        sttSecretId: secretId,
        ttsProvider: "openai",
        ttsModel: "gpt-4o-mini-tts",
        ttsVoice: "alloy",
        ttsBaseUrl: null,
        sttProvider: "openai",
        sttModel: "gpt-4o-mini-transcribe",
        sttBaseUrl: null,
      });
    });

    it("enforces singleton at the DB level — second insert violates UNIQUE", async () => {
      // The singleton column + UNIQUE/CHECK make a second row impossible.
      // Without the constraint, getVoiceConfig().limit(1) would pick
      // arbitrarily; the constraint blocks the misconfiguration at write time.
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: "openai_voice_key",
          plaintext: "sk-test-voice",
        }),
      );
      const insertSql = sql`
        INSERT INTO voice_config (
          tts_secret_id, stt_secret_id,
          tts_provider, tts_model, tts_voice,
          stt_provider, stt_model
        ) VALUES (
          ${secretId}, ${secretId},
          'openai', 'gpt-4o-mini-tts', 'alloy',
          'openai', 'gpt-4o-mini-transcribe'
        )
      `;
      await db.execute(insertSql);
      // Second insert with default singleton=TRUE collides on the UNIQUE.
      await expect(db.execute(insertSql)).rejects.toThrow();
    });

    it("upsertVoiceConfig rotates the singleton row in place — same id, new values", async () => {
      const { id: secretA } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key_a", plaintext: "sk-a" }),
      );
      const { id: secretB } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key_b", plaintext: "sk-b" }),
      );

      const first = await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretA,
          sttSecretId: secretA,
          ttsProvider: "openai",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );
      const firstCfg = expectDefined(
        await tx((trx) => store.getVoiceConfig(trx)),
        "first getVoiceConfig",
      );

      const second = await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretB,
          sttSecretId: secretB,
          ttsProvider: "openai_compatible",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "nova",
          ttsBaseUrl: "https://example.invalid/v1",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );

      // Same row id — UNIQUE on `singleton` forces ON CONFLICT DO UPDATE
      // to overwrite rather than insert.
      expect(second.id).toBe(first.id);

      const secondCfg = expectDefined(
        await tx((trx) => store.getVoiceConfig(trx)),
        "second getVoiceConfig",
      );
      expect(secondCfg).toMatchObject({
        id: first.id,
        ttsSecretId: secretB,
        sttSecretId: secretB,
        ttsProvider: "openai_compatible",
        ttsVoice: "nova",
        ttsBaseUrl: "https://example.invalid/v1",
      });
      // created_at survives the upsert — the row reflects when voice was
      // first configured, not last rotated. ON CONFLICT DO UPDATE only
      // writes the columns in its SET clause; created_at isn't there.
      expect(secondCfg.createdAt).toEqual(firstCfg.createdAt);
    });

    it("rejects nonsensical (provider, base_url) combos at write time", async () => {
      // CHECK constraints `chk_voice_config_{tts,stt}_base_url` enforce the
      // resolver's expectations at the DB level: openai/elevenlabs require
      // NULL base_url, openai_compatible requires NOT NULL. Hand-edited rows
      // can't sneak through and produce a silent "voice disabled until
      // construction succeeds" state at runtime.
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key", plaintext: "sk-test" }),
      );
      // PGlite's thrown Error.message is "Failed query: …"; the actual
      // postgres notice (with the constraint name) is on `.cause`. Match
      // there so the regression message names which constraint blocked
      // each row.
      const expectCheck = (promise: Promise<unknown>, constraint: string) =>
        expect(promise).rejects.toMatchObject({ cause: expect.objectContaining({ constraint }) });

      // openai + base_url IS NOT NULL → CHECK violation.
      await expectCheck(
        db.execute(sql`
          INSERT INTO voice_config (
            tts_secret_id, stt_secret_id,
            tts_provider, tts_model, tts_voice, tts_base_url,
            stt_provider, stt_model
          ) VALUES (
            ${secretId}, ${secretId},
            'openai', 'gpt-4o-mini-tts', 'alloy', 'https://example.invalid/v1',
            'openai', 'gpt-4o-mini-transcribe'
          )
        `),
        "chk_voice_config_tts_base_url",
      );
      // openai_compatible + base_url IS NULL → CHECK violation.
      await expectCheck(
        db.execute(sql`
          INSERT INTO voice_config (
            tts_secret_id, stt_secret_id,
            tts_provider, tts_model, tts_voice,
            stt_provider, stt_model
          ) VALUES (
            ${secretId}, ${secretId},
            'openai', 'gpt-4o-mini-tts', 'alloy',
            'openai_compatible', 'gpt-4o-mini-transcribe'
          )
        `),
        "chk_voice_config_stt_base_url",
      );
    });

    it("deleteVoiceConfig removes the singleton row", async () => {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key", plaintext: "sk-test" }),
      );
      await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretId,
          sttSecretId: secretId,
          ttsProvider: "openai",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );
      expect(await tx((trx) => store.getVoiceConfig(trx))).toBeDefined();

      await tx((trx) => store.deleteVoiceConfig(trx));
      expect(await tx((trx) => store.getVoiceConfig(trx))).toBeUndefined();

      // Idempotent — deleting again is a no-op, not an error.
      await tx((trx) => store.deleteVoiceConfig(trx));
    });
  });
});
