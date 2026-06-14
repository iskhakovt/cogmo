import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateWorktree, removeWorktree } from "./worktree.js";

const execFileP = promisify(execFile);

const REMOTE_URL = "https://github.com/user/cogmo.git";

let baseDir: string;
let repoPath: string;
let bareRepoPath: string;

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-worktree-test-"));
  repoPath = join(baseDir, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "hello");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);

  // The skills repo registers a BARE repo as `local_path` — cloning from
  // bare must work too.
  bareRepoPath = join(baseDir, "bare-repo.git");
  await execFileP("git", ["clone", "--bare", repoPath, bareRepoPath]);
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function uniqueWorktreePath(): string {
  return join(baseDir, "worktrees", `wt-${Math.random().toString(36).slice(2, 10)}`);
}

function uniqueBranch(): string {
  return `cogmo/${Math.random().toString(36).slice(2, 10)}`;
}

async function headOf(path: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

async function originUrlOf(path: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", path, "remote", "get-url", "origin"]);
  return stdout.trim();
}

/**
 * Recursively collect files under `dir` whose hard-link count exceeds 1.
 * Native walk rather than `find -links +1` so the assertion isn't tied to a
 * platform-specific `find`.
 */
function filesWithMultipleLinks(dir: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...filesWithMultipleLinks(full));
    } else if (entry.isFile() && statSync(full).nlink > 1) {
      hits.push(full);
    }
  }
  return hits;
}

describe("allocateWorktree", () => {
  it("materializes a standalone clone on the branch with origin set to the remote URL", async () => {
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();
    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
    });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    // Self-containment is the contract the task container depends on: a
    // linked worktree's `.git` is a file pointing at a host-absolute
    // gitdir, which doesn't resolve once the tree is bind-mounted at
    // /workspace. A standalone clone keeps `.git` as a directory inside
    // the tree.
    expect(statSync(join(worktreePath, ".git")).isDirectory()).toBe(true);
    expect(await originUrlOf(worktreePath)).toBe(REMOTE_URL);
    await removeWorktree(repoPath, worktreePath);
  });

  it("produces a tree whose git operations work after relocation (container-mount proxy)", async () => {
    // Renaming the tree simulates the container's view: same files,
    // different absolute path. git status/commit must keep working.
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL });

    const movedPath = `${worktreePath}-moved`;
    renameSync(worktreePath, movedPath);
    writeFileSync(join(movedPath, "change.txt"), "edited in container\n");
    await execFileP("git", ["-C", movedPath, "add", "-A"]);
    await execFileP("git", [
      "-C",
      movedPath,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "in-container commit",
    ]);
    expect(await headOf(movedPath)).toBe(branch);
    rmSync(movedPath, { recursive: true, force: true });
  });

  it("clones from a bare parent repo (skills repo case)", async () => {
    const worktreePath = uniqueWorktreePath();
    const branch = uniqueBranch();
    const result = await allocateWorktree({
      repoPath: bareRepoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
    });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    expect(statSync(join(worktreePath, ".git")).isDirectory()).toBe(true);
    await removeWorktree(bareRepoPath, worktreePath);
  });

  it("adopts an existing clone on the right branch (crash recovery)", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL });

    // Re-allocate at the same path / branch — should adopt.
    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
    });
    expect(result.adopted).toBe(true);
    await removeWorktree(repoPath, worktreePath);
  });

  it("replaces a legacy linked worktree at the path with a standalone clone", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    mkdirSync(join(baseDir, "worktrees"), { recursive: true });
    await execFileP("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath]);
    // Linked worktree: `.git` is a file.
    expect(statSync(join(worktreePath, ".git")).isFile()).toBe(true);

    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
    });
    expect(result.adopted).toBe(false);
    expect(statSync(join(worktreePath, ".git")).isDirectory()).toBe(true);
    expect(await headOf(worktreePath)).toBe(branch);
    await removeWorktree(repoPath, worktreePath);
  });

  it("recovers when a stale staging dir is left from a crashed allocation", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    mkdirSync(`${worktreePath}.partial`, { recursive: true });
    writeFileSync(join(`${worktreePath}.partial`, "junk"), "crashed mid-clone");

    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
    });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    expect(existsSync(`${worktreePath}.partial`)).toBe(false);
    await removeWorktree(repoPath, worktreePath);
  });

  it("throws when an existing clone is on the wrong branch", async () => {
    const branchA = uniqueBranch();
    const branchB = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch: branchA, worktreePath, remoteUrl: REMOTE_URL });
    await expect(
      allocateWorktree({ repoPath, branch: branchB, worktreePath, remoteUrl: REMOTE_URL }),
    ).rejects.toThrow(/expected/);
    await removeWorktree(repoPath, worktreePath);
  });

  it("throws when the path exists but is not a git working tree", async () => {
    const worktreePath = uniqueWorktreePath();
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "junk"), "not a working tree");
    const branch = uniqueBranch();
    await expect(
      allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL }),
    ).rejects.toThrow(/not a git working tree/);
  });

  it("creates the parent directory if it does not exist", async () => {
    const branch = uniqueBranch();
    const worktreePath = join(baseDir, "deep", "nested", "wt", branch.replace(/\//g, "-"));
    const result = await allocateWorktree({
      repoPath,
      branch,
      worktreePath,
      remoteUrl: REMOTE_URL,
    });
    expect(result.adopted).toBe(false);
    await removeWorktree(repoPath, worktreePath);
  });

  it("does not hardlink objects into the parent repo (inode isolation)", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL });
    // Every object file in the clone must have link count 1 — a hardlinked
    // object would share an inode with the parent repo, letting an
    // in-container write corrupt host state.
    expect(filesWithMultipleLinks(join(worktreePath, ".git", "objects"))).toEqual([]);
    await removeWorktree(repoPath, worktreePath);
  });
});

describe("removeWorktree", () => {
  it("removes an existing clone", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath, remoteUrl: REMOTE_URL });
    await removeWorktree(repoPath, worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("is a no-op when the path does not exist", async () => {
    await expect(removeWorktree(repoPath, "/no/such/path")).resolves.toBeUndefined();
  });

  it("prunes legacy linked-worktree metadata so the path can be re-allocated", async () => {
    const branch = uniqueBranch();
    const worktreePath = uniqueWorktreePath();
    mkdirSync(join(baseDir, "worktrees"), { recursive: true });
    await execFileP("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath]);

    await removeWorktree(repoPath, worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
    // Without the prune, the parent repo's stale `worktrees/<name>`
    // registration would block `git worktree add` at the same path; the
    // clone path doesn't care, but the metadata shouldn't accumulate.
    const { stdout } = await execFileP("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
    expect(stdout).not.toContain(worktreePath);
  });
});
