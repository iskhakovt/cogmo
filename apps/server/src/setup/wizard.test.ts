import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";

// Sentinel-tx token — fakeRunInTx passes it through to every store call so
// assertions on call args can use it directly (vs. `expect.anything()`).
const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

// vi.mock is hoisted above imports, so the @clack/prompts and provider
// factories can't reference test-scope variables. Use vi.hoisted to lift the
// probe spies alongside.
const { openaiTtsProbe, elevenlabsTtsProbe } = vi.hoisted(() => ({
  openaiTtsProbe: vi.fn(),
  elevenlabsTtsProbe: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  note: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  // cancelGuard wraps every prompt; isCancel=false keeps the flow alive so
  // tests drive happy + degraded paths without dealing with WizardCancelled.
  isCancel: vi.fn(() => false),
}));

vi.mock("../voice/openai.js", () => ({
  OpenAIVoiceProvider: class {
    readonly name = "openai";
    tts = openaiTtsProbe;
    stt = vi.fn();
  },
}));

vi.mock("../voice/elevenlabs.js", () => ({
  ElevenLabsTtsProvider: class {
    readonly name = "elevenlabs";
    tts = elevenlabsTtsProbe;
  },
}));

// Pulled in AFTER the vi.mocks so the wizard module loads against the mocks.
const { stepConfigureVoice } = await import("./wizard.js");

interface TestDeps {
  agentStore: ReturnType<typeof mock<AgentStore>>;
  secretsStore: ReturnType<typeof mock<SecretsStore>>;
  transportStore: ReturnType<typeof mock<TransportStore>>;
  runInTx: Transactor;
}

function buildDeps(): TestDeps {
  const agentStore = mock<AgentStore>();
  const secretsStore = mock<SecretsStore>();
  const transportStore = mock<TransportStore>();
  agentStore.getVoiceConfig.mockResolvedValue(undefined);
  agentStore.upsertVoiceConfig.mockResolvedValue({ id: "voice-config-1" });
  // putSecret returns distinct ids on each call so reusedSecret vs.
  // independent-secrets paths can be told apart in assertions.
  let nextSecretId = 1;
  secretsStore.putSecret.mockImplementation(async () => ({ id: `secret-${nextSecretId++}` }));
  secretsStore.markValidated.mockResolvedValue(undefined);
  return { agentStore, secretsStore, transportStore, runInTx: fakeRunInTx };
}

