import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_OAUTH_TOKEN_SECRET } from "../../agent/coding/auth.js";
import { runClackValidate } from "../../test/assertions.js";
import { buildWizardDeps, FAKE_TX, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureClaudeCodeAuth } from "./claude-code-auth.js";
import { WizardCancelled } from "./step.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const { validateClaudeCodeOauthTokenSpy } = vi.hoisted(() => ({
  validateClaudeCodeOauthTokenSpy: vi.fn(),
}));

vi.mock("../validate.js", () => ({
  validateClaudeCodeOauthToken: validateClaudeCodeOauthTokenSpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
  validateClaudeCodeOauthTokenSpy.mockReset();
});

describe("stepConfigureClaudeCodeAuth", () => {
  it("skips when no existing token AND user declines the prompt", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("keeps existing token when 'keep' is selected", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecretMeta.mockResolvedValue({
      id: "s-1",
      name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
      description: "",
      validatedAt: null,
    });
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: stores trimmed token and marks validated when validation passes", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("  sk-ant-oauth-very-long-token-xx\n");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: true });

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
        plaintext: "sk-ant-oauth-very-long-token-xx",
      }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(
      FAKE_TX,
      CLAUDE_CODE_OAUTH_TOKEN_SECRET,
    );
  });

  it("stores token without markValidated when validation fails but user opts to save anyway", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial proceed
    vi.mocked(p.password).mockResolvedValueOnce("sk-this-is-also-long-enough-yes");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: false, error: "401" });
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // save anyway

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalled();
    expect(deps.secretsStore.markValidated).not.toHaveBeenCalled();
  });

  it("skips the write entirely when validation fails AND user declines save-anyway", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial proceed
    vi.mocked(p.password).mockResolvedValueOnce("sk-this-is-also-long-enough-yes");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: false, error: "401" });
    vi.mocked(p.confirm).mockResolvedValueOnce(false); // save anyway → no

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("rejects short tokens via the validator callback", async () => {
    const deps = buildWizardDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("sk-long-enough-token-for-test");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: true });

    await stepConfigureClaudeCodeAuth(deps);

    const passCall = vi.mocked(p.password).mock.calls[0]?.[0];
    expect(runClackValidate(passCall?.validate, "")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "short")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "sk-this-is-long-enough-for-real")).toBeUndefined();
  });

  it("throws WizardCancelled when select is cancelled", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecretMeta.mockResolvedValue({
      id: "s-1",
      name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
      description: "",
      validatedAt: null,
    });
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(true);

    await expect(stepConfigureClaudeCodeAuth(deps)).rejects.toBeInstanceOf(WizardCancelled);
  });
});
