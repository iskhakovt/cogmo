import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateWorktree, removeWorktree } from "./worktree.js";

const execFileP = promisify(execFile);

let baseDir: string;
let repoPath: string;

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
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function uniqueWorktreePath(): string {
  return join(baseDir, "worktrees", `wt-${Math.random().toString(36).slice(2, 10)}`);
}

async function headOf(path: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

describe("allocateWorktree", () => {
  it("creates a fresh worktree and branch when neither exists", async () => {
    const worktreePath = uniqueWorktreePath();
    const branch = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    const result = await allocateWorktree({ repoPath, branch, worktreePath });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    await removeWorktree(repoPath, worktreePath);
  });

  it("re-attaches when the branch already exists but no worktree", async () => {
    const branch = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    // Create the branch first (no worktree).
    await execFileP("git", ["-C", repoPath, "branch", branch]);

    const worktreePath = uniqueWorktreePath();
    const result = await allocateWorktree({ repoPath, branch, worktreePath });
    expect(result.adopted).toBe(false);
    expect(await headOf(worktreePath)).toBe(branch);
    await removeWorktree(repoPath, worktreePath);
  });

  it("adopts an existing worktree on the right branch (crash recovery)", async () => {
    const branch = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath });

    // Re-allocate at the same path / branch — should adopt.
    const result = await allocateWorktree({ repoPath, branch, worktreePath });
    expect(result.adopted).toBe(true);
    await removeWorktree(repoPath, worktreePath);
  });

  it("throws when an existing worktree is on the wrong branch", async () => {
    const branchA = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    const branchB = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch: branchA, worktreePath });
    await expect(allocateWorktree({ repoPath, branch: branchB, worktreePath })).rejects.toThrow(
      /expected/,
    );
    await removeWorktree(repoPath, worktreePath);
  });

  it("throws when the path exists but is not a git worktree", async () => {
    const worktreePath = uniqueWorktreePath();
    await execFileP("mkdir", ["-p", worktreePath]);
    writeFileSync(join(worktreePath, "junk"), "not a worktree");
    const branch = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    await expect(allocateWorktree({ repoPath, branch, worktreePath })).rejects.toThrow(
      /not a git worktree/,
    );
  });

  it("creates the parent directory if it does not exist", async () => {
    const branch = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    const worktreePath = join(baseDir, "deep", "nested", "wt", branch.replace(/\//g, "-"));
    const result = await allocateWorktree({ repoPath, branch, worktreePath });
    expect(result.adopted).toBe(false);
    await removeWorktree(repoPath, worktreePath);
  });
});

describe("removeWorktree", () => {
  it("removes an existing worktree", async () => {
    const branch = `cogmo/${Math.random().toString(36).slice(2, 10)}`;
    const worktreePath = uniqueWorktreePath();
    await allocateWorktree({ repoPath, branch, worktreePath });
    await removeWorktree(repoPath, worktreePath);
    await expect(headOf(worktreePath)).rejects.toThrow();
  });

  it("is a no-op when the path does not exist", async () => {
    await expect(removeWorktree(repoPath, "/no/such/path")).resolves.toBeUndefined();
  });
});
