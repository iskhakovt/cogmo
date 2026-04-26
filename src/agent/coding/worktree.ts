import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { logger } from "../../logger.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "coding.worktree" });

export interface AllocateWorktreeParams {
  /** Path to the parent git clone (the `coding_repos.local_path` registry value). */
  repoPath: string;
  /** Branch name to create or check out (e.g. `cogmo/abc123de`). */
  branch: string;
  /** Host filesystem path where the worktree should live. */
  worktreePath: string;
}

export interface AllocateWorktreeResult {
  /** True if we adopted an existing worktree on the right branch (crash-recovery happy path). */
  adopted: boolean;
}

/**
 * Idempotent reconcile per design/coding-delegation.md → "Inngest step
 * boundaries → allocate-worktree". Three cases:
 *
 *   1. Worktree path already exists, is a git worktree, HEAD = `branch` →
 *      adopt and return. (Inngest crash between `worktree add` and the DB
 *      update; the worktree is already there.)
 *   2. Branch already exists in the parent repo but no worktree at the
 *      target path → `git worktree add <path> <branch>` (re-attach).
 *   3. Neither → `git worktree add -b <branch> <path>` (fresh).
 *
 * The first case is what makes the step safe to retry. Without it the raw
 * `git worktree add` would error on "path already exists" and the retry
 * would fail forever.
 */
export async function allocateWorktree(
  params: AllocateWorktreeParams,
): Promise<AllocateWorktreeResult> {
  const { repoPath, branch, worktreePath } = params;
  await mkdir(dirname(worktreePath), { recursive: true });

  // Case 1: adopt an existing worktree on the right branch.
  if (existsSync(worktreePath)) {
    const isWorktree = await isInsideWorkTree(worktreePath);
    if (isWorktree) {
      const head = await currentBranch(worktreePath);
      if (head === branch) {
        log.info({ worktreePath, branch }, "adopting existing worktree");
        return { adopted: true };
      }
      throw new Error(
        `worktree path ${worktreePath} exists with branch ${head ?? "<detached>"}, expected ${branch}`,
      );
    }
    throw new Error(
      `worktree path ${worktreePath} exists but is not a git worktree — refusing to overwrite`,
    );
  }

  // Case 2 vs 3: branch may already exist in the parent repo (from a prior
  // crashed attempt). `git worktree add <path> <branch>` re-attaches; with
  // `-b` the same call would fail because the branch is taken. Resolve by
  // probing first.
  const branchExists = await refExists(repoPath, `refs/heads/${branch}`);
  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath];
  log.info({ worktreePath, branch, branchExists }, "creating worktree");
  await git(repoPath, args);
  return { adopted: false };
}

/**
 * Remove a worktree (best effort — used in teardown). `--force` covers
 * dirty worktrees that the supervisor decided not to preserve.
 *
 * When the worktree directory is already gone but git still tracks it in
 * `.git/worktrees/<name>` (typical after a container crash that wiped the
 * mount), `worktree remove` fails with "worktree is locked" or "worktree
 * is missing" — `worktree prune` cleans up the stale metadata instead.
 * Without this, a later `allocateWorktree` at the same path would fail.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) {
    // Path is gone — fall back to prune to clear any stale metadata.
    await git(repoPath, ["worktree", "prune"]).catch((err) => {
      log.warn({ err: (err as Error).message, worktreePath }, "git worktree prune failed");
    });
    return;
  }
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch((err) => {
    log.warn({ err: (err as Error).message, worktreePath }, "git worktree remove failed");
  });
}

async function isInsideWorkTree(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function currentBranch(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
    const ref = stdout.trim();
    return ref === "HEAD" ? null : ref;
  } catch {
    return null;
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await execFileP("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileP("git", ["-C", cwd, ...args]);
}
