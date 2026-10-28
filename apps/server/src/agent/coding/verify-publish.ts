/**
 * The verify phase's publishing stages, run once the suite has passed: push
 * the feature branch, then open the PR and record it on the task.
 */

import type { Octokit } from "@octokit/rest";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { EventPublisher } from "../../inngest/durable.js";
import { buildCodingTaskPushedEvent } from "../../inngest/events.js";
import type { AskpassMaterials } from "../../sandbox/askpass.js";
import type { SandboxClient, SandboxSession } from "../../sandbox/index.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { commitAuthorFor, runCommitAndPush } from "./commit-push.js";
import { fetchFeatureBranch } from "./git-as-transport.js";
import { runOpenPr } from "./open-pr.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import { advanceTask, type TaskLeft } from "./task-lifecycle.js";
import { WORKTREE_DIR_IN_CONTAINER } from "./task-sandbox.js";
import type { PrMetadata, TaskFailure, WorktreeAssignment } from "./types.js";

/**
 * `pushed`: the branch is upstream, the task reads `pushed` and
 * `coding/task/pushed` is out. `left`: the task moved out of `verifying`
 * under the run (a Cancel during the suite or the push), so neither the
 * event nor the PR follows; the branch stays upstream for a re-delegate.
 */
export type PushOutcome = { kind: "pushed"; branchSha: string } | TaskLeft;

/**
 * `opened`: the PR is open, recorded on the task, and announced. `left`: the
 * task moved out of `pushed` under the run between `commit-and-push` and
 * here. The PR may already be open — `open-pr` runs ahead of the transition,
 * and GitHub offers nothing to make the two atomic — in which case
 * `pr_metadata` records it and `coding/task/pr-opened` is withheld.
 */
export type PrOutcome = { kind: "opened"; url: string; number: number } | TaskLeft;

/** What the `open-pr` stage publishes, and where. */
export interface OpenTaskPrArgs {
  task: CodingTaskRow;
  repo: CodingRepoRow;
  remote: { owner: string; repo: string };
  assignment: WorktreeAssignment;
  identity: GitHubIdentity;
  branchSha: string;
  verifyOutput: string;
}

/**
 * The `commit-and-push` stage, then `pushed`. Durable: it writes a commit
 * and pushes it. The PAT reaches the runner through the askpass env and the
 * closure, never as a step argument or return.
 *
 * `nothing_to_commit` is a valid outcome — the suite passed on a clean tree
 * (re-running an already-pushed task) — and the PR is still attempted; one
 * that already exists comes back from GitHub as `validation_failed`.
 */
