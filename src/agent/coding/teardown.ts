/**
 * Worktree teardown for failure / cancel cascades.
 *
 * Implements the policy from `design/coding-delegation.md` § "Worktree
 * persistence (teardown table)":
 *
 *   | State             | Action                                              |
 *   |-------------------|-----------------------------------------------------|
 *   | Clean, no commits | `git worktree remove`                                |
 *   | Dirty or unpushed | `git add -A` → `git commit -m "wip: <id>"` →         |
 *   |                   | `git push --force origin HEAD:refs/cogmo-wip/<id>` → |
 *   |                   | `git worktree remove`                                |
 *   | Push fails        | Keep worktree (preserve work for manual recovery)    |
 *
 * Resume reverses: `git fetch origin refs/cogmo-wip/<id>:wip-<id>` →
 * `git worktree add <path> wip-<id>` → `git reset --soft HEAD~1` to
 * unstage the WIP commit and continue editing.
 *
 * The bootstrap "no remote yet" case (tar fallback per design line 263)
 * is deferred — it never arises for repos registered via `/repo add`,
 * which always have a remote URL. If a no-remote repo is ever
 * supported, that branch lands here.
 *
 * **Runs on the host.** The worktree is bind-mounted into the container
 * but lives on the host filesystem; the container is being torn down
 * concurrently, so the teardown can't run inside it. Auth uses the
 * host-side `withGitAskpass` from `src/secrets/git-askpass.ts`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import {
  describeResolveIdentityError,
  type GitHubIdentity,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { CodingRepoRow } from "./store/index.js";
import type { HostPathWorktreeAssignment, WorktreeAssignment } from "./types.js";
import { removeWorktree } from "./worktree.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "coding.teardown" });

export interface TeardownWorktreeOpts {
  /** Path to the parent git clone (`coding_repos.local_path`). */
  repoPath: string;
  /** Host filesystem path of the worktree to tear down. */
  worktreePath: string;
  /** Task branch (e.g. `cogmo/abc12345`). */
  branch: string;
  /** Task UUID — embedded in WIP commit message + ref namespace. */
  taskId: string;
  /**
   * GitHub identity for WIP push. When omitted, dirty/unpushed worktrees
   * stay on disk (the caller decided not to attempt a push). The clean
   * case still removes.
   */
  identity?: GitHubIdentity;
  /** Git remote name. Defaults to `origin`. */
  remoteName?: string;
}

export type TeardownResult =
  | { kind: "no_worktree" }
  | { kind: "removed_clean" }
  | { kind: "wip_pushed_and_removed"; wipRef: string; sha: string }
  | { kind: "wip_push_failed_kept"; reason: string };

/**
 * Tear down a worktree on a failure / cancel path. Idempotent: re-running
 * after `removed_clean` returns `no_worktree`. WIP push uses
 * `--force HEAD:refs/cogmo-wip/<taskId>` so retries land on the same ref
 * (the namespace is per-task, so `--force` is safe).
 */
export async function teardownWorktree(opts: TeardownWorktreeOpts): Promise<TeardownResult> {
  const { repoPath, worktreePath, branch, taskId, identity, remoteName = "origin" } = opts;

  if (!existsSync(worktreePath)) {
    // Even when the path is gone, the parent repo's `.git/worktrees/<name>`
    // metadata can linger from a prior crashed teardown. `removeWorktree`
    // detects the missing path and falls back to `git worktree prune`,
    // clearing the stale entry so a later `allocateWorktree` at the same
    // path doesn't fail with "already registered".
    await removeWorktree(repoPath, worktreePath);
    return { kind: "no_worktree" };
  }

  const dirty = await isDirty(worktreePath);
  const unpushed = await hasUnpushedCommits(worktreePath, branch, remoteName);

  if (!dirty && !unpushed) {
    log.info({ taskId, worktreePath }, "teardown: clean — removing worktree");
    await removeWorktree(repoPath, worktreePath);
    return { kind: "removed_clean" };
  }

  if (!identity) {
    log.warn(
      { taskId, worktreePath, dirty, unpushed },
      "teardown: dirty/unpushed worktree but no identity supplied — keeping",
    );
    return {
      kind: "wip_push_failed_kept",
      reason: "no GitHub identity available for WIP push",
    };
  }

  try {
    if (dirty) {
      await git(worktreePath, ["add", "-A"]);
      // WIP commits are forensic, never merged. Skip signing (the user
      // hasn't approved this state). Use a self-contained author so the
      // commit doesn't fail when no global git config is set on the host.
      await git(worktreePath, [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.email=cogmo-bot@noreply.local",
        "-c",
        "user.name=Cogmo (WIP)",
        "commit",
        "--allow-empty",
        "-m",
        `wip: ${taskId}`,
      ]);
    }

    const { stdout: shaOut } = await execFileP("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
    const sha = shaOut.trim();
    const wipRef = `refs/cogmo-wip/${taskId}`;

    await withGitAskpass(identity.pat, async (env) => {
      await runGit(["-C", worktreePath, "push", "--force", remoteName, `HEAD:${wipRef}`], env);
    });

    log.info({ taskId, worktreePath, wipRef, sha }, "teardown: WIP pushed, removing worktree");
    await removeWorktree(repoPath, worktreePath);
    return { kind: "wip_pushed_and_removed", wipRef, sha };
  } catch (err) {
    const reason = (err as Error).message;
    log.warn(
      { err, taskId, worktreePath, dirty, unpushed },
      "teardown: WIP push failed — keeping worktree for manual recovery",
    );
    return { kind: "wip_push_failed_kept", reason };
  }
}

async function isDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileP("git", ["-C", worktreePath, "status", "--porcelain"]);
  return stdout.trim().length > 0;
}

