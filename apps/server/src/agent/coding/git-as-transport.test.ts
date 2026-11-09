import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import {
  fetchDefaultBranchTip,
  fetchFeatureBranch,
  loadIdentity,
  pushTaskBranchToRemote,
  runBranchFor,
} from "./git-as-transport.js";

// Hoisted mock state — `vi.mock` factory references this safely because
// `vi.hoisted` runs before the import side-effect chain.
const { gitMocks, fakeWithGitAskpass } = vi.hoisted(() => {
  type GitAskpass = typeof import("../../secrets/git-askpass.js");
  const fake: GitAskpass["withGitAskpass"] = async (_pat, fn) =>
    fn({ GIT_ASKPASS: "/tmp/fake-helper", GIT_TERMINAL_PROMPT: "0" });
  return {
    fakeWithGitAskpass: fake,
    gitMocks: {
      runGit: vi.fn<GitAskpass["runGit"]>(),
      withGitAskpass: vi.fn(fake),
    },
  };
});

vi.mock("../../secrets/git-askpass.js", () => ({
  runGit: gitMocks.runGit,
  withGitAskpass: gitMocks.withGitAskpass,
}));

const execFileP = promisify(execFile);

/** Run git in `cwd` with a hermetic identity; the trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return stdout.trim();
}

/** Commit `label` on the clone's checked-out branch; the new commit's sha. */
async function commit(clone: string, label: string): Promise<string> {
  await writeFile(join(clone, "file.txt"), `${label}\n`);
  await git(clone, "add", ".");
  await git(clone, "-c", "commit.gpgsign=false", "commit", "-m", label);
  return git(clone, "rev-parse", "HEAD");
}

