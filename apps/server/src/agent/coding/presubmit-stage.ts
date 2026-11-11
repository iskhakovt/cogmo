/**
 * The skills repo's pre-submit: register's dry run on the task's pushed tip,
 * between `commit-and-push` and `transition-pushed`
 * (design/coding-delegation.md → Skills-repo pre-submit). Advisory: the run
 * records the verdict on the task and carries on whatever it is.
 */

import { ResultAsync } from "neverthrow";
import { runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import { deleteRef, revParse } from "../../skills/git-ops.js";
import { SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import type { RegisterDryRun, SkillRunner } from "../../skills/runner.js";
import { describeError } from "../../util/describe-error.js";
import { REGISTER_TIMEOUT_MS } from "./auto-register-skill.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingRepoRow } from "./store/index.js";
import type { PresubmitVerdict } from "./types.js";

export interface PresubmitDeps {
  /** Register's dry run. */
  skillRunner: Pick<SkillRunner, "checkRegister">;
  /** The bare skills repo register reads, which the branch is fetched into. */
  skillsRepoPath: string;
  /** The server's release, recorded on each verdict. */
  releaseVersion: string;
}

interface PresubmitArgs {
  repo: CodingRepoRow;
  branch: string;
  /** The tip `commit-and-push` pushed, which the PR names. */
  branchSha: string;
  identity: GitHubIdentity;
}

/** What the dry run judged, or why nothing was judged: a verdict before its key. */
type Judged =
  | RegisterDryRun
  | {
      kind: "unavailable";
      sha: string | null;
      cause: "fetch_failed" | "branch_moved" | "deadline";
      detail: string;
    };

/** The fix pass a verdict is keyed at: a task's first, and its only one. */
const FIX_PASS = 0;

/**
 * The `presubmit` step, on the skills repo only; the repo's name does not
 * change under a run. Durable: it runs sandbox sessions against the network.
 * Its result is `{ verdict }`.
 */
export async function runPresubmit(
  run: CodingRun,
  deps: TaskStoreDeps & { presubmit: PresubmitDeps },
  args: PresubmitArgs,
): Promise<void> {
  if (args.repo.name !== SKILLS_CODING_REPO_NAME) return;
  await run.stepRun("presubmit", async () => ({ verdict: await presubmit(run, deps, args) }));
}

/**
 * A verdict keyed to this run and pass is the step's own commit, whose result
 * Inngest lost: it is returned with no second dry run. Otherwise the tip is
 * judged and the verdict written under this run's key, conditional on
 * `verifying`.
 */
async function presubmit(
  run: CodingRun,
  deps: TaskStoreDeps & { presubmit: PresubmitDeps },
  args: PresubmitArgs,
): Promise<PresubmitVerdict> {
  const task = await deps.runInTx((tx) => deps.store.getTask(tx, run.taskId));
  if (!task) throw new Error(`coding task ${run.taskId} vanished before presubmit`);
  const stored = task.presubmitVerdict;
  if (stored !== null && stored.runId === run.runId && stored.fixPass === FIX_PASS) return stored;

  const verdict: PresubmitVerdict = {
    ...(await judgeTip(run, deps.presubmit, args)),
    runId: run.runId,
    fixPass: FIX_PASS,
    checkedAt: new Date().toISOString(),
    releaseVersion: deps.presubmit.releaseVersion,
  };
  const recorded = await deps.runInTx((tx) =>
    deps.store.setTaskPresubmitVerdict(tx, run.taskId, verdict),
  );
  run.log.info({ verdict: verdict.kind, recorded }, "presubmit: register dry run judged the tip");
  return verdict;
}

/**
 * Fetches the pushed branch from the remote into the bare repo, as the
 * auto-register does, under `refs/cogmo-presubmit/<task-id>`, and dry-runs
 * register on the fetched tip under the auto-register's deadline. The ref
 * sits outside `refs/heads/`, so no `cogmo skills register --branch` can name
 * it, and goes once the dry run returns. A failed fetch, a tip other than the
 * pushed one and the deadline judge nothing; any other throw is a bug.
 */
async function judgeTip(run: CodingRun, deps: PresubmitDeps, args: PresubmitArgs): Promise<Judged> {
  const ref = `refs/cogmo-presubmit/${run.taskId}`;
  const signal = AbortSignal.timeout(REGISTER_TIMEOUT_MS);
  try {
    const fetched = await ResultAsync.fromPromise(
      withGitAskpass(args.identity.pat, (env) =>
        runGit(
          ["-C", deps.skillsRepoPath, "fetch", args.repo.remoteUrl, `+${args.branch}:${ref}`],
          env,
          { signal },
        ),
      ),
      describeError,
    );
    if (fetched.isErr()) {
      const cause = signal.aborted ? "deadline" : "fetch_failed";
      return { kind: "unavailable", sha: null, cause, detail: fetched.error };
    }
    const resolved = await revParse(deps.skillsRepoPath, ref);
    if (resolved.isErr()) throw new Error(`presubmit: ${ref} is missing after its fetch`);
    const sha = resolved.value;
    if (sha !== args.branchSha) {
      return {
        kind: "unavailable",
        sha,
        cause: "branch_moved",
        detail: `${args.branch} is at ${sha} on the remote, not at the pushed ${args.branchSha}`,
      };
    }
    return await deps.skillRunner.checkRegister({ sha, signal }).catch((e: unknown): Judged => {
      if (!signal.aborted) throw e;
      return { kind: "unavailable", sha, cause: "deadline", detail: describeError(e) };
    });
  } finally {
    await deleteRef(deps.skillsRepoPath, ref).catch((err: unknown) => {
      run.log.warn(
        { err, ref },
        "presubmit: scratch ref not deleted; outside refs/heads/ it is inert",
      );
    });
  }
}
