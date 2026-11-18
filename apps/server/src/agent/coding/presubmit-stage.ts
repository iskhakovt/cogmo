/**
 * The skills repo's pre-submit: register's dry run on the task's pushed tip,
 * between `commit-and-push` and `transition-pushed`
 * (design/coding-delegation.md → Skills-repo pre-submit). The run records the
 * verdict on the task. A refusal with a fix pass left is handed back to a fix
 * pass; any other refusal and a stale base fail the task, and every other
 * verdict proceeds to the PR.
 */

import { ResultAsync } from "neverthrow";
import { isMatching, match, P } from "ts-pattern";
import { runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import { cutDryRunText, type RegisterPause } from "../../skills/deploy/register-result.js";
import { deleteRef, revParse } from "../../skills/git-ops.js";
import { SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import type { RegisterDryRun, SkillRunner } from "../../skills/runner.js";
import { abortable } from "../../util/abortable.js";
import { describeError } from "../../util/describe-error.js";
import { redactSecretsInText } from "../../util/redact-secrets.js";
import { REGISTER_TIMEOUT_MS } from "./auto-register-skill.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { fitFindings } from "./presubmit-findings.js";
import type { CodingRepoRow } from "./store/index.js";
import {
  PRESUBMIT_FIX_PASSES,
  type PresubmitUnavailableCause,
  type PresubmitVerdict,
  type TaskFailure,
} from "./types.js";
import { OUTPUT_CAP_BYTES } from "./verify.js";

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
  /** The run's pass, from its trigger: the verdict's key with the run id. */
  fixPass: number;
}

/** Why this stage, rather than a register check, judged nothing. */
type StageCause = Exclude<PresubmitUnavailableCause, RegisterPause>;

/** What the dry run judged, or why nothing was judged: a verdict before its key. */
type Judged =
  | RegisterDryRun
  | { kind: "unavailable"; sha: string | null; cause: StageCause; detail: string };

/** A verdict this stage reaches without the dry run, its detail cut as the dry run's are. */
function stageUnavailable(sha: string | null, cause: StageCause, detail: string): Judged {
  return { kind: "unavailable", sha, cause, detail: cutDryRunText(detail) };
}

/**
 * Where the run goes from the pre-submit: on to `transition-pushed`, to
 * `transition-presubmit-failed` with the failure the verdict stands for, or
 * back to a fix pass, carrying the failure a run that already failed the
 * task on this refusal records.
 */
export type PresubmitExit =
  | { kind: "proceed" }
  | { kind: "fail"; failure: TaskFailure }
  | { kind: "hand_back"; failure: TaskFailure };

/**
 * The `presubmit` step, on the skills repo only; the repo's name does not
 * change under a run. Durable: it runs sandbox sessions against the network,
 * and its result, `{ verdict }`, selects the steps that follow.
 */
export async function runPresubmit(
  run: CodingRun,
  deps: TaskStoreDeps & { presubmit: PresubmitDeps },
  args: PresubmitArgs,
): Promise<PresubmitExit> {
  if (args.repo.name !== SKILLS_CODING_REPO_NAME) return { kind: "proceed" };
  const { verdict } = await run.stepRun("presubmit", async () => ({
    verdict: await presubmit(run, deps, args),
  }));
  return presubmitExit(verdict, { runId: run.runId, fixPass: args.fixPass });
}

/**
 * Each verdict's transition (design/coding-delegation.md → Skills-repo
 * pre-submit → State machine). A refusal keyed to another run or pass is a
 * repeated one, and fails the task, as does one with no pass left.
 * `unavailable` judged nothing, and register runs the same checks again with
 * its own pausing outcome.
 */
function presubmitExit(
  verdict: PresubmitVerdict,
  key: { runId: string; fixPass: number },
): PresubmitExit {
  return match(verdict)
    .returnType<PresubmitExit>()
    .with({ kind: "passed" }, { kind: "unavailable" }, () => ({ kind: "proceed" }))
    .with({ kind: "refused" }, (refused) => {
      const failure: TaskFailure = {
        reason: "presubmit_refused",
        detail: refusedDetail(refused.findings),
      };
      const own = refused.runId === key.runId && refused.fixPass === key.fixPass;
      return own && key.fixPass < PRESUBMIT_FIX_PASSES
        ? { kind: "hand_back", failure }
        : { kind: "fail", failure };
    })
    .with({ kind: "stale_base" }, ({ sha, mainSha }) => ({
      kind: "fail",
      failure: {
        reason: "presubmit_stale_base",
        detail: `main is at ${mainSha}, and the pushed tip ${sha} does not contain it. Merge main into the branch and register it by hand.`,
      },
    }))
    .exhaustive();
}

/**
 * The findings as `failure_detail` and `coding/task/failed` carry them: at
 * most 8 KiB once masked, as verify output is, cut at a finding boundary.
 */
function refusedDetail(findings: readonly string[]): string {
  return fitFindings(
    findings,
    (text) => Buffer.byteLength(redactSecretsInText(text)) <= OUTPUT_CAP_BYTES,
  );
}

/**
 * A verdict keyed to this run and pass is the step's own commit, whose result
 * Inngest lost: it is returned with no second dry run. A refusal an earlier
 * pass stored for the same tip and release is returned under that pass's key,
 * with nothing written: the same tip under the same release gets the same
 * verdict. Otherwise the tip is judged and the verdict written under this
 * run's key, conditional on `verifying`.
 */
async function presubmit(
  run: CodingRun,
  deps: TaskStoreDeps & { presubmit: PresubmitDeps },
  args: PresubmitArgs,
): Promise<PresubmitVerdict> {
  const task = await deps.runInTx((tx) => deps.store.getTask(tx, run.taskId));
  if (!task) throw new Error(`coding task ${run.taskId} vanished before presubmit`);
  const stored = task.presubmitVerdict;
  if (stored !== null && stored.runId === run.runId && stored.fixPass === args.fixPass) {
    return stored;
  }
  const repeated = {
    kind: "refused",
    fixPass: P.number.lt(args.fixPass),
    sha: args.branchSha,
    releaseVersion: deps.presubmit.releaseVersion,
  } as const;
  if (isMatching(repeated, stored)) return stored;

  const verdict: PresubmitVerdict = {
    ...(await judgeTip(run, deps.presubmit, args)),
    runId: run.runId,
    fixPass: args.fixPass,
    checkedAt: new Date().toISOString(),
    releaseVersion: deps.presubmit.releaseVersion,
  };
  const written = await deps.runInTx((tx) =>
    deps.store.setTaskPresubmitVerdict(tx, run.taskId, verdict),
  );
  match(written)
    .with({ kind: "recorded" }, () =>
      run.log.info({ verdict: verdict.kind }, "presubmit: register dry run judged the tip"),
    )
    .with({ kind: "left" }, ({ status }) =>
      run.log.info(
        { verdict: verdict.kind, status },
        "presubmit: the task left verifying during the dry run; no verdict recorded",
      ),
    )
    .exhaustive();
  return verdict;
}

/**
 * Fetches the pushed branch from the remote into the bare repo, as the
 * auto-register does, under `refs/cogmo-presubmit/<task-id>`, and dry-runs
 * register on the fetched tip within the auto-register's deadline. The ref
 * sits outside `refs/heads/`, so no `cogmo skills register --branch` can name
 * it, and goes once the stage has its verdict. A failed fetch, a tip other
 * than the pushed one and the deadline judge nothing; any other throw is a
 * bug.
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
      return stageUnavailable(null, signal.aborted ? "deadline" : "fetch_failed", fetched.error);
    }
    const resolved = await revParse(deps.skillsRepoPath, ref);
    if (resolved.isErr()) throw new Error(`presubmit: ${ref} is missing after its fetch`);
    const sha = resolved.value;
    if (sha !== args.branchSha) {
      return stageUnavailable(
        sha,
        "branch_moved",
        `${args.branch} is at ${sha} on the remote, not at the pushed ${args.branchSha}`,
      );
    }
    return await dryRunWithin(run, deps, sha, signal);
  } finally {
    await deleteRef(deps.skillsRepoPath, ref).catch((err: unknown) => {
      run.log.warn(
        { err, ref },
        "presubmit: scratch ref not deleted; outside refs/heads/ it is inert",
      );
    });
  }
}

/**
 * The dry run, raced against the deadline: a sandbox create or delete takes
 * no signal, so the dry run can outlast it. Past the deadline it is left to
 * finish on its own, each check deleting the session it opened once its
 * create returns, and whatever it settles to is dropped, since only this
 * stage writes the verdict; a late failure other than the deadline's own
 * abort is logged.
 */
async function dryRunWithin(
  run: CodingRun,
  deps: PresubmitDeps,
  sha: string,
  signal: AbortSignal,
): Promise<Judged> {
  const dryRun = deps.skillRunner.checkRegister({ sha, signal });
  return abortable(dryRun, signal).catch((e: unknown): Judged => {
    if (!signal.aborted) throw e;
    dryRun.catch((err: unknown) => {
      // A check that honours the signal rejects with its reason: that is the
      // deadline doing its job, not a failure.
      if (err === signal.reason) return;
      run.log.warn({ err }, "presubmit: the dry run left at its deadline failed");
    });
    return stageUnavailable(sha, "deadline", describeError(e));
  });
}
