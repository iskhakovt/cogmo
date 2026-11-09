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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import { runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import {
  describeResolveIdentityError,
  type GitHubIdentity,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";

const execFileP = promisify(execFile);

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

export interface FetchDefaultBranchParams {
  /** `coding_repos.local_path` — the host mirror clone. */
  localRepoPath: string;
  /** HTTPS clone URL — `coding_repos.remote_url`. */
  remoteUrl: string;
  /** `coding_repos.default_branch` — captured at `/repo add` time. */
  defaultBranch: string;
  identity: GitHubIdentity;
}

/**
 * Refresh the local mirror's view of the remote's `defaultBranch` and return
 * the commit it names: the base a task's run branch is cut at. A stale
 * mirror would cut the branch from old code.
 *
 * The fetch addresses the remote by URL (not by mirror-side remote name)
 * with an explicit refspec into `refs/remotes/origin/<defaultBranch>` —
 * symmetric with `fetchFeatureBranch`, and decoupled from whatever name
 * `git remote` happens to use locally. The tip is read back from that ref,
 * locally.
 */
export async function fetchDefaultBranchTip(p: FetchDefaultBranchParams): Promise<string> {
  requireRemoteUrl(p.remoteUrl);
  const trackingRef = `refs/remotes/origin/${p.defaultBranch}`;
  await withGitAskpass(p.identity.pat, (env) =>
    runGit(
      ["-C", p.localRepoPath, "fetch", p.remoteUrl, `+${p.defaultBranch}:${trackingRef}`],
      env,
    ),
  );
  const { stdout } = await runGit([
    "-C",
    p.localRepoPath,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${trackingRef}^{commit}`,
  ]);
  return stdout.trim();
}

export interface PushTaskBranchParams {
  /** `coding_repos.local_path` — the host mirror clone. */
  localRepoPath: string;
  /** HTTPS clone URL — `coding_repos.remote_url`. */
  remoteUrl: string;
  taskId: string;
  /** `coding_repos.default_branch`, fetched when the mirror lacks `baseSha`. */
  defaultBranch: string;
  /** The commit to cut the run branch at: the assignment's `baseSha`. */
  baseSha: string;
  identity: GitHubIdentity;
}

/** A base commit neither the mirror nor the remote's default or run branch holds. */
export interface BaseMissing {
  kind: "base_missing";
  baseSha: string;
}

/**
 * Force-push `baseSha` to `cogmo/run/<task-id>` on the remote, for the
 * sandbox to clone. Force, so a run branch an earlier attempt left at
 * another commit is reset to `baseSha`.
 *
 * The mirror may lack a base an earlier attempt recorded: the default branch
 * rewritten on the remote since, say. Then the remote's run branch, and if
 * need be its default branch, are fetched and the base is looked for again;
 * it is never replaced. Errs with `base_missing` when neither holds it.
 *
 * Inherits — does not enforce — single-writer-per-task semantics. Task
 * IDs are UUIDv7 and the orchestrator wraps this call in a durable
 * Inngest step with `concurrency: { limit: 1, key: "event.data.taskId" }`,
 * so concurrent pushes against the same `cogmo/run/<task-id>` ref are
 * not possible in production. If a future caller breaks that contract,
 * the force-push would silently overwrite a sibling run.
 */
export async function pushTaskBranchToRemote(
  p: PushTaskBranchParams,
): Promise<Result<void, BaseMissing>> {
  requireRemoteUrl(p.remoteUrl);
  const runBranch = runBranchFor(p.taskId);
  return withGitAskpass(p.identity.pat, async (env) => {
    // The run branch first, as a pattern, which matches nothing rather than
    // failing the fetch when no earlier attempt pushed it; then the default
    // branch, whose fetch fails when the remote no longer has it.
    const sources = [
      `+refs/heads/${runBranch}*:refs/remotes/origin/${runBranch}*`,
      `+${p.defaultBranch}:refs/remotes/origin/${p.defaultBranch}`,
    ];
    for (const source of sources) {
      if (await hasCommit(p.localRepoPath, p.baseSha)) break;
      await runGit(["-C", p.localRepoPath, "fetch", p.remoteUrl, source], env);
    }
    if (!(await hasCommit(p.localRepoPath, p.baseSha))) {
      return err({ kind: "base_missing" as const, baseSha: p.baseSha });
    }
    await runGit(
      ["-C", p.localRepoPath, "push", p.remoteUrl, `+${p.baseSha}:refs/heads/${runBranch}`],
      env,
    );
    return ok(undefined);
  });
}

/**
 * Whether the repo at `repoPath` holds `sha` as a commit. `rev-parse
 * --verify --quiet` exits 1 when it does not; any other failure (no repo at
 * the path) rejects. Through `execFile`, whose error carries the exit code.
 */
async function hasCommit(repoPath: string, sha: string): Promise<boolean> {
  try {
    await execFileP("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${sha}^{commit}`,
    ]);
    return true;
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === 1) return false;
    throw e;
  }
}

/**
 * Empty `coding_repos.remote_url` is the fresh-deploy default — the skills
 * row is auto-seeded with an empty string when the operator hasn't attached
 * an `origin` to the bare repo yet. Surface the misconfiguration with a name
 * the operator can act on, instead of letting git fail with an opaque
 * "fatal: '' does not appear to be a git repository".
 */
function requireRemoteUrl(remoteUrl: string): void {
  if (!remoteUrl) {
    throw new Error(
      "remote_url is empty for this repo — set it via SQL or attach `origin` " +
        "to the bare repo before delegating coding tasks.",
    );
  }
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
  // At the helper boundary, so the post-task fetch fails with a clear
  // operator-facing message rather than inside the askpass scope, where the
  // symptom would be `git fetch ""` with no useful context.
  requireRemoteUrl(p.remoteUrl);
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
 * Resolve a `github_identity:<name>` row to a validated bundle, or the
 * operator-actionable message from `describeResolveIdentityError`.
 */
export async function findIdentity(
  args: LoadIdentityArgs,
): Promise<Result<GitHubIdentity, string>> {
  const result = await args.runInTx((tx) =>
    resolveGitHubIdentity(tx, args.secretsStore, args.identityName),
  );
  return result.mapErr(describeResolveIdentityError);
}

/**
 * {@link findIdentity} where the run's `check-credentials` step already found
 * the identity, so a miss is an identity removed mid-run. Every caller is a
 * step body, where a throw is the framework's failure channel: the step
 * fails and the orchestrator's catch records it.
 */
export async function loadIdentity(args: LoadIdentityArgs): Promise<GitHubIdentity> {
  const result = await findIdentity(args);
  if (result.isErr()) throw new Error(result.error);
  return result.value;
}
