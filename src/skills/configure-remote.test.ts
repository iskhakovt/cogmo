import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { Transactor } from "../db/index.js";
import type { GitHubIdentity } from "../secrets/github.js";
import { configureSkillsRemote } from "./configure-remote.js";
import { bootstrapSkillsRepo } from "./repo.js";

const execFileP = promisify(execFile);

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const FAKE_IDENTITY: GitHubIdentity = {
  pat: "ghp_test",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
  sshPublicKey: "ssh-ed25519 AAAA fake",
  login: "test-user",
  id: "1",
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "configure-remote-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Make a bare repo at `<workDir>/owner/repo.git` so the resulting
 * `file:///.../owner/repo.git` URL passes `parseRemoteUrl`'s owner/repo
 * segment check. Returns the URL.
 */
async function makePopulatedRemote(): Promise<string> {
  const remotePath = join(workDir, "owner", "repo.git");
  await mkdir(dirname(remotePath), { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", remotePath]);
  // Bare repos can't commit directly — clone, commit, push.
  const work = join(workDir, "work");
  await execFileP("git", ["init", "-b", "main", work]);
  await execFileP("git", ["-C", work, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", work, "config", "user.name", "t"]);
  await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
  await execFileP("git", ["-C", work, "commit", "--allow-empty", "-m", "init"]);
  await execFileP("git", ["-C", work, "push", remotePath, "main:refs/heads/main"]);
  await rm(work, { recursive: true, force: true });
  return `file://${remotePath}`;
}

async function makeEmptyRemote(): Promise<string> {
  const remotePath = join(workDir, "owner", "empty.git");
  await mkdir(dirname(remotePath), { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", remotePath]);
  return `file://${remotePath}`;
}

async function readOrigin(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

function setupStoreWithNoRow(): CodingStore {
  const store = mock<CodingStore>();
  store.getRepoByName.mockResolvedValue(undefined);
  store.insertRepo.mockImplementation(async (_tx, params) => ({
    id: "00000000-0000-0000-0000-000000000001",
    name: params.name,
    localPath: params.localPath,
    defaultBranch: params.defaultBranch,
    remoteUrl: params.remoteUrl,
    devcontainer: params.devcontainer,
    allowedBackends: [...params.allowedBackends],
    verifyCommand: params.verifyCommand,
    verifyTimeoutSeconds: params.verifyTimeoutSeconds ?? 600,
    taskTokenBudget: params.taskTokenBudget,
    taskWallTimeSeconds: params.taskWallTimeSeconds,
    maxConcurrentTasks: params.maxConcurrentTasks,
    identityName: params.identityName ?? "default",
    createdAt: new Date(),
  }));
  return store;
}

describe("configureSkillsRemote", () => {
  it("skip is a logged no-op — no DB or git work", async () => {
    const codingStore = mock<CodingStore>();
    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: join(workDir, "skills") },
      { kind: "skip" },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.kind).toBe("skipped");
    expect(codingStore.getRepoByName).not.toHaveBeenCalled();
  });

  it("own rejects empty URL before touching the bare repo", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore: setupStoreWithNoRow(), skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl: "   " },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("url_invalid");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own rejects unparseable URL", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore: setupStoreWithNoRow(), skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl: "not-a-git-url" },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("url_invalid");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own refuses an empty remote with no refs/heads/main", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeEmptyRemote();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore: setupStoreWithNoRow(), skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_empty");
    // No partial state — origin must still be unset.
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own attaches origin and inserts the DB row when the remote has main", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makePopulatedRemote();
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.remoteUrl).toBe(remoteUrl);
      expect(result.value.originAction).toBe("attached");
      expect(result.value.ensured.kind).toBe("created");
    }
    expect(await readOrigin(skillsPath)).toBe(remoteUrl);
    expect(codingStore.insertRepo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "skills", remoteUrl }),
    );
  });

  it("own updates origin via `git remote set-url` when target differs from current", async () => {
    // Two populated remotes; attach the first, then call configure with the
    // second. Origin must point at the second; the DB row's `remote_url`
    // must be UPDATED (not re-inserted), because the row already existed.
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const firstUrl = await makePopulatedRemote();
    // Second remote in a different owner/repo path so parseRemoteUrl
    // distinguishes them.
    const secondRemote = join(workDir, "owner2", "repo.git");
    await mkdir(dirname(secondRemote), { recursive: true });
    await execFileP("git", ["init", "--bare", "--initial-branch=main", secondRemote]);
    const seed = join(workDir, "seed");
    await execFileP("git", ["init", "-b", "main", seed]);
    await execFileP("git", ["-C", seed, "config", "user.email", "t@t"]);
    await execFileP("git", ["-C", seed, "config", "user.name", "t"]);
    await execFileP("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
    await execFileP("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"]);
    await execFileP("git", ["-C", seed, "push", secondRemote, "main:refs/heads/main"]);
    await rm(seed, { recursive: true, force: true });
    const secondUrl = `file://${secondRemote}`;

    // Pre-attach the first URL via the helper so we're in the same state
    // production would be after a prior wizard run, then swap.
    const codingStore = mock<CodingStore>();
    let storedRow: Awaited<ReturnType<CodingStore["insertRepo"]>> | undefined;
    codingStore.getRepoByName.mockImplementation(async () => storedRow);
    codingStore.insertRepo.mockImplementation(async (_tx, params) => {
      storedRow = {
        id: "00000000-0000-0000-0000-000000000001",
        name: params.name,
        localPath: params.localPath,
        defaultBranch: params.defaultBranch,
        remoteUrl: params.remoteUrl,
        devcontainer: params.devcontainer,
        allowedBackends: [...params.allowedBackends],
        verifyCommand: params.verifyCommand,
        verifyTimeoutSeconds: params.verifyTimeoutSeconds ?? 600,
        taskTokenBudget: params.taskTokenBudget,
        taskWallTimeSeconds: params.taskWallTimeSeconds,
        maxConcurrentTasks: params.maxConcurrentTasks,
        identityName: params.identityName ?? "default",
        createdAt: new Date(),
      };
      return storedRow;
    });
    codingStore.updateRepoRemoteUrl.mockImplementation(async (_tx, id, remoteUrl) => {
      if (storedRow && storedRow.id === id) storedRow = { ...storedRow, remoteUrl };
    });

    // Attach first URL.
    await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl: firstUrl },
    );
    expect(await readOrigin(skillsPath)).toBe(firstUrl);

    // Swap to second URL — this is the path the test covers.
    const swap = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl: secondUrl },
    );

    expect(swap.isOk()).toBe(true);
    if (swap.isOk() && swap.value.kind === "configured") {
      expect(swap.value.remoteUrl).toBe(secondUrl);
      expect(swap.value.originAction).toBe("updated");
      expect(swap.value.ensured.kind).toBe("updated");
    }
    expect(await readOrigin(skillsPath)).toBe(secondUrl);
    expect(codingStore.updateRepoRemoteUrl).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000001",
      secondUrl,
    );
  });

  it("own returns remote_unreachable for a parseable URL pointing at nothing", async () => {
    // parseRemoteUrl accepts the URL (owner/repo segments present), but
    // `git ls-remote` against a nonexistent file:// path fails — the helper
    // must surface that as `remote_unreachable`, not `url_invalid` or
    // `remote_empty`. Distinguishes "you typo'd the URL shape" from "the
    // URL is fine but unreachable."
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const nonexistent = `file://${join(workDir, "owner", "does-not-exist.git")}`;

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore: setupStoreWithNoRow(), skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl: nonexistent },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_unreachable");
    // Origin must not have been attached — half-state would be worse than
    // the clean error.
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own is idempotent — second invocation with same URL yields unchanged", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makePopulatedRemote();

    // First pass: insert. Track the row in a closure so the second pass
    // sees it as already-present, matching the production round-trip.
    let storedRow: Awaited<ReturnType<CodingStore["insertRepo"]>> | undefined;
    const codingStore = mock<CodingStore>();
    codingStore.getRepoByName.mockImplementation(async () => storedRow);
    codingStore.insertRepo.mockImplementation(async (_tx, params) => {
      storedRow = {
        id: "00000000-0000-0000-0000-000000000001",
        name: params.name,
        localPath: params.localPath,
        defaultBranch: params.defaultBranch,
        remoteUrl: params.remoteUrl,
        devcontainer: params.devcontainer,
        allowedBackends: [...params.allowedBackends],
        verifyCommand: params.verifyCommand,
        verifyTimeoutSeconds: params.verifyTimeoutSeconds ?? 600,
        taskTokenBudget: params.taskTokenBudget,
        taskWallTimeSeconds: params.taskWallTimeSeconds,
        maxConcurrentTasks: params.maxConcurrentTasks,
        identityName: params.identityName ?? "default",
        createdAt: new Date(),
      };
      return storedRow;
    });

    const first = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl },
    );
    expect(first.isOk()).toBe(true);

    const second = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", remoteUrl },
    );

    expect(second.isOk()).toBe(true);
    if (second.isOk() && second.value.kind === "configured") {
      expect(second.value.originAction).toBe("unchanged");
      expect(second.value.ensured.kind).toBe("unchanged");
    }
    expect(codingStore.insertRepo).toHaveBeenCalledTimes(1);
    expect(codingStore.updateRepoRemoteUrl).not.toHaveBeenCalled();
  });

  it("auto-provision surfaces auto_provision_repo_exists on 422", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const { RequestError } = await import("@octokit/request-error");

    const fakeOctokit = {
      repos: {
        createForAuthenticatedUser: vi.fn().mockImplementation(async () => {
          throw new RequestError("Validation failed", 422, {
            response: {
              status: 422,
              url: "https://api.github.com/user/repos",
              headers: {},
              data: {},
            },
            request: { method: "POST", url: "https://api.github.com/user/repos", headers: {} },
          });
        }),
      },
    };

    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        codingStore: setupStoreWithNoRow(),
        skillsRepoPath: skillsPath,
        // Partial Octokit stub — only `createForAuthenticatedUser` is exercised.
        octokitFactory: () => fakeOctokit as unknown as Octokit,
      },
      { kind: "auto-provision", identity: FAKE_IDENTITY },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.kind === "auto_provision_repo_exists") {
      expect(result.error.repoName).toBe("cogmo-skills");
    }
    expect(fakeOctokit.repos.createForAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(await readOrigin(skillsPath)).toBeNull();
  });
});
