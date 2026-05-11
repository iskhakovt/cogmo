import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import {
  fetchFeatureBranch,
  loadIdentity,
  pushTaskBranchToRemote,
  runBranchFor,
} from "./git-as-transport.js";

// Hoisted mock state — `vi.mock` factory references this safely because
// `vi.hoisted` runs before the import side-effect chain.
const gitMocks = vi.hoisted(() => ({
  runGit: vi.fn<(args: ReadonlyArray<string>, env: unknown) => Promise<unknown>>(),
  withGitAskpass: vi.fn(
    async (
      _pat: string,
      fn: (env: { GIT_ASKPASS: string; GIT_TERMINAL_PROMPT: "0" }) => Promise<unknown>,
    ) => fn({ GIT_ASKPASS: "/tmp/fake-helper", GIT_TERMINAL_PROMPT: "0" }),
  ),
}));

vi.mock("../../secrets/git-askpass.js", () => ({
  runGit: gitMocks.runGit,
  withGitAskpass: gitMocks.withGitAskpass,
}));

const FAKE_TX = { __mockTx: true };
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX as never);

const identity: GitHubIdentity = {
  pat: "ghp_test",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA",
  login: "cogmo-bot",
  id: "12345",
};

describe("runBranchFor", () => {
  it("namespaces task ids under cogmo/run/", () => {
    expect(runBranchFor("019e0df3-be2c-78b2-a392-c19ef36d1ff4")).toBe(
      "cogmo/run/019e0df3-be2c-78b2-a392-c19ef36d1ff4",
    );
  });

  it("does not collide with the slice-4 cogmo/<idShort> feature-branch shape", () => {
    // Slice-4 feature branches match `^cogmo/[a-f0-9]{12}$`. Run-branches
    // must escape that pattern so the orphan-cleanup cron can map a ref
    // back to a `coding_tasks` row uniquely.
    const taskId = "019e0df3-be2c-78b2-a392-c19ef36d1ff4";
    expect(runBranchFor(taskId)).not.toMatch(/^cogmo\/[a-f0-9]{12}$/);
  });
});

describe("pushTaskBranchToRemote", () => {
  it("fetches the default branch then force-pushes to cogmo/run/<task-id>", async () => {
    gitMocks.runGit.mockReset();
    gitMocks.runGit.mockResolvedValue({ stdout: "", stderr: "" });
    gitMocks.withGitAskpass.mockClear();

    await pushTaskBranchToRemote({
      localRepoPath: "/srv/cogmo/repos/example",
      remoteUrl: "https://github.com/owner/example.git",
      taskId: "019e0df3-be2c-78b2-a392-c19ef36d1ff4",
      defaultBranch: "main",
      identity,
    });

    expect(gitMocks.withGitAskpass).toHaveBeenCalledTimes(1);
    expect(gitMocks.withGitAskpass.mock.calls[0]?.[0]).toBe("ghp_test");
    expect(gitMocks.runGit).toHaveBeenCalledTimes(2);
    expect(gitMocks.runGit.mock.calls[0]?.[0]).toEqual([
      "-C",
      "/srv/cogmo/repos/example",
      "fetch",
      "https://github.com/owner/example.git",
      "+main:refs/remotes/origin/main",
    ]);
    expect(gitMocks.runGit.mock.calls[1]?.[0]).toEqual([
      "-C",
      "/srv/cogmo/repos/example",
      "push",
      "https://github.com/owner/example.git",
      "+refs/remotes/origin/main:refs/heads/cogmo/run/019e0df3-be2c-78b2-a392-c19ef36d1ff4",
    ]);
  });

  it("propagates fetch failures (push is skipped when fetch fails)", async () => {
    gitMocks.runGit.mockReset();
    gitMocks.runGit
      .mockRejectedValueOnce(new Error("fetch: network unreachable"))
      .mockResolvedValue({ stdout: "", stderr: "" });

    await expect(
      pushTaskBranchToRemote({
        localRepoPath: "/srv/cogmo/repos/example",
        remoteUrl: "https://github.com/owner/example.git",
        taskId: "t",
        defaultBranch: "main",
        identity,
      }),
    ).rejects.toThrow(/network unreachable/);
    expect(gitMocks.runGit).toHaveBeenCalledTimes(1);
  });

  it("propagates push failures (fetch already succeeded — error surfaces from push)", async () => {
    gitMocks.runGit.mockReset();
    gitMocks.runGit
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("push: non-fast-forward"));

    await expect(
      pushTaskBranchToRemote({
        localRepoPath: "/srv/cogmo/repos/example",
        remoteUrl: "https://github.com/owner/example.git",
        taskId: "t",
        defaultBranch: "main",
        identity,
      }),
    ).rejects.toThrow(/non-fast-forward/);
    expect(gitMocks.runGit).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty remoteUrl with a clear operator-facing message", async () => {
    gitMocks.runGit.mockReset();

    await expect(
      pushTaskBranchToRemote({
        localRepoPath: "/var/lib/cogmo/skills",
        remoteUrl: "",
        taskId: "t",
        defaultBranch: "main",
        identity,
      }),
    ).rejects.toThrow(/remote_url is empty/);
    // Guard fires before any git work.
    expect(gitMocks.runGit).not.toHaveBeenCalled();
  });
});

