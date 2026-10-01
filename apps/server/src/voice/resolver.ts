/**
 * Lazy voice provider resolver — reads `voice_config` and decrypts secrets
 * per call, caches constructed providers by content hash.
 *
 * Mirrors `LlmProviderResolver` (`src/llm/resolver.ts`): the agent loop
 * needs a `{ tts, stt }` bundle at turn-start, and the bundle's identity is
 * derived from DB state (singleton row + two secret rows) — not from any
 * bootstrap-time constant. Reading per turn makes config changes (swap
 * voice id, change model, rotate API key, switch provider) take effect on
 * the next message with no process restart.
 *
 * Cost per call: one indexed singleton read + two secret lookups + a hash.
 * Cache hit returns the same `VoiceBundle` instance, so the OpenAI SDK
 * client and ElevenLabs `fetch` closure stay alive across turns. Cache
 * miss rebuilds — the new bundle replaces the old (singleton config →
 * single-entry cache).
 */

import { createHash } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import type { AgentStore } from "../agent/store/index.js";
import type { SttProviderTypeValue, TtsProviderTypeValue } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import { OpenAIVoiceProvider } from "./openai.js";
import type { SttProvider, TtsProvider } from "./types.js";

export interface VoiceBundle {
  tts: { provider: TtsProvider; voice: string; model: string };
  stt: { provider: SttProvider; model: string };
}

export type VoiceProviderResolver = () => Promise<VoiceBundle | undefined>;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DbVoiceResolverDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
  /** Custom fetch propagated to providers — used by integration tests. */
  fetch?: FetchLike;
}

interface CacheEntry {
  hash: string;
  bundle: VoiceBundle;
}

export function createDbVoiceResolver(deps: DbVoiceResolverDeps): VoiceProviderResolver {
  let cache: CacheEntry | undefined;

  return async () => {
    // Single tx for the row + both secret reads — atomic snapshot, and
    // saves a round trip when TTS and STT share a secret_id (the wizard's
    // "use the same key" shortcut produces this).
    const snapshot = await deps.runInTx(async (tx) => {
      const row = await deps.agentStore.getVoiceConfig(tx);
      if (!row) return undefined;
      const ttsKey = await deps.secretsStore.getSecretById(tx, row.ttsSecretId);
      const sttKey =
        row.sttSecretId === row.ttsSecretId
          ? ttsKey
          : await deps.secretsStore.getSecretById(tx, row.sttSecretId);
      return { row, ttsKey, sttKey };
    });
    if (!snapshot) {
      cache = undefined;
      return undefined;
    }
    const { row, ttsKey, sttKey } = snapshot;
    if (!ttsKey || !sttKey) {
      logger.warn(
        { ttsSecretId: row.ttsSecretId, sttSecretId: row.sttSecretId },
        "voice secrets missing — voice disabled until re-run setup",
      );
      cache = undefined;
      return undefined;
    }

    // SHA-256 the cache key so decrypted secrets never sit on the resolver
    // heap as plaintext beyond the provider instance that needs them.
    // Defense-in-depth against accidental log dumps, heapdumps, or future
    // telemetry hooks reading `cache.hash`.
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          tts: {
            provider: row.ttsProvider,
            baseUrl: row.ttsBaseUrl,
            key: ttsKey,
            voice: row.ttsVoice,
            model: row.ttsModel,
          },
          stt: {
            provider: row.sttProvider,
            baseUrl: row.sttBaseUrl,
            key: sttKey,
            model: row.sttModel,
          },
        }),
      )
      .digest("hex");
    if (cache && cache.hash === hash) return cache.bundle;

    const built = buildTts(row.ttsProvider, {
      apiKey: ttsKey,
      baseURL: row.ttsBaseUrl,
      ...(deps.fetch && { fetch: deps.fetch }),
    }).andThen((tts) =>
      buildStt(row.sttProvider, {
        apiKey: sttKey,
        baseURL: row.sttBaseUrl,
        ...(deps.fetch && { fetch: deps.fetch }),
      }).map(
        (stt): VoiceBundle => ({
          tts: { provider: tts, voice: row.ttsVoice, model: row.ttsModel },
          stt: { provider: stt, model: row.sttModel },
        }),
      ),
    );
    if (built.isErr()) {
      logger.warn(
        { reason: built.error, ttsProvider: row.ttsProvider, sttProvider: row.sttProvider },
        "voice provider config is invalid — voice disabled until config is fixed",
      );
      cache = undefined;
      return undefined;
    }
    cache = { hash, bundle: built.value };
    return built.value;
  };
}

interface BuildOpts {
  apiKey: string;
  baseURL: string | null;
  fetch?: FetchLike;
}

/** A voice config row that can't build a provider, as the operator-facing reason. */
type VoiceConfigError = string;

function buildTts(
  type: TtsProviderTypeValue,
  opts: BuildOpts,
): Result<TtsProvider, VoiceConfigError> {
  switch (type) {
    case "openai":
      return ok(
        new OpenAIVoiceProvider({
          apiKey: opts.apiKey,
          ...(opts.baseURL && { baseURL: opts.baseURL }),
          ...(opts.fetch && { fetch: opts.fetch }),
        }),
      );
    case "openai_compatible":
      return openAiCompatible("TTS", opts);
    case "elevenlabs":
      return ok(
        new ElevenLabsTtsProvider({
          apiKey: opts.apiKey,
          ...(opts.baseURL && { baseURL: opts.baseURL }),
          ...(opts.fetch && { fetch: opts.fetch }),
        }),
      );
  }
}

function buildStt(
  type: SttProviderTypeValue,
  opts: BuildOpts,
): Result<SttProvider, VoiceConfigError> {
  switch (type) {
    case "openai":
      return ok(
        new OpenAIVoiceProvider({
          apiKey: opts.apiKey,
          ...(opts.baseURL && { baseURL: opts.baseURL }),
          ...(opts.fetch && { fetch: opts.fetch }),
        }),
      );
    case "openai_compatible":
      return openAiCompatible("STT", opts);
  }
}

function openAiCompatible(
  side: "TTS" | "STT",
  opts: BuildOpts,
): Result<OpenAIVoiceProvider, VoiceConfigError> {
  if (!opts.baseURL) {
    return err(
      `voice ${side} provider 'openai_compatible' requires a base URL — re-run \`cogmo setup\` and set one`,
    );
  }
  return ok(
    new OpenAIVoiceProvider({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      ...(opts.fetch && { fetch: opts.fetch }),
    }),
  );
}
