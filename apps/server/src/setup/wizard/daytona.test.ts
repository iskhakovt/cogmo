import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAYTONA_API_KEY_SECRET } from "../../sandbox/daytona/auth.js";
import { buildWizardDeps, FAKE_TX, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureDaytona } from "./daytona.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const { validateDaytonaApiKeySpy } = vi.hoisted(() => ({
  validateDaytonaApiKeySpy: vi.fn(),
}));

vi.mock("../validate.js", () => ({
  validateDaytonaApiKey: validateDaytonaApiKeySpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Restore any `process.env` keys swapped via `vi.stubEnv` in a prior test.
  vi.unstubAllEnvs();
  resetClackPrompts();
  validateDaytonaApiKeySpy.mockReset();
});

describe("stepConfigureDaytona", () => {
  it("skips when user declines the optional prompt", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("keeps existing key when 'keep' is selected", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecretMeta.mockResolvedValue({
      id: "s-d",
      name: DAYTONA_API_KEY_SECRET,
      description: "",
      validatedAt: null,
    });
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: stores key and marks validated when probe passes", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("daytona-pat-very-long-token-xx");
    validateDaytonaApiKeySpy.mockResolvedValueOnce({ valid: true });

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: DAYTONA_API_KEY_SECRET }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, DAYTONA_API_KEY_SECRET);
  });

  it("threads DAYTONA_API_URL and DAYTONA_ORGANIZATION_ID env into the probe opts", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("daytona-pat-very-long-token-xx");
    validateDaytonaApiKeySpy.mockResolvedValueOnce({ valid: true });
    // Mirrors `src/setup/non-interactive.test.ts:326-327` — same env vars,
    // same idiom. `vi.unstubAllEnvs()` in `beforeEach` restores afterwards.
    vi.stubEnv("DAYTONA_API_URL", "http://self-hosted/api");
    vi.stubEnv("DAYTONA_ORGANIZATION_ID", "org-xyz");

    await stepConfigureDaytona(deps);

    expect(validateDaytonaApiKeySpy).toHaveBeenCalledWith(
      "daytona-pat-very-long-token-xx",
      expect.objectContaining({ apiUrl: "http://self-hosted/api", organizationId: "org-xyz" }),
    );
  });

  it("falls through with save-anyway=false when validation fails", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("daytona-pat-very-long-token-xx");
    validateDaytonaApiKeySpy.mockResolvedValueOnce({ valid: false, error: "bad" });
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });
});