/** Commit `label` on the clone's main and push it; the new commit's sha. */
async function commitAndPush(clone: string, label: string): Promise<string> {
  const sha = await commit(clone, label);
  await git(clone, "push", "origin", "HEAD:refs/heads/main");
  return sha;
}

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

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("fetchDefaultBranchTip", () => {
  it("fetches the default branch into the mirror and returns the commit it names", async () => {
    gitMocks.runGit.mockReset();
    gitMocks.runGit
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${BASE_SHA}\n`, stderr: "" });
    gitMocks.withGitAskpass.mockClear();

    const tip = await fetchDefaultBranchTip({
      localRepoPath: "/srv/cogmo/repos/example",
      remoteUrl: "https://github.com/owner/example.git",
      defaultBranch: "main",
      identity,
    });

    expect(tip).toBe(BASE_SHA);
    expect(gitMocks.withGitAskpass).toHaveBeenCalledTimes(1);
    expect(gitMocks.withGitAskpass.mock.calls[0]?.[0]).toBe("ghp_test");
    expect(gitMocks.runGit.mock.calls.map(([args]) => args)).toEqual([
      [
        "-C",
        "/srv/cogmo/repos/example",
        "fetch",
        "https://github.com/owner/example.git",
        "+main:refs/remotes/origin/main",
      ],
      [
        "-C",
        "/srv/cogmo/repos/example",
        "rev-parse",
        "--verify",
        "--end-of-options",
        "refs/remotes/origin/main^{commit}",
      ],
    ]);
    // The rev-parse is local: no askpass env.
    expect(gitMocks.runGit.mock.calls[1]?.[1]).toBeUndefined();
  });

  it("propagates a fetch failure without reading a tip", async () => {
    gitMocks.runGit.mockReset();
    gitMocks.runGit.mockRejectedValueOnce(new Error("fetch: network unreachable"));

    await expect(
      fetchDefaultBranchTip({
        localRepoPath: "/srv/cogmo/repos/example",
        remoteUrl: "https://github.com/owner/example.git",
        defaultBranch: "main",
        identity,
      }),
    ).rejects.toThrow(/network unreachable/);
    expect(gitMocks.runGit).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty remoteUrl with a clear operator-facing message", async () => {
    gitMocks.runGit.mockReset();

    await expect(
      fetchDefaultBranchTip({
        localRepoPath: "/var/lib/cogmo/skills",
        remoteUrl: "",
        defaultBranch: "main",
        identity,
      }),
    ).rejects.toThrow(/remote_url is empty/);
    expect(gitMocks.runGit).not.toHaveBeenCalled();
  });
});

describe("pushTaskBranchToRemote", () => {
  const TASK_ID = "019e0df3-be2c-78b2-a392-c19ef36d1ff4";
  let dir: string;
  /** A real mirror, so the presence check reads it; the network ops stay mocked. */
  let mirror: string;
  let held: string;

  beforeEach(async () => {
    gitMocks.runGit.mockReset();
    gitMocks.runGit.mockResolvedValue({ stdout: "", stderr: "" });
    gitMocks.withGitAskpass.mockClear();
    dir = await mkdtemp(join(tmpdir(), "git-as-transport-push-"));
    mirror = join(dir, "mirror");
    await git(dir, "init", "--initial-branch=main", mirror);
    held = await commit(mirror, "held");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function push(baseSha: string) {
    return pushTaskBranchToRemote({
      localRepoPath: mirror,
      remoteUrl: "https://github.com/owner/example.git",
      taskId: TASK_ID,
      defaultBranch: "main",
      baseSha,
      identity,
    });
  }

  it("force-pushes a base the mirror holds to cogmo/run/<task-id>, fetching nothing", async () => {
    const pushed = await push(held);

    expect(pushed.isOk()).toBe(true);
    expect(gitMocks.withGitAskpass).toHaveBeenCalledTimes(1);
    expect(gitMocks.withGitAskpass.mock.calls[0]?.[0]).toBe("ghp_test");
    expect(gitMocks.runGit.mock.calls.map(([args]) => args)).toEqual([
      [
        "-C",
        mirror,
        "push",
        "https://github.com/owner/example.git",
        `+${held}:refs/heads/cogmo/run/${TASK_ID}`,
      ],
    ]);
  });

  it("fetches the run branch, then the default branch the remote lists, for a base the mirror lacks, and errs naming it when still missing", async () => {
    gitMocks.runGit.mockImplementation(async (args) => ({
      stdout: args.includes("ls-remote") ? `${held}\trefs/heads/main\n` : "",
      stderr: "",
    }));

    const pushed = await push(BASE_SHA);

    expect(pushed._unsafeUnwrapErr()).toEqual({ kind: "base_missing", baseSha: BASE_SHA });
    expect(gitMocks.runGit.mock.calls.map(([args]) => args)).toEqual([
      [
        "-C",
        mirror,
        "fetch",
        "https://github.com/owner/example.git",
        `+refs/heads/cogmo/run/${TASK_ID}*:refs/remotes/origin/cogmo/run/${TASK_ID}*`,
      ],
      ["-C", mirror, "ls-remote", "https://github.com/owner/example.git", "refs/heads/main"],
      [
        "-C",
        mirror,
        "fetch",
        "https://github.com/owner/example.git",
        "+main:refs/remotes/origin/main",
      ],
    ]);
    // Every remote operation runs under the askpass env.
    expect(gitMocks.runGit.mock.calls.every(([, env]) => env !== undefined)).toBe(true);
  });

  it("rejects when listing the remote's default branch fails, fetching nothing more", async () => {
    gitMocks.runGit.mockImplementation(async (args) => {
      if (args.includes("ls-remote")) throw new Error("ls-remote: Authentication failed");
      return { stdout: "", stderr: "" };
    });

    await expect(push(BASE_SHA)).rejects.toThrow(/Authentication failed/);
    expect(gitMocks.runGit.mock.calls.map(([args]) => args)).toEqual([
      [
        "-C",
        mirror,
        "fetch",
        "https://github.com/owner/example.git",
        `+refs/heads/cogmo/run/${TASK_ID}*:refs/remotes/origin/cogmo/run/${TASK_ID}*`,
      ],
      ["-C", mirror, "ls-remote", "https://github.com/owner/example.git", "refs/heads/main"],
    ]);
  });

  it("rethrows a failed default-branch fetch when the remote still lists the branch", async () => {
    gitMocks.runGit.mockImplementation(async (args) => {
      if (args.includes("ls-remote")) return { stdout: `${held}\trefs/heads/main\n`, stderr: "" };
      if (args.includes("+main:refs/remotes/origin/main")) {
        throw new Error("fetch: connection reset");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(push(BASE_SHA)).rejects.toThrow(/connection reset/);
    expect(gitMocks.runGit.mock.calls.map(([args]) => args[2])).toEqual([
      "fetch",
      "ls-remote",
      "fetch",
      "ls-remote",
    ]);
  });

  it("rejects with the listing's error when the listing after a failed default-branch fetch fails", async () => {
    let listings = 0;
    gitMocks.runGit.mockImplementation(async (args) => {
      if (args.includes("ls-remote")) {
        listings += 1;
        if (listings === 2) throw new Error("ls-remote: Could not resolve host");
        return { stdout: `${held}\trefs/heads/main\n`, stderr: "" };
      }
      if (args.includes("+main:refs/remotes/origin/main")) {
        throw new Error("fetch: connection reset");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(push(BASE_SHA)).rejects.toThrow(/Could not resolve host/);
    expect(gitMocks.runGit.mock.calls.map(([args]) => args[2])).toEqual([
      "fetch",
      "ls-remote",
      "fetch",
      "ls-remote",
    ]);
  });

  it("rejects when the presence check fails for another reason than a missing commit", async () => {
    await expect(
      pushTaskBranchToRemote({
        localRepoPath: join(dir, "no-such-mirror"),
        remoteUrl: "https://github.com/owner/example.git",
        taskId: TASK_ID,
        defaultBranch: "main",
        baseSha: held,
        identity,
      }),
    ).rejects.toThrow(/no-such-mirror/);
    expect(gitMocks.runGit).not.toHaveBeenCalled();
  });

  it("propagates push failures", async () => {
    gitMocks.runGit.mockRejectedValueOnce(new Error("push: permission denied"));

    await expect(push(held)).rejects.toThrow(/permission denied/);
  });

  it("rejects an empty remoteUrl with a clear operator-facing message", async () => {
    await expect(
      pushTaskBranchToRemote({
        localRepoPath: mirror,
        remoteUrl: "",
        taskId: TASK_ID,
        defaultBranch: "main",
        baseSha: held,
        identity,
      }),
    ).rejects.toThrow(/remote_url is empty/);
    // Guard fires before any git work.
    expect(gitMocks.runGit).not.toHaveBeenCalled();
  });
});

describe("fetchDefaultBranchTip then pushTaskBranchToRemote, against real repositories", () => {
  const taskId = "019e0df3-be2c-78b2-a392-c19ef36d1ff4";
  let dir: string;
  let remote: string;
  let author: string;
  let mirror: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../../secrets/git-askpass.js")>(
      "../../secrets/git-askpass.js",
    );
    gitMocks.runGit.mockReset();
    gitMocks.runGit.mockImplementation(actual.runGit);
    gitMocks.withGitAskpass.mockImplementation(actual.withGitAskpass);
    dir = await mkdtemp(join(tmpdir(), "git-as-transport-test-"));
    remote = join(dir, "remote.git");
    author = join(dir, "author");
    mirror = join(dir, "mirror.git");
    await git(dir, "init", "--bare", "--initial-branch=main", remote);
    await git(dir, "clone", remote, author);
  });

  afterEach(async () => {
    gitMocks.withGitAskpass.mockImplementation(fakeWithGitAskpass);
    await rm(dir, { recursive: true, force: true });
  });

  function push(baseSha: string) {
    return pushTaskBranchToRemote({
      localRepoPath: mirror,
      remoteUrl: remote,
      taskId,
      defaultBranch: "main",
      baseSha,
      identity,
    });
  }

  /** Replace the remote's main with a rewrite of its tip, so the old tip is on no branch. */
  async function rewriteRemoteMain(): Promise<void> {
    await writeFile(join(author, "file.txt"), "rewritten\n");
    await git(author, "-c", "commit.gpgsign=false", "commit", "-am", "rewritten", "--amend");
    await git(author, "push", "--force", "origin", "HEAD:refs/heads/main");
  }

  it("cuts the run branch at the fetched commit after the remote's main moved", async () => {
    await commitAndPush(author, "first");
    await git(dir, "clone", "--bare", remote, mirror);

    const base = await fetchDefaultBranchTip({
      localRepoPath: mirror,
      remoteUrl: remote,
      defaultBranch: "main",
      identity,
    });
    const moved = await commitAndPush(author, "second");
    const pushed = await push(base);

    expect(pushed.isOk()).toBe(true);
    expect(base).not.toBe(moved);
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(moved);
    expect(await git(remote, "rev-parse", `refs/heads/cogmo/run/${taskId}`)).toBe(base);
  });

  it("fetches a saved base the mirror lacks from the remote's main", async () => {
    const base = await commitAndPush(author, "first");
    await git(dir, "init", "--bare", "--initial-branch=main", mirror);

    const pushed = await push(base);

    expect(pushed.isOk()).toBe(true);
    expect(await git(remote, "rev-parse", `refs/heads/cogmo/run/${taskId}`)).toBe(base);
  });

  it("fetches a saved base the remote's rewritten main dropped from the run branch", async () => {
    const base = await commitAndPush(author, "first");
    await git(author, "push", "origin", `${base}:refs/heads/cogmo/run/${taskId}`);
    await rewriteRemoteMain();
    await git(dir, "init", "--bare", "--initial-branch=main", mirror);

    const pushed = await push(base);

    expect(pushed.isOk()).toBe(true);
    expect(await git(mirror, "cat-file", "-t", base)).toBe("commit");
    expect(await git(remote, "rev-parse", `refs/heads/cogmo/run/${taskId}`)).toBe(base);
  });

  it("fetches a saved base from the run branch when the remote's default branch is gone", async () => {
    const base = await commitAndPush(author, "first");
    await git(author, "push", "origin", `${base}:refs/heads/cogmo/run/${taskId}`);
    await git(author, "push", "origin", "HEAD:refs/heads/trunk");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
    await git(author, "push", "origin", "--delete", "main");
    await git(dir, "init", "--bare", "--initial-branch=main", mirror);

    const pushed = await push(base);

    expect(pushed.isOk()).toBe(true);
    expect(await git(remote, "rev-parse", `refs/heads/cogmo/run/${taskId}`)).toBe(base);
  });

  it("errs naming a saved base on neither the mirror nor the run branch when the remote's default branch is gone", async () => {
    const base = await commitAndPush(author, "first");
    await rewriteRemoteMain();
    await git(author, "push", "origin", "HEAD:refs/heads/trunk");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
    await git(author, "push", "origin", "--delete", "main");
    await git(dir, "init", "--bare", "--initial-branch=main", mirror);

    const pushed = await push(base);

    expect(pushed._unsafeUnwrapErr()).toEqual({ kind: "base_missing", baseSha: base });
    await expect(
      git(remote, "rev-parse", "--verify", `refs/heads/cogmo/run/${taskId}`),
    ).rejects.toThrow();
  });

  it("errs naming a saved base the mirror lacks when the remote's default branch is deleted between listing and fetching it", async () => {
    const base = await commitAndPush(author, "first");
    await git(dir, "init", "--bare", "--initial-branch=main", mirror);
    const realRunGit = expectDefined(gitMocks.runGit.getMockImplementation(), "real runGit");
    let deleted = false;
    gitMocks.runGit.mockImplementation(async (...params) => {
      const result = await realRunGit(...params);
      if (params[0].includes("ls-remote") && !deleted) {
        deleted = true;
        await git(remote, "update-ref", "-d", "refs/heads/main");
      }
      return result;
    });

    const pushed = await push(base);

    expect(pushed._unsafeUnwrapErr()).toEqual({ kind: "base_missing", baseSha: base });
    expect(gitMocks.runGit.mock.calls.map(([args]) => args[2])).toEqual([
      "fetch",
      "ls-remote",
      "fetch",
      "ls-remote",
    ]);
    await expect(
      git(remote, "rev-parse", "--verify", `refs/heads/cogmo/run/${taskId}`),
    ).rejects.toThrow();
  });

  it("errs naming a saved base neither the mirror nor the remote holds, and pushes nothing", async () => {
    const base = await commitAndPush(author, "first");
    await rewriteRemoteMain();
    await git(dir, "init", "--bare", "--initial-branch=main", mirror);

    const pushed = await push(base);

    expect(pushed._unsafeUnwrapErr()).toEqual({ kind: "base_missing", baseSha: base });
    await expect(
      git(remote, "rev-parse", "--verify", `refs/heads/cogmo/run/${taskId}`),
    ).rejects.toThrow();
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
