import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { GitHubIdentity } from "../../secrets/github.js";
import { teardownWorktree } from "./teardown.js";
import { allocateWorktree } from "./worktree.js";

const execFileP = promisify(execFile);

// Real git, real bare remote — no testcontainers, no PAT validation.
// File:// remotes accept any GIT_ASKPASS output without checking, so the
// dummy identity below exercises the code path without needing a working
// credential.
const FAKE_IDENTITY: GitHubIdentity = {
  pat: "ghp_test_token_unused_against_local_remote",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA stub",
  login: "cogmo-bot",
  id: "1",
};

let baseDir: string;
let repoPath: string;
let bareRemote: string;

async function setupRepoWithRemote(): Promise<{ repoPath: string; bareRemote: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cogmo-teardown-test-"));
  const repo = join(dir, "repo");
  const bare = join(dir, "bare.git");

  await execFileP("git", ["init", "--bare", bare]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await execFileP("git", ["-C", repo, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repo, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await execFileP("git", ["-C", repo, "add", "."]);
  await execFileP("git", ["-C", repo, "commit", "-m", "init"]);
  await execFileP("git", ["-C", repo, "remote", "add", "origin", bare]);
  await execFileP("git", ["-C", repo, "push", "origin", "main"]);

  baseDir = dir;
  return { repoPath: repo, bareRemote: bare };
}

beforeEach(async () => {
  ({ repoPath, bareRemote } = await setupRepoWithRemote());
});

afterAll(() => {
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

function uniqueTaskId(): string {
  return `019d0000-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
}

function uniqueBranch(taskId: string): string {
  return `cogmo/${taskId.slice(-8)}`;
}

function uniqueWorktreePath(): string {
  return join(baseDir, "worktrees", `wt-${Math.random().toString(36).slice(2, 10)}`);
}

async function refExists(remote: string, ref: string): Promise<boolean> {
  try {
    await execFileP("git", ["--git-dir", remote, "rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

describe("teardownWorktree", () => {
  it("returns no_worktree when the path doesn't exist", async () => {
    const result = await teardownWorktree({
      repoPath,
      worktreePath: "/no/such/path",
      branch: "cogmo/none",
      taskId: uniqueTaskId(),
    });
    expect(result.kind).toBe("no_worktree");
  });

  it("leaves the path re-allocatable when the working tree dir is gone", async () => {
    // Models a host crash mid-teardown: the working tree was deleted out
    // of band. Teardown reports no_worktree and a later allocation at the
    // same path succeeds.
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    // Delete the working tree directly without notifying teardown.
    rmSync(worktreePath, { recursive: true, force: true });

    const result = await teardownWorktree({ repoPath, worktreePath, branch, taskId });
    expect(result.kind).toBe("no_worktree");

    const newBranch = uniqueBranch(uniqueTaskId());
    await expect(
      allocateWorktree({ repoPath, branch: newBranch, worktreePath, remoteUrl: bareRemote }),
    ).resolves.toBeDefined();
  });

  it("removes a clean worktree without pushing anything", async () => {
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    // Push the branch from the clone so HEAD matches origin/<branch> —
    // this is the "clean, pushed" terminal state we expect on happy
    // paths. The push also updates the clone's remote-tracking ref,
    // which is what `hasUnpushedCommits` reads.
    await execFileP("git", ["-C", worktreePath, "push", "origin", branch]);

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: FAKE_IDENTITY,
    });
    expect(result.kind).toBe("removed_clean");
    expect(await refExists(bareRemote, `refs/cogmo-wip/${taskId}`)).toBe(false);
  });

  it("WIP-pushes a dirty worktree and removes it", async () => {
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: FAKE_IDENTITY,
    });
    expect(result.kind).toBe("wip_pushed_and_removed");
    if (result.kind !== "wip_pushed_and_removed") throw new Error("type guard");
    expect(result.wipRef).toBe(`refs/cogmo-wip/${taskId}`);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await refExists(bareRemote, `refs/cogmo-wip/${taskId}`)).toBe(true);
  });

  it("WIP-pushes when the branch has unpushed commits but no dirty files", async () => {
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    writeFileSync(join(worktreePath, "feature.ts"), "export const foo = 1;\n");
    await execFileP("git", ["-C", worktreePath, "add", "."]);
    await execFileP("git", [
      "-C",
      worktreePath,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "feat: add foo",
    ]);
    // Worktree is now clean but has one local-only commit.

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: FAKE_IDENTITY,
    });
    expect(result.kind).toBe("wip_pushed_and_removed");
    expect(await refExists(bareRemote, `refs/cogmo-wip/${taskId}`)).toBe(true);
  });

  it("returns wip_push_failed_kept when no identity is supplied for a dirty worktree", async () => {
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      // identity omitted
    });
    expect(result.kind).toBe("wip_push_failed_kept");
    if (result.kind !== "wip_push_failed_kept") throw new Error("type guard");
    expect(result.reason).toMatch(/no GitHub identity/);
    // Worktree must still exist — the work wasn't lost.
    expect(await import("node:fs").then((fs) => fs.existsSync(worktreePath))).toBe(true);
  });

  it("returns wip_push_failed_kept when the remote rejects the push", async () => {
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    writeFileSync(join(worktreePath, "in-progress.ts"), "// claude was here\n");
    // Point the worktree's origin at a nonexistent path so push fails fast.
    await execFileP("git", [
      "-C",
      worktreePath,
      "remote",
      "set-url",
      "origin",
      "/no/such/remote.git",
    ]);

    const result = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: FAKE_IDENTITY,
    });
    expect(result.kind).toBe("wip_push_failed_kept");
    expect(await import("node:fs").then((fs) => fs.existsSync(worktreePath))).toBe(true);
  });

  it("is idempotent: a second call after removed_clean returns no_worktree", async () => {
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    await execFileP("git", ["-C", worktreePath, "push", "origin", branch]);

    const first = await teardownWorktree({ repoPath, worktreePath, branch, taskId });
    expect(first.kind).toBe("removed_clean");

    const second = await teardownWorktree({ repoPath, worktreePath, branch, taskId });
    expect(second.kind).toBe("no_worktree");
  });

  it("re-running on the same task overwrites the WIP ref (force push semantics)", async () => {
    // Models the orchestrator-retry case: teardown fired once, host crashed
    // before removing, host restarts, teardown fires again on the same task
    // id. The WIP ref namespace is per-task, so `--force` lands on the same
    // ref without conflict.
    const taskId = uniqueTaskId();
    const branch = uniqueBranch(taskId);
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    writeFileSync(join(worktreePath, "in-progress.ts"), "// first\n");

    const first = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: FAKE_IDENTITY,
    });
    expect(first.kind).toBe("wip_pushed_and_removed");

    // Re-allocate at the same path, dirty again, re-teardown.
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: bareRemote });
    writeFileSync(join(worktreePath, "in-progress.ts"), "// second\n");
    const second = await teardownWorktree({
      repoPath,
      worktreePath,
      branch,
      taskId,
      identity: FAKE_IDENTITY,
    });
    expect(second.kind).toBe("wip_pushed_and_removed");
    expect(await refExists(bareRemote, `refs/cogmo-wip/${taskId}`)).toBe(true);
  });
});
