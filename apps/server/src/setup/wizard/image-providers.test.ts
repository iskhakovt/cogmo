import * as p from "@clack/prompts";
import { err as failed, ok as found } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClackValidate } from "../../test/assertions.js";
import { buildWizardDeps, FAKE_TX, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureImageProviders } from "./image-providers.js";
import { WizardCancelled } from "./step.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
});

describe("stepConfigureImageProviders", () => {
  it("no existing providers AND user declines → skips entirely", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureImageProviders(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(deps.agentStore.createImageProvider).not.toHaveBeenCalled();
  });

  it("filters out fal providers when deciding whether to show 'keep/add/add-model'", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([
      { id: "fal-1", name: "fal", type: "fal", baseUrl: null, secretId: "s", attrs: {} } as never,
    ]);
    // Since only fal exists, nonFalExisting is empty → confirm path runs.
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureImageProviders(deps);

    expect(vi.mocked(p.confirm)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/Configure an OpenAI-compatible or Venice/),
      }),
    );
  });

  it("existing non-fal provider + 'keep' returns without further prompts", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([
      {
        id: "v-1",
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        secretId: "s",
        attrs: {},
      } as never,
    ]);
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureImageProviders(deps);

    expect(deps.agentStore.createImageProvider).not.toHaveBeenCalled();
    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
  });

  it("'add-model' delegates to stepAddImageModelToExisting (prompts for which provider)", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([
      {
        id: "v-1",
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        secretId: "s",
        attrs: {},
      } as never,
    ]);
    vi.mocked(p.select).mockResolvedValueOnce("add-model");
    // promptAddImageModels: first prompt is a confirm "Add a model?".
    // Decline so we exit cleanly.
    vi.mocked(p.select).mockResolvedValueOnce("v-1"); // which provider
    vi.mocked(p.confirm).mockResolvedValueOnce(false); // decline first add

    await stepConfigureImageProviders(deps);

    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
    // The first select asked the keep/add/add-model question.
    const selectCalls = vi.mocked(p.select).mock.calls;
    expect(selectCalls[0]?.[0]?.message).toMatch(/Image provider\(s\) configured/);
    expect(selectCalls[1]?.[0]?.message).toMatch(/Which provider/);
  });

  it("happy path: adds a non-fal provider when no existing + user accepts", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    deps.agentStore.createImageProvider.mockResolvedValue(found({ id: "p-new" }));
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true) // proceed
      .mockResolvedValueOnce(true) // safe_mode default
      .mockResolvedValueOnce(false); // promptAddImageModels: decline first add
    vi.mocked(p.select).mockResolvedValueOnce("venice"); // provider type
    vi.mocked(p.text)
      .mockResolvedValueOnce("venice") // provider name
      .mockResolvedValueOnce("https://api.venice.ai/api/v1"); // base url
    vi.mocked(p.password).mockResolvedValueOnce("venice-key-very-long-abcdef");

    await stepConfigureImageProviders(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "venice_api_key" }),
    );
    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        attrs: { imageGenerationDefaults: { safe_mode: true } },
      }),
    );
  });

  it("openai_compatible: no safe_mode prompt, attrs stay empty", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    deps.agentStore.createImageProvider.mockResolvedValue(found({ id: "p-new" }));
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true) // proceed
      .mockResolvedValueOnce(false); // promptAddImageModels first add → no
    vi.mocked(p.select).mockResolvedValueOnce("openai_compatible");
    vi.mocked(p.text)
      .mockResolvedValueOnce("openai")
      .mockResolvedValueOnce("https://api.openai.com/v1");
    vi.mocked(p.password).mockResolvedValueOnce("sk-openai-very-long-abcdef-key");

    await stepConfigureImageProviders(deps);

    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ type: "openai_compatible", attrs: {} }),
    );
  });

  it("createImageProvider failure: logs error and returns without further work", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    deps.agentStore.createImageProvider.mockResolvedValue(
      failed({ kind: "image_provider_name_taken", name: "venice" }),
    );
    vi.mocked(p.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(p.select).mockResolvedValueOnce("venice");
    vi.mocked(p.text)
      .mockResolvedValueOnce("venice")
      .mockResolvedValueOnce("https://api.venice.ai/api/v1");
    vi.mocked(p.password).mockResolvedValueOnce("venice-key-very-long-abc-def");

    await stepConfigureImageProviders(deps);

    // putSecret was attempted; createImageProvider failed; no model prompts should follow.
    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
  });

  it("validator: provider name rejects shell-unsafe chars", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.select).mockResolvedValueOnce("venice");
    vi.mocked(p.text).mockResolvedValueOnce("venice");
    // Cancel later via isCancel
    vi.mocked(p.text).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // select provider-type
      .mockReturnValueOnce(false) // text name
      .mockReturnValueOnce(true); // text baseUrl → cancel

    await expect(stepConfigureImageProviders(deps)).rejects.toBeInstanceOf(WizardCancelled);

    const nameCall = vi.mocked(p.text).mock.calls[0]?.[0];
    expect(runClackValidate(nameCall?.validate, "Bad Name!")).toMatch(/Lowercase/);
    expect(runClackValidate(nameCall?.validate, "venice")).toBeUndefined();
  });

  it("validator: base URL must start with https:// and reject trailing slash", async () => {
    const deps = buildWizardDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.select).mockResolvedValueOnce("venice");
    vi.mocked(p.text)
      .mockResolvedValueOnce("venice")
      .mockResolvedValueOnce("https://api.venice.ai/api/v1");
    vi.mocked(p.password).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // select
      .mockReturnValueOnce(false) // text name
      .mockReturnValueOnce(false) // text baseUrl
      .mockReturnValueOnce(true); // password → cancel

    await expect(stepConfigureImageProviders(deps)).rejects.toBeInstanceOf(WizardCancelled);

    const baseUrlCall = vi.mocked(p.text).mock.calls[1]?.[0];
    expect(runClackValidate(baseUrlCall?.validate, "http://insecure")).toMatch(/https/);
    expect(runClackValidate(baseUrlCall?.validate, "https://api.example.com/")).toMatch(
      /trailing slash/,
    );
    expect(runClackValidate(baseUrlCall?.validate, "https://api.example.com")).toBeUndefined();
  });
});