async function hasUnpushedCommits(
  worktreePath: string,
  branch: string,
  remoteName: string,
): Promise<boolean> {
  // The remote tracking ref `refs/remotes/<remote>/<branch>` is what
  // git updates after a successful fetch / push. If it doesn't exist
  // the branch was never pushed — treat as unpushed.
  try {
    const { stdout: localHead } = await execFileP("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
    const { stdout: remoteHead } = await execFileP("git", [
      "-C",
      worktreePath,
      "rev-parse",
      `refs/remotes/${remoteName}/${branch}`,
    ]);
    return localHead.trim() !== remoteHead.trim();
  } catch {
    return true;
  }
}

async function git(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  await execFileP("git", ["-C", cwd, ...args]);
}

/**
 * Best-effort wrapper around {@link teardownWorktree} for failure / cancel
 * cascades. Loads the GitHub identity (for the WIP push) when a
 * `secretsStore` is provided; on resolve failure, falls through with no
 * identity so the worktree stays on disk per `wip_push_failed_kept`.
 *
 * Never throws — teardown is cleanup, not the operation that failed.
 * The caller wraps in `step.run` for observability + exactly-once
 * semantics under Inngest replay; `--force` push semantics on the WIP
 * ref namespace make the operation idempotent regardless.
 */
export async function safeTeardownWorktree(opts: {
  /** Required — identity lookup decrypts a secret, which needs a tx. */
  runInTx: Transactor;
  secretsStore?: SecretsStore;
  repo: CodingRepoRow;
  taskId: string;
  worktreeAssignment: WorktreeAssignment;
  /** Optional pre-resolved identity — if supplied, secretsStore is ignored. */
  identity?: GitHubIdentity;
}): Promise<void> {
  if (opts.worktreeAssignment.type !== "host-path") {
    // git-remote assignments have no host worktree to tear down — the
    // sandbox owns the only checkout, and the run-branch on origin is
    // garbage-collected by the orphan-run-branch cron.
    log.info(
      { taskId: opts.taskId, type: opts.worktreeAssignment.type },
      "teardown-worktree: no host worktree for transport — skipping",
    );
    return;
  }
  const assignment: HostPathWorktreeAssignment = opts.worktreeAssignment;
  try {
    let identity: GitHubIdentity | undefined = opts.identity;
    if (!identity && opts.secretsStore) {
      const secretsStore = opts.secretsStore;
      // resolveGitHubIdentity can throw on a DB-level failure
      // (`secretsStore.getSecret` underlying error) — keep it inside the
      // try block so `safeTeardownWorktree` actually honors its "never
      // throws" contract.
      const result = await opts.runInTx((tx) =>
        resolveGitHubIdentity(tx, secretsStore, opts.repo.identityName),
      );
      if (result.isOk()) {
        identity = result.value;
      } else {
        log.warn(
          { taskId: opts.taskId, reason: describeResolveIdentityError(result.error) },
          "teardown-worktree: identity resolve failed — proceeding without WIP push",
        );
      }
    }
    const r = await teardownWorktree({
      repoPath: opts.repo.localPath,
      worktreePath: assignment.worktreePath,
      branch: assignment.branch,
      taskId: opts.taskId,
      ...(identity !== undefined && { identity }),
    });
    log.info({ taskId: opts.taskId, kind: r.kind }, "teardown-worktree complete");
  } catch (err) {
    log.warn({ err, taskId: opts.taskId }, "teardown-worktree threw — ignoring");
  }
}