describe("fetchFeatureBranch", () => {
  // Both the bareness rev-parse and the network-touching fetch flow
  // through the same `runGit` mock now (the helper unified onto the
  // single primitive — see the "Bareness check" comment in
  // git-as-transport.ts). Tests sequence the two calls explicitly with
  // mockResolvedValueOnce so the assertion against `mock.calls[1]`
  // pins the fetch refspec without depending on path-based heuristics.
  function setBarenessAndFetch(isBare: boolean) {
    gitMocks.runGit.mockReset();
    gitMocks.runGit
      .mockResolvedValueOnce({ stdout: isBare ? "true\n" : "false\n", stderr: "" })
      .mockResolvedValue({ stdout: "", stderr: "" });
    gitMocks.withGitAskpass.mockClear();
  }

  it("fetches the feature branch into refs/remotes/origin/<branch> for non-bare mirrors", async () => {
    setBarenessAndFetch(false);

    await fetchFeatureBranch({
      localRepoPath: "/srv/cogmo/repos/example",
      remoteUrl: "https://github.com/owner/example.git",
      branch: "cogmo/abc123",
      identity,
    });

    expect(gitMocks.withGitAskpass).toHaveBeenCalledTimes(1);
    expect(gitMocks.runGit).toHaveBeenCalledTimes(2);
    expect(gitMocks.runGit.mock.calls[0]?.[0]).toEqual([
      "-C",
      "/srv/cogmo/repos/example",
      "rev-parse",
      "--is-bare-repository",
    ]);
    // Bareness check is local-only — no askpass env passed (single-arg call).
    expect(gitMocks.runGit.mock.calls[0]?.[1]).toBeUndefined();
    expect(gitMocks.runGit.mock.calls[1]?.[0]).toEqual([
      "-C",
      "/srv/cogmo/repos/example",
      "fetch",
      "https://github.com/owner/example.git",
      "+cogmo/abc123:refs/remotes/origin/cogmo/abc123",
    ]);
  });

  it("fetches into refs/heads/<branch> for bare repos (skills library path)", async () => {
    // The bare-repo branch is what closes the Daytona bridge for skills:
    // `register_skill` reads `refs/heads/<branch>` from `$COGMO_SKILLS_PATH`,
    // so a fetch into `refs/remotes/origin/*` would strand the author's work.
    setBarenessAndFetch(true);

    await fetchFeatureBranch({
      localRepoPath: "/var/lib/cogmo/skills",
      remoteUrl: "https://github.com/owner/skills.git",
      branch: "skill/hn-digest-2026-05-11",
      identity,
    });

    expect(gitMocks.withGitAskpass).toHaveBeenCalledTimes(1);
    expect(gitMocks.runGit).toHaveBeenCalledTimes(2);
    expect(gitMocks.runGit.mock.calls[1]?.[0]).toEqual([
      "-C",
      "/var/lib/cogmo/skills",
      "fetch",
      "https://github.com/owner/skills.git",
      "+skill/hn-digest-2026-05-11:refs/heads/skill/hn-digest-2026-05-11",
    ]);
  });

  it("propagates fetch failures (caller surfaces the error to the durable step)", async () => {
    gitMocks.runGit.mockReset();
    gitMocks.runGit
      .mockResolvedValueOnce({ stdout: "false\n", stderr: "" }) // bareness
      .mockRejectedValue(new Error("fetch: connection reset"));

    await expect(
      fetchFeatureBranch({
        localRepoPath: "/srv/cogmo/repos/example",
        remoteUrl: "https://github.com/owner/example.git",
        branch: "cogmo/abc123",
        identity,
      }),
    ).rejects.toThrow(/connection reset/);
  });

  it("rejects an empty remoteUrl with a clear operator-facing message", async () => {
    gitMocks.runGit.mockReset();

    await expect(
      fetchFeatureBranch({
        localRepoPath: "/var/lib/cogmo/skills",
        remoteUrl: "",
        branch: "skill/foo",
        identity,
      }),
    ).rejects.toThrow(/remote_url is empty/);
    // Guard fires before any git work — no rev-parse, no fetch.
    expect(gitMocks.runGit).not.toHaveBeenCalled();
  });
});

describe("loadIdentity", () => {
  it("returns the resolved identity bundle on success", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue(JSON.stringify(identity));

    const result = await loadIdentity({
      runInTx: fakeRunInTx,
      secretsStore,
      identityName: "default",
    });
    expect(result.pat).toBe("ghp_test");
    expect(secretsStore.getSecret).toHaveBeenCalledWith(
      expect.anything(),
      "github_identity:default",
    );
  });

  it("throws a human-readable error when the identity is missing", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue(undefined);

    await expect(
      loadIdentity({
        runInTx: fakeRunInTx,
        secretsStore,
        identityName: "default",
      }),
    ).rejects.toThrow(/GitHub identity 'default' is not configured/);
  });

  it("throws when the stored secret is corrupt JSON", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue("not-json");

    await expect(
      loadIdentity({
        runInTx: fakeRunInTx,
        secretsStore,
        identityName: "default",
      }),
    ).rejects.toThrow(/corrupt/);
  });

  it("throws with a schema-mismatch message when JSON parses but Zod fails", async () => {
    const secretsStore = mock<SecretsStore>();
    // Valid JSON, valid keys, but `pat` empty — fails the `min(1)` constraint.
    secretsStore.getSecret.mockResolvedValue(JSON.stringify({ ...identity, pat: "" }));

    await expect(
      loadIdentity({
        runInTx: fakeRunInTx,
        secretsStore,
        identityName: "default",
      }),
    ).rejects.toThrow(/malformed/);
  });
});
