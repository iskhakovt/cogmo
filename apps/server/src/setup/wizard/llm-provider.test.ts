import * as p from "@clack/prompts";
import { err as failed } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverModels } from "../../agent/provider/discover-models.js";
import { runClackValidate } from "../../test/assertions.js";
import { buildWizardDeps, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureProvider } from "./llm-provider.js";
import { WizardCancelled } from "./step.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const { addProviderSpy } = vi.hoisted(() => ({
  addProviderSpy: vi.fn(),
}));

vi.mock("../../agent/provider/add-provider.js", () => ({
  addProvider: addProviderSpy,
}));

vi.mock("../../agent/provider/discover-models.js", async () => {
  const { ok: found } = await import("neverthrow");
  return { discoverModels: vi.fn().mockResolvedValue(found([])) };
});

vi.mock("../../agent/provider/add-model-routing.js", () => ({
  addModelRouting: vi.fn().mockResolvedValue({ id: "row-1", position: 0 }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
  addProviderSpy.mockReset();
});

describe("stepConfigureProvider", () => {
  it("'keep' returns without touching addProvider or stepAdd*", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([
      { id: "p-1", name: "anthropic", type: "anthropic", baseUrl: null, secretId: "s" } as never,
    ]);
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureProvider(deps);

    expect(addProviderSpy).not.toHaveBeenCalled();
  });

  it("'replace' deletes every existing provider before re-prompting for type", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([
      { id: "p-1", name: "anthropic", type: "anthropic", baseUrl: null, secretId: "s" } as never,
      {
        id: "p-2",
        name: "openrouter",
        type: "openai_compatible",
        baseUrl: null,
        secretId: "s2",
      } as never,
    ]);
    deps.agentStore.deleteProvider.mockResolvedValue(undefined);
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    // After deletion, the wizard prompts for new provider type — make this throw via cancel
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    expect(deps.agentStore.deleteProvider).toHaveBeenCalledTimes(2);
  });

  it("provider-type select followed by cancel throws WizardCancelled", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]); // no existing providers
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);
  });

  it("validates API key length via the validator callback", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    addProviderSpy.mockResolvedValue({
      providerId: "p-new",
      validation: { valid: true },
    });
    vi.mocked(p.select).mockResolvedValueOnce("anthropic"); // provider type
    vi.mocked(p.password).mockResolvedValueOnce("very-long-api-key-here-12345");
    // bail-out on the discover/add-model select chain
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    const passCall = vi.mocked(p.password).mock.calls[0]?.[0];
    expect(runClackValidate(passCall?.validate, "")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "short")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "a long enough api key")).toBeUndefined();
  });

  it("gives the openrouter type the openrouter cache dialect", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    addProviderSpy.mockResolvedValue({ providerId: "p-new", validation: { valid: true } });
    vi.mocked(p.select).mockResolvedValueOnce("openrouter"); // provider type
    vi.mocked(p.password).mockResolvedValueOnce("sk-or-test-1234567890");
    // Discovery finds no models, so the model id is a `p.text` prompt; cancelling it bails out.
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // provider type
      .mockReturnValueOnce(false) // API key
      .mockReturnValueOnce(true); // model id

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);
    expect(vi.mocked(p.text)).toHaveBeenCalledOnce();

    expect(addProviderSpy).toHaveBeenCalledWith(deps, {
      name: "openrouter",
      type: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-1234567890",
      cacheDialect: "openrouter",
    });
  });

  it("falls back to typing the model id when discovery is unavailable", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    addProviderSpy.mockResolvedValue({ providerId: "p-new", validation: { valid: true } });
    vi.mocked(discoverModels).mockResolvedValueOnce(
      failed({ kind: "unavailable", message: "returned 404" }),
    );
    vi.mocked(p.select).mockResolvedValueOnce("openrouter"); // provider type
    vi.mocked(p.password).mockResolvedValueOnce("sk-or-test-1234567890");
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // provider type
      .mockReturnValueOnce(false) // API key
      .mockReturnValueOnce(true); // model id

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);
    expect(vi.mocked(p.select)).toHaveBeenCalledOnce();
    expect(vi.mocked(p.text)).toHaveBeenCalledOnce();
  });

  it("offers retry / skip / abort when the endpoint rejects discovery", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    addProviderSpy.mockResolvedValue({ providerId: "p-new", validation: { valid: true } });
    vi.mocked(discoverModels).mockResolvedValueOnce(
      failed({ kind: "rejected", message: "returned 401" }),
    );
    vi.mocked(p.select)
      .mockResolvedValueOnce("openrouter") // provider type
      .mockResolvedValueOnce("abort"); // discovery failed
    vi.mocked(p.password).mockResolvedValueOnce("sk-or-test-1234567890");

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);
    expect(vi.mocked(p.select).mock.calls[1]?.[0]?.message).toMatch(/Discovery failed/);
    expect(vi.mocked(p.text)).not.toHaveBeenCalled();
  });

  it("custom provider: prompts for base URL before API key", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    vi.mocked(p.select).mockResolvedValueOnce("custom"); // provider type
    vi.mocked(p.text).mockResolvedValueOnce("https://api.example.com/v1");
    // Cancel at the password prompt to bail out cleanly without driving
    // through addProvider / stepAddModelsForProvider.
    vi.mocked(p.password).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // select
      .mockReturnValueOnce(false) // text (URL)
      .mockReturnValueOnce(true); // password

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    expect(vi.mocked(p.text)).toHaveBeenCalledTimes(1);
    const textCall = vi.mocked(p.text).mock.calls[0]?.[0];
    expect(textCall?.message).toMatch(/Base URL/);
  });

  it("when no existing providers, no first select prompt is shown", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    // Only one select call should fire (the provider-type prompt), not two
    // (keep/replace/add then provider-type).
    expect(vi.mocked(p.select)).toHaveBeenCalledTimes(1);
    const selectMessage = vi.mocked(p.select).mock.calls[0]?.[0]?.message ?? "";
    expect(selectMessage).toMatch(/Choose your LLM provider/);
  });
});