export async function pushVerifiedBranch(
  run: CodingRun,
  deps: TaskStoreDeps,
  inngest: EventPublisher,
  args: {
    task: CodingTaskRow;
    branch: string;
    identity: GitHubIdentity;
    askpass: AskpassMaterials;
    container: () => Promise<SandboxSession>;
  },
): Promise<Result<PushOutcome, TaskFailure>> {
  const commit = await run.stepRun("commit-and-push", async () =>
    runCommitAndPush({
      container: await args.container(),
      worktreeDir: WORKTREE_DIR_IN_CONTAINER,
      branch: args.branch,
      commitMessage: args.task.goal,
      signingKeyPath: args.askpass.signingKeyPath,
      askpassEnv: args.askpass.env,
      author: commitAuthorFor(args.identity),
    }),
  );
  const landed = match(commit)
    .with({ kind: "branch_conflict" }, ({ output }) =>
      err<string, TaskFailure>({ reason: "branch_conflict", detail: output }),
    )
    .with({ kind: "auth_failed" }, ({ output }) =>
      err<string, TaskFailure>({ reason: "auth_failed", detail: output }),
    )
    .with({ kind: "failed" }, ({ output }) =>
      err<string, TaskFailure>({ reason: "push_failed", detail: output }),
    )
    .with({ kind: "pushed" }, ({ commitSha }) => ok<string, TaskFailure>(commitSha))
    .with({ kind: "nothing_to_commit" }, () => ok<string, TaskFailure>(""))
    .exhaustive();
  if (landed.isErr()) return err(landed.error);

  // A clean tree has no commit sha to reuse. Durable so the PR head is
  // pinned to one value; conditional on the memoized `kind`, so the step
  // plan is identical on every replay.
  const branchSha =
    landed.value ||
    (await run.stepRun("read-head-sha", async () => readHeadSha(await args.container())));

  // Conditional on `verifying`: the suite runs for minutes, and a Cancel
  // landing inside it must not be overwritten by the push that follows.
  // `stale` at `pushed` is this step re-executing after a lost result.
  // `stale` at `pr_open` is a run in flight across the deploy that
  // introduced this step: a verifying task reaches `pr_open` only through
  // this run's own retired `set-status-pr-open`, and the run has to carry
  // on through its memoized `open-pr` to the `emit-pr-opened` it may still
  // owe.
  const pushed = await advanceTask(run, deps, {
    stepId: "transition-pushed",
    from: "verifying",
    to: "pushed",
    settledAt: ["pr_open"],
  });
  return await match(pushed)
    .with({ kind: "left" }, (left): Result<PushOutcome, TaskFailure> => ok(left))
    .with({ kind: "advanced" }, async (): Promise<Result<PushOutcome, TaskFailure>> => {
      await run.stepRun("emit-pushed", () =>
        inngest
          .send(buildCodingTaskPushedEvent({ taskId: run.taskId, branchSha }))
          .then(() => undefined),
      );
      return ok({ kind: "pushed", branchSha });
    })
    .exhaustive();
}

interface OpenTaskPrDeps extends TaskStoreDeps {
  sandbox: Pick<SandboxClient, "capabilities">;
  octokitFactory?: (pat: string) => Octokit;
}

/**
 * The `open-pr` stage, then `pr_open`. Durable because opening a PR is
 * irreversible and not idempotent upstream: a second `pulls.create` returns
 * 422 `validation_failed`, which reads as a failure, so a re-POST would have
 * the run that opened the PR fail its own task. The PAT is a closure
 * argument, and `OpenPrResult` carries only public metadata.
 */
