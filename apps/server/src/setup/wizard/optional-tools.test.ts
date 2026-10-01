import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWizardDeps, FAKE_TX, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureOptionalTools } from "./optional-tools.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const { validateTavilyKeySpy } = vi.hoisted(() => ({
  validateTavilyKeySpy: vi.fn(),
}));

vi.mock("../validate.js", () => ({
  validateTavilyKey: validateTavilyKeySpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
  validateTavilyKeySpy.mockReset();
});

describe("stepConfigureOptionalTools", () => {
  it("skips when user declines to configure tools", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("stores tavily key when validation succeeds and fal key without validation", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("tavily-key"); // tavily
    validateTavilyKeySpy.mockResolvedValueOnce({ valid: true });
    vi.mocked(p.password).mockResolvedValueOnce("fal-key"); // fal

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "tavily_api_key" }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, "tavily_api_key");
    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "fal_api_key" }),
    );
  });

  it("does not persist tavily key when validation fails", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("tavily-bad");
    validateTavilyKeySpy.mockResolvedValueOnce({ valid: false, error: "401" });
    vi.mocked(p.password).mockResolvedValueOnce(""); // skip fal

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("skips both keys when both passwords are empty (Enter to skip)", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("");
    vi.mocked(p.password).mockResolvedValueOnce("");

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(validateTavilyKeySpy).not.toHaveBeenCalled();
  });
});