describe("stepConfigureVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("openai TTS + openai STT (reused key) — persists secret, marks validated, writes voice_config", async () => {
    const deps = buildDeps();
    // Prompt order: initial-confirm, tts-type-select, tts-key-password,
    // tts-model-text, tts-voice-select, stt-type-select, reuse-key-confirm,
    // stt-model-text.
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial confirm
    vi.mocked(p.select).mockResolvedValueOnce("openai"); // tts type
    vi.mocked(p.password).mockResolvedValueOnce("sk-tts-key");
    vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-tts"); // tts model
    vi.mocked(p.select).mockResolvedValueOnce("alloy"); // tts voice
    vi.mocked(p.select).mockResolvedValueOnce("openai"); // stt type
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // reuse key
    vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-transcribe"); // stt model
    openaiTtsProbe.mockResolvedValueOnce({ audio: Buffer.alloc(0), mediaType: "audio/ogg" });

    await stepConfigureVoice(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledOnce();
    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(FAKE_TX, {
      name: "openai_voice_key",
      plaintext: "sk-tts-key",
      description: "openai API key for voice TTS",
    });
    expect(deps.secretsStore.markValidated).toHaveBeenCalledOnce();
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, "openai_voice_key");
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledOnce();
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledWith(FAKE_TX, {
      ttsSecretId: "secret-1",
      sttSecretId: "secret-1",
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "alloy",
      ttsBaseUrl: null,
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttBaseUrl: null,
    });
  });

  it("openai_compatible TTS + openai_compatible STT — persists base URLs and two secrets", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial confirm
    vi.mocked(p.select).mockResolvedValueOnce("openai_compatible"); // tts type
    vi.mocked(p.text).mockResolvedValueOnce("https://api.groq.com/openai/v1"); // tts baseURL
    vi.mocked(p.password).mockResolvedValueOnce("gsk_tts_groq_key_xxxxxxxxxx");
    vi.mocked(p.text).mockResolvedValueOnce("playai-tts"); // tts model
    vi.mocked(p.text).mockResolvedValueOnce("Adelaide-PlayAI"); // tts voice (text input on compat)
    vi.mocked(p.select).mockResolvedValueOnce("openai_compatible"); // stt type
    vi.mocked(p.text).mockResolvedValueOnce("https://api.fireworks.ai/inference/v1"); // stt baseURL
    // Different baseURL → no reuse confirm; password prompted directly.
    vi.mocked(p.password).mockResolvedValueOnce("fw_stt_key_yyyyyyyyyyyy");
    vi.mocked(p.text).mockResolvedValueOnce("whisper-v3"); // stt model
    openaiTtsProbe.mockResolvedValueOnce({ audio: Buffer.alloc(0), mediaType: "audio/ogg" });

    await stepConfigureVoice(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledTimes(2);
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledWith(FAKE_TX, {
      ttsSecretId: "secret-1",
      sttSecretId: "secret-2",
      ttsProvider: "openai_compatible",
      ttsModel: "playai-tts",
      ttsVoice: "Adelaide-PlayAI",
      ttsBaseUrl: "https://api.groq.com/openai/v1",
      sttProvider: "openai_compatible",
      sttModel: "whisper-v3",
      sttBaseUrl: "https://api.fireworks.ai/inference/v1",
    });
  });

  it("elevenlabs TTS + openai STT — separate keys, ElevenLabs probe", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial confirm
    vi.mocked(p.select).mockResolvedValueOnce("elevenlabs"); // tts type
    vi.mocked(p.password).mockResolvedValueOnce("xi-elevenlabs-key-xxxxxxxx");
    vi.mocked(p.text).mockResolvedValueOnce("eleven_turbo_v2_5"); // tts model
    vi.mocked(p.text).mockResolvedValueOnce("21m00Tcm4TlvDq8ikWAM"); // tts voice id
    vi.mocked(p.select).mockResolvedValueOnce("openai"); // stt type
    // ElevenLabs ≠ OpenAI → no reuse confirm; STT password prompted directly.
    vi.mocked(p.password).mockResolvedValueOnce("sk-stt-openai-key-xxxxxxxx");
    vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-transcribe"); // stt model
    elevenlabsTtsProbe.mockResolvedValueOnce({
      audio: Buffer.alloc(0),
      mediaType: "audio/ogg",
    });

    await stepConfigureVoice(deps);

    expect(elevenlabsTtsProbe).toHaveBeenCalledOnce();
    expect(openaiTtsProbe).not.toHaveBeenCalled();
    expect(deps.secretsStore.putSecret).toHaveBeenCalledTimes(2);
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledWith(FAKE_TX, {
      ttsSecretId: "secret-1",
      sttSecretId: "secret-2",
      ttsProvider: "elevenlabs",
      ttsModel: "eleven_turbo_v2_5",
      ttsVoice: "21m00Tcm4TlvDq8ikWAM",
      ttsBaseUrl: null,
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttBaseUrl: null,
    });
  });

  it("identical key pasted across incompatible providers — stores two rows, descriptions stay accurate", async () => {
    // Same string entered for TTS (elevenlabs) and STT (openai) — perhaps
    // the user's clipboard happened to carry one over. Reuse must NOT
    // collapse them into a single row named `voice_tts_key` with the
    // description "elevenlabs API key for voice TTS" reused for STT.
    const deps = buildDeps();
    const sharedKey = "same-clipboard-contents-xxxxx";
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial confirm
    vi.mocked(p.select).mockResolvedValueOnce("elevenlabs"); // tts type
    vi.mocked(p.password).mockResolvedValueOnce(sharedKey); // tts key
    vi.mocked(p.text).mockResolvedValueOnce("eleven_turbo_v2_5"); // tts model
    vi.mocked(p.text).mockResolvedValueOnce("21m00Tcm4TlvDq8ikWAM"); // tts voice
    vi.mocked(p.select).mockResolvedValueOnce("openai"); // stt type
    // Different type → no reuse confirm; STT key prompted directly.
    vi.mocked(p.password).mockResolvedValueOnce(sharedKey); // stt key (string match)
    vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-transcribe");
    elevenlabsTtsProbe.mockResolvedValueOnce({
      audio: Buffer.alloc(0),
      mediaType: "audio/ogg",
    });

    await stepConfigureVoice(deps);

    // Two distinct rows — string match alone doesn't trigger reuse anymore.
    expect(deps.secretsStore.putSecret).toHaveBeenCalledTimes(2);
    expect(deps.secretsStore.putSecret).toHaveBeenNthCalledWith(1, FAKE_TX, {
      name: "voice_tts_key",
      plaintext: sharedKey,
      description: "elevenlabs API key for voice TTS",
    });
    expect(deps.secretsStore.putSecret).toHaveBeenNthCalledWith(2, FAKE_TX, {
      name: "voice_stt_key",
      plaintext: sharedKey,
      description: "openai API key for voice STT",
    });
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ ttsSecretId: "secret-1", sttSecretId: "secret-2" }),
    );
  });

  it("probe fails + save-anyway — secret stored, voice_config written, markValidated NOT called", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial confirm
    vi.mocked(p.select).mockResolvedValueOnce("openai"); // tts type
    vi.mocked(p.password).mockResolvedValueOnce("sk-tts-key");
    vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-tts");
    vi.mocked(p.select).mockResolvedValueOnce("alloy");
    vi.mocked(p.select).mockResolvedValueOnce("openai"); // stt type
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // reuse key
    vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-transcribe");
    openaiTtsProbe.mockRejectedValueOnce(new Error("401 unauthorized"));
    // The save-anyway prompt resolves to true.
    vi.mocked(p.confirm).mockResolvedValueOnce(true);

    await stepConfigureVoice(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledOnce();
    // Distinguishes a known-good-but-flaky save from a probe-validated save.
    expect(deps.secretsStore.markValidated).not.toHaveBeenCalled();
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledOnce();
  });
});