export async function openTaskPr(
  run: CodingRun,
  deps: OpenTaskPrDeps,
  inngest: EventPublisher,
  args: OpenTaskPrArgs,
): Promise<Result<PrOutcome, TaskFailure>> {
  const { repo, identity, assignment } = args;
  const pr = await run.stepRun("open-pr", () =>
    runOpenPr({
      pat: identity.pat,
      owner: args.remote.owner,
      repo: args.remote.repo,
      head: assignment.branch,
      base: repo.defaultBranch,
      goal: args.task.goal,
      plan: args.task.plan ?? "",
      verifyOutput: args.verifyOutput,
      branchSha: args.branchSha,
      ...(deps.octokitFactory && { octokit: deps.octokitFactory(identity.pat) }),
    }),
  );
  // On every failure the branch is pushed but has no PR; it stays upstream
  // for a re-delegate.
  const prResult = match(pr)
    .with({ kind: "auth_failed" }, ({ message }) =>
      err<PrMetadata, TaskFailure>({ reason: "pr_auth_failed", detail: message }),
    )
    .with({ kind: "validation_failed" }, ({ message }) =>
      err<PrMetadata, TaskFailure>({ reason: "pr_validation_failed", detail: message }),
    )
    .with({ kind: "failed" }, ({ message }) =>
      err<PrMetadata, TaskFailure>({ reason: "pr_open_failed", detail: message }),
    )
    .with({ kind: "opened" }, ({ url, number, branchSha, openedAt }) =>
      ok<PrMetadata, TaskFailure>({ url, number, branchSha, openedAt }),
    )
    .exhaustive();
  if (prResult.isErr()) return err(prResult.error);
  const metadata = prResult.value;
  await run.stepRun("set-pr-metadata", () =>
    deps.runInTx((tx) => deps.store.setTaskPrMetadata(tx, run.taskId, metadata)),
  );
  // Conditional on `pushed`: a Cancel between the push and here stands, with
  // `pr_metadata` recording the PR that is already open. `stale` at
  // `pr_open` is this step re-executing after a lost result.
  const opened = await advanceTask(run, deps, {
    stepId: "transition-pr-open",
    from: "pushed",
    to: "pr_open",
  });
  return await match(opened)
    .with({ kind: "left" }, (left): Result<PrOutcome, TaskFailure> => ok(left))
    .with({ kind: "advanced" }, async (): Promise<Result<PrOutcome, TaskFailure>> => {
      await run.stepRun("emit-pr-opened", () =>
        inngest
          .send({
            name: "coding/task/pr-opened",
            data: { taskId: run.taskId, prUrl: metadata.url, prNumber: metadata.number },
            // Matters more than its siblings: `auto-register-skill`
            // subscribes to this one, and a re-send re-enters the register
            // flow (mostly absorbed by its `no_op` tip resolution) alongside
            // any user-facing notification firing twice.
            id: `pr-opened-${run.taskId}`,
          })
          .then(() => undefined),
      );
      if (deps.sandbox.capabilities.workingTreeTransport === "git-remote") {
        await fetchBackFeatureBranch(run, { repo, branch: assignment.branch, identity });
      }
      return ok({ kind: "opened", url: metadata.url, number: metadata.number });
    })
    .exhaustive();
}

/**
 * git-remote backends don't bind-mount the worktree, so the local mirror's
 * `refs/remotes/origin/cogmo/<idShort>` lags the sandbox's push; fetch it
 * back so host-side git reflects the PR head. Best-effort, and caught inside
 * the step body: the task has shipped, and a throw reaching the caller's
 * catch would overwrite `pr_open` with `failed`.
 */
async function fetchBackFeatureBranch(
  run: CodingRun,
  args: { repo: CodingRepoRow; branch: string; identity: GitHubIdentity },
): Promise<void> {
  await run.stepRun("fetch-feature-branch", () =>
    fetchFeatureBranch({
      localRepoPath: args.repo.localPath,
      remoteUrl: args.repo.remoteUrl,
      branch: args.branch,
      identity: args.identity,
    }).catch((err: unknown) => {
      run.log.warn(
        { err, branch: args.branch },
        "verify: feature-branch fetch-back failed — origin holds the branch, mirror lags",
      );
    }),
  );
}
async function readHeadSha(container: Pick<SandboxSession, "execStreaming">): Promise<string> {
  // Same caps `runGit` puts on the identical command in `commit-push.ts`,
  // per design/coding-delegation.md → Per-callsite exec timeouts: the call
  // runs inside a durable step, where a half-closed transport would hang
  // the run past its lease.
  const handle = await container.execStreaming(["git", "rev-parse", "HEAD"], {
    workingDir: WORKTREE_DIR_IN_CONTAINER,
    timeoutMs: 60_000,
    idleTimeoutMs: 30_000,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stdout) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // Drain stderr to avoid backpressure.
  const drain = (async () => {
    for await (const _ of handle.stderr) {
      // discard
    }
  })();
  const { exitCode } = await handle.wait();
  await drain;
  const sha = Buffer.concat(chunks).toString("utf8").trim();
  if (exitCode !== 0 || sha === "") {
    // Throw rather than return "": this runs inside a durable step, so an
    // empty sha would be memoized and then written verbatim into the
    // `coding/task/pushed` event, the PR body and `pr_metadata.branchSha`.
    throw new Error(`git rev-parse HEAD failed (exit ${exitCode}) in ${WORKTREE_DIR_IN_CONTAINER}`);
  }
  return sha;
}
