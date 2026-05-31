import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../db/index.js";
import type { GitHubIdentity, GitHubIdentitySecretsLookup } from "../secrets/github.js";
import { gitHubIdentitySecretName } from "../secrets/github.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const VALID_IDENTITY: GitHubIdentity = {
  pat: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK... cogmo",
  login: "cogmo-bot",
  id: "12345",
};

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { collectSkillsRemoteMode, renderConfigureError, readLocalMainSha } = await import(
  "./configure-remote-prompts.js"
);

class StubLookup implements GitHubIdentitySecretsLookup {
  #values = new Map<string, string>();
  set(name: string, value: string): void {
    this.#values.set(name, value);
  }
  async getSecret(_tx: unknown, name: string): Promise<string | undefined> {
    return this.#values.get(name);
  }
}

function lookupWithDefaultIdentity(): StubLookup {
  const l = new StubLookup();
  l.set(gitHubIdentitySecretName("default"), JSON.stringify(VALID_IDENTITY));
  return l;
}

describe("collectSkillsRemoteMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("adopt direction (localMainSha === null)", () => {
    it("includes auto-provision when identity is configured and returns auto-provision choice with identity", async () => {
      const secrets = lookupWithDefaultIdentity();
      vi.mocked(p.select).mockResolvedValueOnce("auto-provision");

      const result = await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        null,
        () => "cancelled" as const,
      );

      expect(result).toEqual({ kind: "auto-provision", identity: VALID_IDENTITY });
      const selectArgs = vi.mocked(p.select).mock.calls[0]?.[0];
      expect(selectArgs?.message).toMatch(/is empty/i);
      // Options surface adopt-flavored language and include all three modes.
      const options = (selectArgs?.options ?? []) as { value: string; label: string }[];
      expect(options.map((o) => o.value)).toEqual(["own", "auto-provision", "skip"]);
      expect(options[0]?.label).toMatch(/adopt/i);
    });

    it("omits auto-provision when identity is missing", async () => {
      const secrets = new StubLookup();
      vi.mocked(p.select).mockResolvedValueOnce("skip");

      const result = await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        null,
        () => "cancelled" as const,
      );

      expect(result).toEqual({ kind: "skip" });
      const selectArgs = vi.mocked(p.select).mock.calls[0]?.[0];
      const options = (selectArgs?.options ?? []) as { value: string }[];
      expect(options.map((o) => o.value)).toEqual(["own", "skip"]);
    });

    it("'own' prompts for URL with adopt-flavored copy, returns trimmed URL", async () => {
      const secrets = lookupWithDefaultIdentity();
      vi.mocked(p.select).mockResolvedValueOnce("own");
      vi.mocked(p.text).mockResolvedValueOnce("  git@github.com:me/cogmo-skills.git  ");

      const result = await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        null,
        () => "cancelled" as const,
      );

      expect(result).toEqual({
        kind: "own",
        direction: "adopt",
        remoteUrl: "git@github.com:me/cogmo-skills.git",
        identity: VALID_IDENTITY,
      });
      const textArgs = vi.mocked(p.text).mock.calls[0]?.[0];
      expect(textArgs?.message).toMatch(/adopt/i);
    });

    it("'own' omits identity when no GitHub identity is configured", async () => {
      const secrets = new StubLookup();
      vi.mocked(p.select).mockResolvedValueOnce("own");
      vi.mocked(p.text).mockResolvedValueOnce("https://example.com/repo.git");

      const result = await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        null,
        () => "cancelled" as const,
      );

      expect(result).toEqual({
        kind: "own",
        direction: "adopt",
        remoteUrl: "https://example.com/repo.git",
      });
    });
  });

  describe("publish direction (localMainSha non-null)", () => {
    it("uses publish-flavored prompt and labels", async () => {
      const secrets = lookupWithDefaultIdentity();
      vi.mocked(p.select).mockResolvedValueOnce("own");
      vi.mocked(p.text).mockResolvedValueOnce("git@github.com:me/repo.git");

      const result = await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        "deadbeef",
        () => "cancelled" as const,
      );

      expect(result).toMatchObject({ kind: "own", direction: "publish" });
      const selectMsg = vi.mocked(p.select).mock.calls[0]?.[0]?.message;
      expect(selectMsg).toMatch(/has commits/i);
      const textMsg = vi.mocked(p.text).mock.calls[0]?.[0]?.message;
      expect(textMsg).toMatch(/publish/i);
    });
  });

  describe("cancellation", () => {
    it("returns onCancel() value when the select prompt is cancelled", async () => {
      const secrets = lookupWithDefaultIdentity();
      vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
      vi.mocked(p.isCancel).mockReturnValueOnce(true);

      const result = await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        null,
        () => "cancelled" as const,
      );
      expect(result).toBe("cancelled");
    });

    it("returns onCancel() value when the URL prompt is cancelled", async () => {
      const secrets = lookupWithDefaultIdentity();
      vi.mocked(p.select).mockResolvedValueOnce("own");
      vi.mocked(p.text).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
      vi.mocked(p.isCancel).mockReturnValueOnce(false); // select did not cancel
      vi.mocked(p.isCancel).mockReturnValueOnce(true); // URL prompt cancelled

      const result = await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        null,
        () => "cancelled" as const,
      );
      expect(result).toBe("cancelled");
    });

    it("propagates a throw from onCancel (wizard-style)", async () => {
      const secrets = lookupWithDefaultIdentity();
      vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
      vi.mocked(p.isCancel).mockReturnValueOnce(true);

      class WizardCancelled extends Error {}
      await expect(
        collectSkillsRemoteMode({ runInTx: fakeRunInTx, secretsStore: secrets }, null, () => {
          throw new WizardCancelled();
        }),
      ).rejects.toBeInstanceOf(WizardCancelled);
    });
  });

  describe("URL validation", () => {
    it("rejects empty URLs via the validate callback", async () => {
      const secrets = lookupWithDefaultIdentity();
      vi.mocked(p.select).mockResolvedValueOnce("own");
      vi.mocked(p.text).mockResolvedValueOnce("anything");

      await collectSkillsRemoteMode(
        { runInTx: fakeRunInTx, secretsStore: secrets },
        null,
        () => "cancelled" as const,
      );

      const validate = vi.mocked(p.text).mock.calls[0]?.[0]?.validate;
      expect(validate?.("")).toBe("URL is required");
      expect(validate?.("   ")).toBe("URL is required");
      expect(validate?.("git@github.com:x/y.git")).toBeUndefined();
    });
  });
});

