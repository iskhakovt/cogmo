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

// vi.mock is hoisted above imports, so the @clack/prompts and
// ../voice/openai.js factories can't reference test-scope variables. Use
// vi.hoisted to lift the probe spy alongside.
const { ttsProbeFn } = vi.hoisted(() => ({ ttsProbeFn: vi.fn() }));

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
    tts = ttsProbeFn;
    stt = vi.fn();
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
  // Wizard reads voice_config first to decide keep/replace/remove vs.
  // initial-setup — these tests exercise the initial-setup path.
  agentStore.getVoiceConfig.mockResolvedValue(undefined);
  agentStore.upsertVoiceConfig.mockResolvedValue({ id: "voice-config-1" });
  secretsStore.putSecret.mockResolvedValue({ id: "secret-1" });
  secretsStore.markValidated.mockResolvedValue(undefined);
  return { agentStore, secretsStore, transportStore, runInTx: fakeRunInTx };
}

function primeUserInputs(): void {
  // Order matches the wizard's prompt sequence: initial-confirm, key,
  // tts-model, voice, stt-model. Tests that need a "save anyway" prompt
  // chain a second `confirm` resolution via mockResolvedValueOnce.
  vi.mocked(p.confirm).mockResolvedValueOnce(true);
  vi.mocked(p.password).mockResolvedValueOnce("sk-test-key");
  vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-tts");
  vi.mocked(p.select).mockResolvedValueOnce("alloy");
  vi.mocked(p.text).mockResolvedValueOnce("gpt-4o-mini-transcribe");
}

describe("stepConfigureVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("probe success: persists secret AND marks it validated, then writes voice_config", async () => {
    const deps = buildDeps();
    primeUserInputs();
    ttsProbeFn.mockResolvedValueOnce({ audio: Buffer.alloc(0), mediaType: "audio/ogg" });

    await stepConfigureVoice(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledOnce();
    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(FAKE_TX, {
      name: "openai_voice_key",
      plaintext: "sk-test-key",
      description: "OpenAI API key for voice (TTS + STT)",
    });
    // markValidated is the key contract: it only fires when the probe
    // round-trip actually succeeded.
    expect(deps.secretsStore.markValidated).toHaveBeenCalledOnce();
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, "openai_voice_key");
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledOnce();
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledWith(FAKE_TX, {
      ttsSecretId: "secret-1",
      sttSecretId: "secret-1",
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "alloy",
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
    });
  });

  it("probe fails + save-anyway: secret stored, voice_config written, markValidated NOT called", async () => {
    const deps = buildDeps();
    primeUserInputs();
    // Second confirm() resolves the "save anyway?" prompt.
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    ttsProbeFn.mockRejectedValueOnce(new Error("401 unauthorized"));

    await stepConfigureVoice(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledOnce();
    // Distinguishes a known-good-but-flaky save from a probe-validated save.
    // If this fires when the probe failed, operators with bad keys silently
    // get "validated" credentials and the error moves to first use.
    expect(deps.secretsStore.markValidated).not.toHaveBeenCalled();
    expect(deps.agentStore.upsertVoiceConfig).toHaveBeenCalledOnce();
  });
});
