import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWizardDeps, resetClackPrompts } from "../../test/wizard.js";
import { stepSummary } from "./summary.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
});

describe("stepSummary", () => {
  it("renders 'configured' line for telegram when channel exists, includes botUsername next-step", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([
      { id: "p-1", name: "anthropic", type: "anthropic", baseUrl: null, secretId: "s-1" } as never,
    ]);
    deps.secretsStore.listSecrets.mockResolvedValue([
      { id: "s-1", name: "x", description: "", validatedAt: new Date() },
    ] as never);
    deps.transportStore.getChannelByType.mockResolvedValue({
      id: "ch-1",
      type: "telegram",
    } as never);
    deps.agentStore.getVoiceConfig.mockResolvedValue(undefined);

    await stepSummary(deps, "cogmo_bot");

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/Telegram: configured/),
      "Setup complete",
    );
    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/@cogmo_bot/),
      "Verify it's running",
    );
  });

  it("falls back to 'use pnpm console' next-step when no telegram channel is configured", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    deps.secretsStore.listSecrets.mockResolvedValue([]);
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    deps.agentStore.getVoiceConfig.mockResolvedValue(undefined);

    await stepSummary(deps);

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/Telegram: not configured/),
      "Setup complete",
    );
    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/pnpm console/),
      "Verify it's running",
    );
  });

  it("renders voice 'configured (model/voice)' when a voice_config row exists", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    deps.secretsStore.listSecrets.mockResolvedValue([]);
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    deps.agentStore.getVoiceConfig.mockResolvedValue({
      id: "v-1",
      ttsSecretId: "s",
      sttSecretId: "s",
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "alloy",
      ttsBaseUrl: null,
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttBaseUrl: null,
    } as never);

    await stepSummary(deps);

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/Voice: configured \(gpt-4o-mini-tts\/alloy\)/),
      "Setup complete",
    );
  });

  it("when telegram exists but no botUsername arg is passed, surfaces the generic message-bot hint", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    deps.secretsStore.listSecrets.mockResolvedValue([]);
    deps.transportStore.getChannelByType.mockResolvedValue({
      id: "ch-1",
      type: "telegram",
    } as never);
    deps.agentStore.getVoiceConfig.mockResolvedValue(undefined);

    await stepSummary(deps);

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/message your configured bot/),
      "Verify it's running",
    );
  });
});
