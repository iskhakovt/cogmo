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
 * to `cogmo/run/<task-id>` on the remote. The fetch and push share one
 * askpass helper to halve the host-side disk churn for credential
 * material. Force-push semantics are intentional: a retry of a task with
 * an existing run-branch should pick up the latest default-branch tip,
 * not whatever was pushed last time.
 *
 * Both ops address the remote by URL (not by mirror-side remote name)
 * and use explicit refspecs — symmetric with `fetchFeatureBranch`, and
 * decouples the helper from whatever name `git remote` happens to use
 * locally. The fetch refspec writes `refs/remotes/origin/<defaultBranch>`
 * explicitly so the push refspec on the next line resolves regardless
 * of the mirror's remote configuration.
 *
 * Inherits — does not enforce — single-writer-per-task semantics. Task
 * IDs are UUIDv7 and the orchestrator wraps this call in a durable
 * Inngest step with `concurrency: { limit: 1, key: "event.data.taskId" }`,
 * so concurrent pushes against the same `cogmo/run/<task-id>` ref are
 * not possible in production. If a future caller breaks that contract,
 * the force-push would silently overwrite a sibling run.
 */
export async function pushTaskBranchToRemote(p: PushTaskBranchParams): Promise<void> {
  if (!p.remoteUrl) {
    // Empty `coding_repos.remote_url` is the fresh-deploy default — the
    // skills row is auto-seeded with an empty string when the operator
    // hasn't attached an `origin` to the bare repo yet. Surface the
    // misconfiguration with a name the operator can act on, instead of
    // letting git fail with an opaque "fatal: '' does not appear to be a
    // git repository".
    throw new Error(
      "remote_url is empty for this repo — set it via SQL or attach `origin` " +
        "to the bare repo before delegating coding tasks.",
    );
  }
  const runRef = runBranchFor(p.taskId);
  const fetchRefSpec = `+${p.defaultBranch}:refs/remotes/origin/${p.defaultBranch}`;
  const pushRefSpec = `+refs/remotes/origin/${p.defaultBranch}:refs/heads/${runRef}`;

  await withGitAskpass(p.identity.pat, async (env) => {
    // Refresh first — an N-day-stale mirror would push a stale base
    // commit into the run branch and the sandbox would do its work off
    // old code.
    await runGit(["-C", p.localRepoPath, "fetch", p.remoteUrl, fetchRefSpec], env);
    await runGit(["-C", p.localRepoPath, "push", p.remoteUrl, pushRefSpec], env);
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
 *
 * Bare repos (e.g. the skill library at `$COGMO_SKILLS_PATH`) receive the
 * branch under `refs/heads/<branch>` instead of `refs/remotes/origin/<branch>`.
 * Bare repos store branches directly as `refs/heads/*` — there's no
 * "remote-tracking" namespace — and downstream consumers like the skill
 * runner's `register` flow read from `refs/heads/<branch>`. Without
 * branching on bareness here, the feature branch lands under a refspec
 * the consumer doesn't look at, and the round-trip silently strands the
 * skill author's work. Non-bare mirrors (the common case for user `/repo add` flows) keep
 * the historical `refs/remotes/origin/*` behaviour so working-tree workflows
 * stay unsurprising.
 */
export async function fetchFeatureBranch(p: FetchFeatureBranchParams): Promise<void> {
  if (!p.remoteUrl) {
    // Symmetric guard with `pushTaskBranchToRemote` — see that branch
    // for the rationale. Lifting the check here too means the
    // post-task fetch fails at the helper boundary with a clear
    // operator-facing message rather than inside the askpass scope
    // where the symptom would be `git fetch ""` with no useful context.
    throw new Error(
      "remote_url is empty for this repo — set it via SQL or attach `origin` " +
        "to the bare repo before delegating coding tasks.",
    );
  }
  // Bareness check is a single cheap rev-parse — local-only, no network
  // or auth. `runGit` without an `env` argument skips the askpass setup,
  // so we can route every git invocation through the same primitive
  // instead of forking off an `execFile` path here. Answer is stable
  // for a given path; the orchestrator drives this once per task, so
  // caching across calls is unnecessary.
  const isBare = await isBareRepository(p.localRepoPath);
  const targetRef = isBare ? `refs/heads/${p.branch}` : `refs/remotes/origin/${p.branch}`;

  await withGitAskpass(p.identity.pat, async (env) => {
    await runGit(["-C", p.localRepoPath, "fetch", p.remoteUrl, `+${p.branch}:${targetRef}`], env);
  });
}

async function isBareRepository(repoPath: string): Promise<boolean> {
  const { stdout } = await runGit(["-C", repoPath, "rev-parse", "--is-bare-repository"]);
  return stdout.trim() === "true";
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
