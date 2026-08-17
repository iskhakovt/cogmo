import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../../logger.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "coding.worktree" });

export interface AllocateWorktreeParams {
  /** Path to the parent git clone (the `coding_repos.local_path` registry value). */
  repoPath: string;
  /** Branch name to create or check out (e.g. `cogmo/abc123de`). */
  branch: string;
  /** Host filesystem path where the working tree should live. */
  worktreePath: string;
  /**
   * Remote URL (`coding_repos.remote_url`) installed as `origin` on the
   * materialized clone. In-container `git push origin <branch>` and the
   * host-side WIP teardown both resolve `origin` from the clone's own
   * config, so it must point at the real remote, not at `repoPath`.
   */
  remoteUrl: string;
}

export interface AllocateWorktreeResult {
  /** True if we adopted an existing clone on the right branch (crash-recovery happy path). */
  adopted: boolean;
}

/**
 * Materialize the task's working tree as a STANDALONE clone of the parent
 * repo — never a linked `git worktree`. A linked worktree's `.git` is a
 * file pointing at an absolute gitdir inside the parent repo; bind-mounted
 * at `/workspace` in the task container (where the parent repo doesn't
 * exist) every git command dies with "not a git repository". A standalone
 * clone carries its whole `.git` directory inside the tree, so it works at
 * any mount path — the same shape the Daytona backend gets from cloning
 * inside the sandbox.
 *
 * Mounting the parent repo's `.git` into the container instead would fix
 * the path but hand the sandboxed task write access to state that
 * host-side git (teardown, prune) later executes — config and hooks — so
 * the clone is also the isolation-preserving choice.
 *
 * `--no-hardlinks` keeps the isolation story complete: a default local
 * clone hardlinks object files, sharing inodes with the parent repo, and
 * an in-container write through a shared inode would corrupt the host's
 * objects.
 *
 * Idempotent reconcile per design/coding-delegation.md → "Inngest step
 * boundaries → allocate-worktree". Three cases:
 *
 *   1. A standalone clone already exists at the path with HEAD = `branch`
 *      → adopt and return. (Inngest crash between materialization and the
 *      DB update; the clone is already there.)
 *   2. A legacy linked worktree exists at the path (its `.git` is a file)
 *      → remove it and re-materialize as a clone. Linked worktrees never
 *      worked in the container, so there's nothing in one worth keeping.
 *   3. Nothing at the path → fresh clone.
 *
 * Materialization stages into `<path>.partial` and finishes with an atomic
 * rename, so a crash mid-clone never leaves a half-built tree at the final
 * path — retries either adopt a complete clone or start over.
 */
export async function allocateWorktree(
  params: AllocateWorktreeParams,
): Promise<AllocateWorktreeResult> {
  const { repoPath, branch, worktreePath, remoteUrl } = params;
  await mkdir(dirname(worktreePath), { recursive: true });

  const existing = await classifyPath(worktreePath);
  if (existing === "clone") {
    const head = await currentBranch(worktreePath);
    if (head === branch) {
      log.info({ worktreePath, branch }, "adopting existing clone");
      return { adopted: true };
    }
    throw new Error(
      `worktree path ${worktreePath} exists with branch ${head ?? "<detached>"}, expected ${branch}`,
    );
  }
  if (existing === "linked") {
    // A linked worktree at this path predates the clone-based
    // materialization and is unusable in the container — replace it.
    log.warn({ worktreePath, branch }, "replacing legacy linked worktree with standalone clone");
    await rm(worktreePath, { recursive: true, force: true });
    await pruneWorktreeMetadata(repoPath, worktreePath);
  } else if (existing === "non-git") {
    throw new Error(
      `worktree path ${worktreePath} exists but is not a git working tree — refusing to overwrite`,
    );
  }

  const staging = stagingPathFor(worktreePath);
  await rm(staging, { recursive: true, force: true });
  log.info({ worktreePath, branch }, "materializing standalone clone");
  await execFileP("git", ["clone", "--no-hardlinks", repoPath, staging]);
  // `-B` rather than `-b`: the parent repo may carry this branch from a
  // crashed prior attempt (it gets copied into the clone's refs), and the
  // task always starts from the parent's HEAD tip anyway.
  await git(staging, ["checkout", "-B", branch]);
  await git(staging, ["remote", "set-url", "origin", remoteUrl]);
  await rename(staging, worktreePath);
  return { adopted: false };
}

/**
 * Remove a task working tree (best effort — used in teardown). The clone
 * is fully self-contained, so removal is a plain recursive delete of the
 * tree plus any staging directory a crashed allocation left behind.
 *
 * The parent repo can still hold `worktrees/<name>` metadata from the
 * legacy linked-worktree era; `git worktree prune` clears it so a later
 * `allocateWorktree` at the same path isn't blocked by a stale
 * registration. No-op on repos with no worktree metadata.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  // `force` only swallows ENOENT. A process still writing inside the tree —
  // git's own background maintenance is the usual one, and it is suppressed at
  // the source in teardown, but a sandbox process on a bind mount can do it
  // too — makes the walk fail with ENOTEMPTY on whichever directory it was
  // mid-way through. Retries let the delete outlast a writer that is finishing
  // up; without them the tree is left half-removed, and because the failure is
  // logged rather than raised, the next allocation at this path is the first
  // thing that notices.
  const retry = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;
  await rm(worktreePath, retry).catch((err) => {
    log.warn({ err: (err as Error).message, worktreePath }, "failed to remove working tree");
  });
  await rm(stagingPathFor(worktreePath), retry).catch((err) => {
    log.warn({ err: (err as Error).message, worktreePath }, "failed to remove staging dir");
  });
  await pruneWorktreeMetadata(repoPath, worktreePath);
}

function stagingPathFor(worktreePath: string): string {
  return `${worktreePath}.partial`;
}

type PathClass =
  /** Nothing at the path — fresh clone. */
  | "absent"
  /** `.git` is a directory — a standalone clone (adopt or wrong-branch). */
  | "clone"
  /** `.git` is a file — a legacy linked worktree, unusable in-container. */
  | "linked"
  /** Path exists but holds no `.git` — refuse to overwrite. */
  | "non-git";

/**
 * Classify what (if anything) occupies `worktreePath`. Async `stat` rather
 * than the sync variants so a concurrent allocation doesn't block the event
 * loop. One stat on the path, one on its `.git`.
 */
async function classifyPath(worktreePath: string): Promise<PathClass> {
  try {
    await stat(worktreePath);
  } catch {
    return "absent";
  }
  try {
    const gitEntry = await stat(join(worktreePath, ".git"));
    return gitEntry.isDirectory() ? "clone" : "linked";
  } catch {
    return "non-git";
  }
}

async function pruneWorktreeMetadata(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "prune"]).catch((err) => {
    log.warn({ err: (err as Error).message, worktreePath }, "git worktree prune failed");
  });
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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileP("git", ["-C", cwd, ...args]);
}
