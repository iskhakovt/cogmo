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
    const row = await deps.runInTx((tx) => deps.agentStore.getVoiceConfig(tx));
    if (!row) {
      cache = undefined;
      return undefined;
    }

    const [ttsKey, sttKey] = await deps.runInTx((tx) =>
      Promise.all([
        deps.secretsStore.getSecretById(tx, row.ttsSecretId),
        deps.secretsStore.getSecretById(tx, row.sttSecretId),
      ]),
    );
    if (!ttsKey || !sttKey) {
      logger.warn(
        { ttsSecretId: row.ttsSecretId, sttSecretId: row.sttSecretId },
        "voice secrets missing — voice disabled until re-run setup",
      );
      cache = undefined;
      return undefined;
    }

    const hash = JSON.stringify({
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
    });
    if (cache && cache.hash === hash) return cache.bundle;

    try {
      const tts = buildTts(row.ttsProvider, {
        apiKey: ttsKey,
        baseURL: row.ttsBaseUrl,
        ...(deps.fetch && { fetch: deps.fetch }),
      });
      const stt = buildStt(row.sttProvider, {
        apiKey: sttKey,
        baseURL: row.sttBaseUrl,
        ...(deps.fetch && { fetch: deps.fetch }),
      });
      const bundle: VoiceBundle = {
        tts: { provider: tts, voice: row.ttsVoice, model: row.ttsModel },
        stt: { provider: stt, model: row.sttModel },
      };
      cache = { hash, bundle };
      return bundle;
    } catch (err) {
      logger.warn(
        { err, ttsProvider: row.ttsProvider, sttProvider: row.sttProvider },
        "voice provider construction failed — voice disabled until config is fixed",
      );
      cache = undefined;
      return undefined;
    }
  };
}

interface BuildOpts {
  apiKey: string;
  baseURL: string | null;
  fetch?: FetchLike;
}

function buildTts(type: TtsProviderTypeValue, opts: BuildOpts): TtsProvider {
  switch (type) {
    case "openai":
      return new OpenAIVoiceProvider({
        apiKey: opts.apiKey,
        ...(opts.baseURL && { baseURL: opts.baseURL }),
        ...(opts.fetch && { fetch: opts.fetch }),
      });
    case "openai_compatible":
      if (!opts.baseURL) {
        throw new Error(
          "voice TTS provider 'openai_compatible' requires a base URL — re-run `cogmo setup` and set one",
        );
      }
      return new OpenAIVoiceProvider({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
        ...(opts.fetch && { fetch: opts.fetch }),
      });
    case "elevenlabs":
      return new ElevenLabsTtsProvider({
        apiKey: opts.apiKey,
        ...(opts.baseURL && { baseURL: opts.baseURL }),
        ...(opts.fetch && { fetch: opts.fetch }),
      });
  }
}

function buildStt(type: SttProviderTypeValue, opts: BuildOpts): SttProvider {
  switch (type) {
    case "openai":
      return new OpenAIVoiceProvider({
        apiKey: opts.apiKey,
        ...(opts.baseURL && { baseURL: opts.baseURL }),
        ...(opts.fetch && { fetch: opts.fetch }),
      });
    case "openai_compatible":
      if (!opts.baseURL) {
        throw new Error(
          "voice STT provider 'openai_compatible' requires a base URL — re-run `cogmo setup` and set one",
        );
      }
      return new OpenAIVoiceProvider({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
        ...(opts.fetch && { fetch: opts.fetch }),
      });
  }
}

/**
 * Trivial resolver that always returns the same bundle. Used by tests that
 * want to inject a deterministic stub instead of wiring an AgentStore +
 * SecretsStore pair.
 */
export function constantVoiceResolver(bundle: VoiceBundle | undefined): VoiceProviderResolver {
  return () => Promise.resolve(bundle);
}
