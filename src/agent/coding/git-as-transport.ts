/**
 * Host-side git operations for the git-as-transport coding flow (3b.2).
 *
 * The orchestrator pushes a per-task `cogmo/run/<task-id>` ref to the
 * GitHub remote so the managed sandbox can clone it via the Daytona SDK
 * (which only resolves heads/tags refs, not refspecs). After the sandbox
 * pushes the slice-4 feature branch back to origin, the local mirror
 * fetches it so the host's commit graph reflects the result.
 *
 * Lives next to the orchestrator because it's coding-specific
 * (run-branch namespace, identity bundle, slice-4 contract); the
 * transport-agnostic primitives it composes (`runGit`, `withGitAskpass`,
 * `resolveGitHubIdentity`) live in `src/secrets/`.
 */

import type { Transactor } from "../../db/index.js";
import { runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import {
  describeResolveIdentityError,
  type GitHubIdentity,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";

/** Per-task ref namespace under `refs/heads/` on the GitHub remote. */
const RUN_BRANCH_NAMESPACE = "cogmo/run";

/**
 * Compose the run-branch name for a given task id. Full UUID (not the
 * 12-char idShort used for the slice-4 feature branch) so the run-branch
 * never collides with `cogmo/<idShort>` and the orphan-cleanup cron can
 * uniquely map a ref back to a `coding_tasks` row.
 */
export function runBranchFor(taskId: string): string {
  return `${RUN_BRANCH_NAMESPACE}/${taskId}`;
}

export interface PushTaskBranchParams {
  /** `coding_repos.local_path` — the host mirror clone. */
  localRepoPath: string;
  /** HTTPS clone URL — `coding_repos.remote_url`. */
  remoteUrl: string;
  taskId: string;
  /** `coding_repos.default_branch` — captured at `/repo add` time. */
  defaultBranch: string;
  identity: GitHubIdentity;
}

/**
 * Refresh the local mirror's view of `defaultBranch`, then force-push it
 * to `cogmo/run/<task-id>` on origin. The fetch and push share one
 * askpass helper to halve the host-side disk churn for credential
 * material. Force-push semantics are intentional: a retry of a task with
 * an existing run-branch should pick up the latest default-branch tip,
 * not whatever was pushed last time.
 */
export async function pushTaskBranchToRemote(p: PushTaskBranchParams): Promise<void> {
  const runRef = runBranchFor(p.taskId);
  const refSpec = `+refs/remotes/origin/${p.defaultBranch}:refs/heads/${runRef}`;

  await withGitAskpass(p.identity.pat, async (env) => {
    // Refresh first — an N-day-stale mirror would push a stale base
    // commit into the run branch and the sandbox would do its work off
    // old code.
    await runGit(["-C", p.localRepoPath, "fetch", "origin", p.defaultBranch], env);
    await runGit(["-C", p.localRepoPath, "push", p.remoteUrl, refSpec], env);
  });
}

export interface FetchFeatureBranchParams {
  localRepoPath: string;
  remoteUrl: string;
  /** Slice-4 feature branch — `cogmo/<idShort>`. */
  branch: string;
  identity: GitHubIdentity;
}

/**
 * After the sandbox pushes `cogmo/<idShort>` to origin, fetch into the
 * local mirror so the host's commit graph carries the result. Best-
 * effort: origin is the source of truth, and any later operation that
 * needs the feature branch (e.g. a future merge from the host) can fetch
 * again on demand.
 */
export async function fetchFeatureBranch(p: FetchFeatureBranchParams): Promise<void> {
  await withGitAskpass(p.identity.pat, async (env) => {
    await runGit(
      ["-C", p.localRepoPath, "fetch", p.remoteUrl, `+${p.branch}:refs/remotes/origin/${p.branch}`],
      env,
    );
  });
}

export interface LoadIdentityArgs {
  runInTx: Transactor;
  secretsStore: SecretsStore;
  identityName: string;
}

/**
 * Resolve a `github_identity:<name>` row to a validated bundle. Throws
 * with the human-readable message from `describeResolveIdentityError`
 * — the orchestrator catches this at the durability boundary so the
 * task fails fast rather than silently skipping the push.
 */
export async function loadIdentity(args: LoadIdentityArgs): Promise<GitHubIdentity> {
  const result = await args.runInTx((tx) =>
    resolveGitHubIdentity(tx, args.secretsStore, args.identityName),
  );
  if (result.isErr()) {
    throw new Error(describeResolveIdentityError(result.error));
  }
  return result.value;
}
