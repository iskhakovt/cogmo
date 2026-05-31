import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import type { Transaction, Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import { OpenAIVoiceProvider } from "./openai.js";
import { createDbVoiceResolver } from "./resolver.js";

// Sentinel transaction handed to store calls — the fake `Transactor` below
// just runs the callback; nothing inspects the value.
const FAKE_TX = { __mockTx: true } as never as Transaction;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

interface RowOverrides {
  ttsProvider?: "openai" | "openai_compatible" | "elevenlabs";
  sttProvider?: "openai" | "openai_compatible";
  ttsBaseUrl?: string | null;
  sttBaseUrl?: string | null;
  ttsVoice?: string;
  ttsModel?: string;
  sttModel?: string;
  ttsSecretId?: string;
  sttSecretId?: string;
}

function voiceRow(overrides: RowOverrides = {}) {
  return {
    id: "vc-1",
    ttsSecretId: overrides.ttsSecretId ?? "sec-tts",
    sttSecretId: overrides.sttSecretId ?? "sec-stt",
    ttsProvider: overrides.ttsProvider ?? "openai",
    ttsModel: overrides.ttsModel ?? "gpt-4o-mini-tts",
    ttsVoice: overrides.ttsVoice ?? "alloy",
    ttsBaseUrl: overrides.ttsBaseUrl ?? null,
    sttProvider: overrides.sttProvider ?? "openai",
    sttModel: overrides.sttModel ?? "gpt-4o-mini-transcribe",
    sttBaseUrl: overrides.sttBaseUrl ?? null,
    createdAt: new Date(0),
  };
}

interface ResolverFixture {
  agentStore: ReturnType<typeof mock<AgentStore>>;
  secretsStore: ReturnType<typeof mock<SecretsStore>>;
}

function setup(): ResolverFixture {
  const agentStore = mock<AgentStore>();
  const secretsStore = mock<SecretsStore>();
  // Default secret values — single-key reuse path (TTS == STT).
  secretsStore.getSecretById.mockImplementation(async (_tx, id) => {
    if (id === "sec-tts") return "tts-key-v1";
    if (id === "sec-stt") return "stt-key-v1";
    return undefined;
  });
  return { agentStore, secretsStore };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createDbVoiceResolver", () => {
  it("returns undefined when no voice_config row exists", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValue(undefined);

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    expect(await resolve()).toBeUndefined();
    expect(secretsStore.getSecretById).not.toHaveBeenCalled();
  });

  it("returns undefined when a referenced secret is missing", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValue(voiceRow());
    secretsStore.getSecretById.mockResolvedValue(undefined);

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    expect(await resolve()).toBeUndefined();
  });

  it("builds an OpenAI bundle for tts/stt = openai", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValue(voiceRow());

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    const bundle = await resolve();
    expect(bundle).toBeDefined();
    expect(bundle?.tts.provider).toBeInstanceOf(OpenAIVoiceProvider);
    expect(bundle?.stt.provider).toBeInstanceOf(OpenAIVoiceProvider);
    expect(bundle?.tts.voice).toBe("alloy");
    expect(bundle?.tts.model).toBe("gpt-4o-mini-tts");
    expect(bundle?.stt.model).toBe("gpt-4o-mini-transcribe");
  });

  it("builds an ElevenLabs TTS provider for tts = elevenlabs", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValue(
      voiceRow({
        ttsProvider: "elevenlabs",
        ttsVoice: "voice-id-x",
        ttsModel: "eleven_turbo_v2_5",
      }),
    );

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    const bundle = await resolve();
    expect(bundle?.tts.provider).toBeInstanceOf(ElevenLabsTtsProvider);
    expect(bundle?.stt.provider).toBeInstanceOf(OpenAIVoiceProvider);
    expect(bundle?.tts.voice).toBe("voice-id-x");
  });

  it("returns undefined and warns when openai_compatible is missing a baseURL", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValue(
      voiceRow({ ttsProvider: "openai_compatible", ttsBaseUrl: null }),
    );

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    expect(await resolve()).toBeUndefined();
  });

  it("caches the bundle when row + secrets are unchanged across calls", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValue(voiceRow());

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    const first = await resolve();
    const second = await resolve();
    expect(first).toBeDefined();
    // Identity equality — cache hit returns the same bundle instance.
    expect(second).toBe(first);
  });

  it("rebuilds when the voice id changes (config edit)", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValueOnce(voiceRow({ ttsVoice: "alloy" }));
    agentStore.getVoiceConfig.mockResolvedValueOnce(voiceRow({ ttsVoice: "echo" }));

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    const first = await resolve();
    const second = await resolve();
    expect(first?.tts.voice).toBe("alloy");
    expect(second?.tts.voice).toBe("echo");
    expect(second).not.toBe(first);
  });

  it("rebuilds when the secret value rotates under the same secret id", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValue(voiceRow());
    let ttsKey = "tts-key-v1";
    secretsStore.getSecretById.mockImplementation(async (_tx, id) => {
      if (id === "sec-tts") return ttsKey;
      if (id === "sec-stt") return "stt-key-v1";
      return undefined;
    });

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    const first = await resolve();
    ttsKey = "tts-key-v2";
    const second = await resolve();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("evicts the cached bundle when the row disappears mid-process", async () => {
    const { agentStore, secretsStore } = setup();
    agentStore.getVoiceConfig.mockResolvedValueOnce(voiceRow());
    agentStore.getVoiceConfig.mockResolvedValueOnce(undefined);
    agentStore.getVoiceConfig.mockResolvedValueOnce(voiceRow());

    const resolve = createDbVoiceResolver({
      runInTx: fakeRunInTx,
      agentStore,
      secretsStore,
    });
    const first = await resolve();
    expect(await resolve()).toBeUndefined();
    const third = await resolve();
    // After eviction the next bundle is freshly built — not the cached one.
    expect(third).not.toBe(first);
    expect(third).toBeDefined();
  });
});
