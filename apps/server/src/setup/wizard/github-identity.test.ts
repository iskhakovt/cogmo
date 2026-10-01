import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClackValidate } from "../../test/assertions.js";
import { buildWizardDeps, FAKE_TX, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureGitHubIdentity } from "./github-identity.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const { validateGitHubPatSpy } = vi.hoisted(() => ({
  validateGitHubPatSpy: vi.fn(),
}));

vi.mock("../validate.js", () => ({
  validateGitHubPat: validateGitHubPatSpy,
}));

vi.mock("../../secrets/ssh-keygen.js", () => ({
  generateSshKeyPair: vi.fn(() => ({
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-priv\n-----END OPENSSH PRIVATE KEY-----",
    publicKey: "ssh-ed25519 AAAAfake cogmo-bot",
    fingerprint: "SHA256:fake-fingerprint",
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
  validateGitHubPatSpy.mockReset();
});

describe("stepConfigureGitHubIdentity", () => {
  // resolveGitHubIdentity reads via secretsStore.getSecret; we stub by setting
  // the named secret key. gitHubIdentitySecretName("default") = "github_identity:default".
  const IDENTITY_KEY = "github_identity:default";

  it("skips entirely when no existing row AND user declines the optional prompt", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("keeps existing identity when 'keep' is selected", async () => {
    const deps = buildWizardDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: full provision — validates PAT, generates keypair, stores + marks validated", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // proceed with provision
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "cogmo-bot", id: "1234" },
    });
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // SSH key installed confirm

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: IDENTITY_KEY }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, IDENTITY_KEY);
  });

  it("bails when validateGitHubPat fails — no rows written", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("ghp_bad_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({ valid: false, error: "401" });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("bails when validator returns valid but login/id are missing", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("ghp_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({ valid: true, meta: {} });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("'replace' rotates the PAT but reuses the stored signing key", async () => {
    const deps = buildWizardDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "cogmo-bot", id: "1234" },
    });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: IDENTITY_KEY }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, IDENTITY_KEY);
  });

  it("'replace' refuses to swap a PAT for a different login (signature mismatch)", async () => {
    const deps = buildWizardDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "different-account", id: "9999" },
    });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("'regenerate' falls through to full provision", async () => {
    const deps = buildWizardDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("regenerate");
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "cogmo-bot", id: "1234" },
    });
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // SSH installed

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalled();
    expect(deps.secretsStore.markValidated).toHaveBeenCalled();
  });

  it("malformed stored JSON: confirms before overwriting", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecret.mockResolvedValue("{not json"); // resolveGitHubIdentity → malformed_json
    vi.mocked(p.confirm).mockResolvedValueOnce(false); // decline overwrite

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringMatching(/could not be parsed/),
    );
  });

  it("PAT validator rejects short strings", async () => {
    const deps = buildWizardDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("ghp_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "u", id: "1" },
    });
    vi.mocked(p.confirm).mockResolvedValueOnce(true);

    await stepConfigureGitHubIdentity(deps);

    const passCall = vi.mocked(p.password).mock.calls[0]?.[0];
    expect(runClackValidate(passCall?.validate, "")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "ghp_x")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "ghp_long_enough_pat_value")).toBeUndefined();
  });
});