describe("renderConfigureError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "url_invalid",
      { kind: "url_invalid", remoteUrl: "x", reason: "bad scheme" } as const,
      /Invalid URL: bad scheme/,
    ],
    [
      "remote_unreachable",
      { kind: "remote_unreachable", remoteUrl: "x", reason: "401" } as const,
      /Remote unreachable: 401/,
    ],
    ["remote_empty", { kind: "remote_empty", remoteUrl: "x" } as const, /no `refs\/heads\/main`/],
    ["local_empty", { kind: "local_empty", remoteUrl: "x" } as const, /no commits to publish/],
    [
      "origin_attach_failed",
      { kind: "origin_attach_failed", remoteUrl: "x", reason: "EACCES" } as const,
      /git remote add` failed: EACCES/,
    ],
    [
      "auto_provision_failed (with status)",
      { kind: "auto_provision_failed", reason: "rate limited", status: 429 } as const,
      /Auto-provision failed \(HTTP 429\): rate limited/,
    ],
    [
      "auto_provision_failed (no status)",
      { kind: "auto_provision_failed", reason: "boom" } as const,
      /Auto-provision failed: boom/,
    ],
    [
      "auto_provision_repo_exists",
      { kind: "auto_provision_repo_exists", repoName: "cogmo-skills" } as const,
      /`cogmo-skills` already exists/,
    ],
  ])("formats %s", (_label, error, expected) => {
    renderConfigureError(error);
    expect(vi.mocked(p.log.error)).toHaveBeenCalledWith(expect.stringMatching(expected));
    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringMatching(/Re-run `cogmo setup`/),
    );
  });

  it("formats remote_diverged with truncated shas", () => {
    renderConfigureError({
      kind: "remote_diverged",
      remoteUrl: "x",
      localSha: "abcdef1234567890",
      remoteSha: "fedcba0987654321",
    });
    expect(vi.mocked(p.log.error)).toHaveBeenCalledWith(
      expect.stringMatching(/Local main is abcdef1.*remote main is fedcba0/),
    );
  });

  it("formats local_diverged with truncated shas", () => {
    renderConfigureError({
      kind: "local_diverged",
      remoteUrl: "x",
      localSha: "abcdef1234567890",
      remoteSha: "fedcba0987654321",
    });
    expect(vi.mocked(p.log.error)).toHaveBeenCalledWith(
      expect.stringMatching(/Local main is abcdef1.*remote main is fedcba0/),
    );
  });

  it("remote_unreachable prints an additional info hint about credentials", () => {
    renderConfigureError({ kind: "remote_unreachable", remoteUrl: "x", reason: "n/a" });
    expect(vi.mocked(p.log.info)).toHaveBeenCalledWith(
      expect.stringMatching(/HTTPS URLs, the GitHub identity's PAT/),
    );
  });
});

describe("readLocalMainSha", () => {
  const execFileP = promisify(execFileCb);
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "configure-prompts-test-"));
  });

  it("returns the trimmed sha when refs/heads/main resolves", async () => {
    const repo = join(tmpRoot, "repo");
    await execFileP("git", ["init", "--initial-branch=main", repo]);
    await execFileP("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    await execFileP("git", ["-C", repo, "config", "user.name", "Tester"]);
    await execFileP("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
    await writeFile(join(repo, "README.md"), "x\n");
    await execFileP("git", ["-C", repo, "add", "README.md"]);
    await execFileP("git", ["-C", repo, "commit", "-m", "init"]);

    const sha = await readLocalMainSha(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when refs/heads/main does not exist (unborn HEAD)", async () => {
    const repo = join(tmpRoot, "bare");
    await execFileP("git", ["init", "--bare", repo]);
    const sha = await readLocalMainSha(repo);
    expect(sha).toBeNull();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when the path is not a git repository", async () => {
    const sha = await readLocalMainSha(tmpRoot);
    expect(sha).toBeNull();
    await rm(tmpRoot, { recursive: true, force: true });
  });
});
