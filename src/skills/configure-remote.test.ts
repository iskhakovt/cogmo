import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * Make a bare repo at `<workDir>/<subdir>/repo.git` with one seed commit on
 * `main`. The `file:///.../<subdir>/repo.git` URL parses cleanly via
 * `parseRemoteUrl`. Returns the URL.
 */
async function makePopulatedRemote(subdir = "owner"): Promise<string> {
  const remotePath = join(workDir, subdir, "repo.git");
  await mkdir(dirname(remotePath), { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", remotePath]);
  // Bare repos can't commit directly — seed via a temp working clone.
  const work = await mkdtemp(join(tmpdir(), "configure-remote-seed-"));
  try {
    await execFileP("git", ["init", "-b", "main", work]);
    await execFileP("git", ["-C", work, "config", "user.email", "t@t"]);
    await execFileP("git", ["-C", work, "config", "user.name", "t"]);
    await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
    await execFileP("git", ["-C", work, "commit", "--allow-empty", "-m", "init"]);
    await execFileP("git", ["-C", work, "push", remotePath, "main:refs/heads/main"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return `file://${remotePath}`;
}

async function makeEmptyRemote(subdir = "owner", name = "empty.git"): Promise<string> {
  const remotePath = join(workDir, subdir, name);
  await mkdir(dirname(remotePath), { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", remotePath]);
  return `file://${remotePath}`;
}

/**
 * Seed the skills bare repo with a commit on `refs/heads/main` —
 * exercises the "local populated" half of the direction state machine.
 *
 * Done via `git update-ref` (not `git push`) because the production
 * `pre-receive` hook installed by `bootstrapSkillsRepo` rejects direct
 * pushes to main: production `register` uses `update-ref` for the same
 * reason. The temp working clone first pushes objects under a throwaway
 * ref the hook allows, then update-ref points main at the same SHA on
 * the bare repo's filesystem.
 */
async function seedSkillsBare(skillsPath: string, message = "local commit"): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "configure-remote-skillsseed-"));
  try {
    await execFileP("git", ["init", "-b", "main", work]);
    await execFileP("git", ["-C", work, "config", "user.email", "t@t"]);
    await execFileP("git", ["-C", work, "config", "user.name", "t"]);
    await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
    await writeFile(join(work, "marker.txt"), message);
    await execFileP("git", ["-C", work, "add", "."]);
    await execFileP("git", ["-C", work, "commit", "-m", message]);
    const { stdout } = await execFileP("git", ["-C", work, "rev-parse", "HEAD"]);
    const sha = stdout.trim();
    // Upload objects under a throwaway non-main ref — the hook rejects
    // direct pushes to main but accepts new refs elsewhere.
    const stagingRef = `refs/heads/__test-seed-${process.pid}-${Math.random()
      .toString(36)
      .slice(2)}`;
    await execFileP("git", ["-C", work, "push", skillsPath, `HEAD:${stagingRef}`]);
    // Now point main at the same SHA via filesystem update-ref —
    // production `register` does the same thing for the same reason.
    await execFileP("git", ["-C", skillsPath, "update-ref", "refs/heads/main", sha]);
    // Clean up the staging ref. `git update-ref -d` on the bare repo
    // bypasses the hook (which only fires on update of main); deleting a
    // non-main ref via filesystem-level update-ref is unconstrained.
    await execFileP("git", ["-C", skillsPath, "update-ref", "-d", stagingRef]);
    return sha;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function readOrigin(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readMainSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "refs/heads/main",
    ]);
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
      { kind: "own", direction: "adopt", remoteUrl: "   " },
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
      { kind: "own", direction: "adopt", remoteUrl: "not-a-git-url" },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("url_invalid");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + adopt refuses an empty remote", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeEmptyRemote();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore: setupStoreWithNoRow(), skillsRepoPath: skillsPath },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_empty");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + publish refuses when local is empty", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makeEmptyRemote();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore: setupStoreWithNoRow(), skillsRepoPath: skillsPath },
      { kind: "own", direction: "publish", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("local_empty");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + adopt fetches into an empty local from a populated remote", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makePopulatedRemote();
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.remoteUrl).toBe(remoteUrl);
      expect(result.value.direction).toBe("adopt");
      expect(result.value.originAction).toBe("attached");
      expect(result.value.ensured.kind).toBe("created");
    }
    expect(await readOrigin(skillsPath)).toBe(remoteUrl);
    expect(await readMainSha(skillsPath)).not.toBeNull();
    expect(codingStore.insertRepo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "skills", remoteUrl }),
    );
  });

  it("own + publish pushes a populated local to an empty remote", async () => {
    // Operator has local skills + fresh empty remote: publish must push
    // local to remote, not fetch. Asserts the data-loss-free direction
    // for the populated-local case.
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const localSha = await seedSkillsBare(skillsPath);
    const remoteUrl = await makeEmptyRemote();
    const remotePath = remoteUrl.replace("file://", "");
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", direction: "publish", remoteUrl },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.direction).toBe("publish");
      expect(result.value.originAction).toBe("attached");
      expect(result.value.ensured.kind).toBe("created");
    }
    expect(await readOrigin(skillsPath)).toBe(remoteUrl);
    // Crux: the remote received the local SHA — no data loss, and local
    // wasn't overwritten by a fetch.
    expect(await readMainSha(remotePath)).toBe(localSha);
    expect(await readMainSha(skillsPath)).toBe(localSha);
  });

  it("own + adopt refuses to overwrite divergent local commits (remote_diverged)", async () => {
    // Local has commits; remote has unrelated commits. Adopt would
    // orphan local. The fast-forward fetch must refuse and leave local
    // main untouched — the safety property the diverged variant exists
    // to enforce.
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const localSha = await seedSkillsBare(skillsPath, "local-only commit");
    const remoteUrl = await makePopulatedRemote(); // unrelated history
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_diverged");
    // Local main MUST be untouched — that's the whole point of the safety
    // check. The original force-fetch implementation would have left local
    // at the remote's SHA here, orphaning `localSha`.
    expect(await readMainSha(skillsPath)).toBe(localSha);
  });

  it("own + publish refuses to overwrite divergent remote commits (local_diverged)", async () => {
    // The inverse of remote_diverged: local and remote have unrelated
    // histories, operator selects publish. Pushing would orphan the
    // remote's commits. Helper must refuse, remote must be untouched.
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    await seedSkillsBare(skillsPath, "local-only commit");
    const remoteUrl = await makePopulatedRemote();
    const remotePath = remoteUrl.replace("file://", "");
    const remoteShaBefore = await readMainSha(remotePath);
    const codingStore = setupStoreWithNoRow();

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", direction: "publish", remoteUrl },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("local_diverged");
    // Remote main is untouched.
    expect(await readMainSha(remotePath)).toBe(remoteShaBefore);
  });

  it("own returns remote_unreachable for a parseable URL pointing at nothing", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const nonexistent = `file://${join(workDir, "owner", "does-not-exist.git")}`;

    const result = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore: setupStoreWithNoRow(), skillsRepoPath: skillsPath },
      { kind: "own", direction: "adopt", remoteUrl: nonexistent },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("remote_unreachable");
    expect(await readOrigin(skillsPath)).toBeNull();
  });

  it("own + adopt is idempotent — second invocation with same URL yields unchanged", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const remoteUrl = await makePopulatedRemote();

    // Track storedRow in a closure so the second pass sees the inserted row.
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
      { kind: "own", direction: "adopt", remoteUrl },
    );
    expect(first.isOk()).toBe(true);

    // Second pass: local now has main matching remote. Adopt still works
    // because fast-forward fetch is a no-op when local already equals
    // remote.
    const second = await configureSkillsRemote(
      { runInTx: fakeRunInTx, codingStore, skillsRepoPath: skillsPath },
      { kind: "own", direction: "adopt", remoteUrl },
    );

    expect(second.isOk()).toBe(true);
    if (second.isOk() && second.value.kind === "configured") {
      expect(second.value.originAction).toBe("unchanged");
      expect(second.value.ensured.kind).toBe("unchanged");
    }
    expect(codingStore.insertRepo).toHaveBeenCalledTimes(1);
    expect(codingStore.updateRepoRemoteUrl).not.toHaveBeenCalled();
  });

  it("auto-provision picks adopt + auto_init:true when local is empty", async () => {
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    // Pre-create the "GitHub repo" Cogmo will think it created, with a
    // README seed (mirrors `auto_init: true` server-side behavior).
    const remoteUrl = await makePopulatedRemote("github-stub");

    const createSpy = vi.fn().mockResolvedValue({ data: { clone_url: remoteUrl } });
    const fakeOctokit = { repos: { createForAuthenticatedUser: createSpy } };

    const codingStore = setupStoreWithNoRow();
    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        codingStore,
        skillsRepoPath: skillsPath,
        octokitFactory: () => fakeOctokit as unknown as Octokit,
      },
      { kind: "auto-provision", identity: FAKE_IDENTITY },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.direction).toBe("adopt");
    }
    // Cogmo asked for a seeded repo (auto_init: true) so it has main to
    // adopt — the data-loss-free fresh-install path.
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cogmo-skills", auto_init: true, private: true }),
    );
  });

  it("auto-provision picks publish + auto_init:false when local has commits", async () => {
    // Local already has skills. Auto-provision must NOT request a
    // README-seeded remote that would overwrite local main — Cogmo asks
    // GitHub for an empty repo and pushes local to it instead. Asserts
    // both the `auto_init:false` API call shape and the post-condition
    // (local SHA survives + lands on the remote).
    const skillsPath = join(workDir, "skills.git");
    await bootstrapSkillsRepo({ path: skillsPath });
    const localSha = await seedSkillsBare(skillsPath, "operator's local skill");
    const remoteUrl = await makeEmptyRemote("github-stub", "fresh.git");
    const remotePath = remoteUrl.replace("file://", "");

    const createSpy = vi.fn().mockResolvedValue({ data: { clone_url: remoteUrl } });
    const fakeOctokit = { repos: { createForAuthenticatedUser: createSpy } };

    const codingStore = setupStoreWithNoRow();
    const result = await configureSkillsRemote(
      {
        runInTx: fakeRunInTx,
        codingStore,
        skillsRepoPath: skillsPath,
        octokitFactory: () => fakeOctokit as unknown as Octokit,
      },
      { kind: "auto-provision", identity: FAKE_IDENTITY },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.kind === "configured") {
      expect(result.value.direction).toBe("publish");
    }
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cogmo-skills", auto_init: false, private: true }),
    );
    // Local skill survives + remote received the push — no data loss.
    expect(await readMainSha(skillsPath)).toBe(localSha);
    expect(await readMainSha(remotePath)).toBe(localSha);
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
