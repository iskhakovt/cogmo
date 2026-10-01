import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWizardDeps } from "../test/wizard.js";
import { stepConfigureClaudeCodeAuth } from "./wizard/claude-code-auth.js";
import { stepConfigureDaytona } from "./wizard/daytona.js";
import { stepConfigureGitHubIdentity } from "./wizard/github-identity.js";
import { stepValidateHindsight } from "./wizard/hindsight.js";
import { stepConfigureImageProviders } from "./wizard/image-providers.js";
import { stepConfigureProvider } from "./wizard/llm-provider.js";
import { stepConfigureOptionalTools } from "./wizard/optional-tools.js";
import { stepConfigureSkillsRemote } from "./wizard/skills-remote.js";
import { WizardCancelled } from "./wizard/step.js";
import { stepSummary } from "./wizard/summary.js";
import { stepConfigureTelegram } from "./wizard/telegram.js";
import { stepConfigureVoice } from "./wizard/voice.js";
import { runWizard } from "./wizard.js";

vi.mock("@clack/prompts", async () =>
  (await import("../test/clack-prompts-mock.js")).clackPromptsMock(),
);
vi.mock("./wizard/claude-code-auth.js", () => ({ stepConfigureClaudeCodeAuth: vi.fn() }));
vi.mock("./wizard/daytona.js", () => ({ stepConfigureDaytona: vi.fn() }));
vi.mock("./wizard/github-identity.js", () => ({ stepConfigureGitHubIdentity: vi.fn() }));
vi.mock("./wizard/hindsight.js", () => ({ stepValidateHindsight: vi.fn() }));
vi.mock("./wizard/image-providers.js", () => ({ stepConfigureImageProviders: vi.fn() }));
vi.mock("./wizard/llm-provider.js", () => ({ stepConfigureProvider: vi.fn() }));
vi.mock("./wizard/optional-tools.js", () => ({ stepConfigureOptionalTools: vi.fn() }));
vi.mock("./wizard/skills-remote.js", () => ({ stepConfigureSkillsRemote: vi.fn() }));
vi.mock("./wizard/summary.js", () => ({ stepSummary: vi.fn() }));
vi.mock("./wizard/telegram.js", () => ({ stepConfigureTelegram: vi.fn() }));
vi.mock("./wizard/voice.js", () => ({ stepConfigureVoice: vi.fn() }));

const PROVIDER = {
  id: "p-1",
  name: "anthropic",
  type: "anthropic",
  baseUrl: null,
  attrs: {},
} as const;

/** Every step, in the order the wizard must run them. */
const STEPS_IN_ORDER = [
  stepConfigureProvider,
  stepConfigureTelegram,
  stepConfigureOptionalTools,
  stepConfigureImageProviders,
  stepConfigureVoice,
  stepConfigureGitHubIdentity,
  stepConfigureClaudeCodeAuth,
  stepConfigureDaytona,
  stepConfigureSkillsRemote,
  stepValidateHindsight,
  stepSummary,
];

beforeEach(() => {
  vi.mocked(stepConfigureTelegram).mockResolvedValue({ botUsername: "cogmo_bot" });
});

describe("runWizard", () => {
  it("runs every step once, in order, and hands the bot username to the summary", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([PROVIDER]);

    await runWizard({ ...deps, userId: "user-1" });

    const order = STEPS_IN_ORDER.map((step) => {
      expect(step).toHaveBeenCalledOnce();
      return vi.mocked(step).mock.invocationCallOrder[0];
    });
    expect(order).toEqual([...order].sort((a = 0, b = 0) => a - b));
    expect(stepConfigureTelegram).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(stepSummary).toHaveBeenCalledWith(expect.anything(), "cogmo_bot");
  });

  it("repeats the provider step until a provider exists", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValueOnce([]).mockResolvedValue([PROVIDER]);

    await runWizard({ ...deps, userId: "user-1" });

    expect(stepConfigureProvider).toHaveBeenCalledTimes(2);
    expect(p.log.warn).toHaveBeenCalledWith(
      "At least one LLM provider is required. Let's try again.",
    );
  });

  it("stops at a cancelled step", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([PROVIDER]);
    vi.mocked(stepConfigureVoice).mockRejectedValueOnce(new WizardCancelled());

    await expect(runWizard({ ...deps, userId: "user-1" })).rejects.toBeInstanceOf(WizardCancelled);

    expect(stepConfigureGitHubIdentity).not.toHaveBeenCalled();
    expect(stepSummary).not.toHaveBeenCalled();
  });
});
