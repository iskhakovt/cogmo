/**
 * The verify phase's publishing stages, run once the suite has passed: push
 * the feature branch, then open the PR and record it on the task.
 */

import type { Octokit } from "@octokit/rest";
import type { Inngest } from "inngest";
import type { AskpassMaterials } from "../../sandbox/askpass.js";
import type { SandboxClient, SandboxSession } from "../../sandbox/index.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { commitAuthorFor, runCommitAndPush } from "./commit-push.js";
import { fetchFeatureBranch } from "./git-as-transport.js";
import { runOpenPr } from "./open-pr.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import { WORKTREE_DIR_IN_CONTAINER } from "./task-sandbox.js";
import type { PrMetadata, WorktreeAssignment } from "./types.js";

/** A stage either moved the task on, or failed it with a reason. */
export type PublishOutcome<T> = { kind: "done"; value: T } | { kind: "failed"; reason: string };

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
  inngest: Pick<Inngest, "send">,
  args: {
    task: CodingTaskRow;
    branch: string;
    identity: GitHubIdentity;
    askpass: AskpassMaterials;
    container: () => Promise<SandboxSession>;
  },
): Promise<PublishOutcome<{ branchSha: string }>> {
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
  if (commit.kind === "branch_conflict") {
    return failed(`push rejected — branch conflict on cogmo/<idShort>:\n\n${commit.output}`);
  }
  if (commit.kind === "auth_failed") {
    return failed(`push rejected — GitHub authentication failed:\n\n${commit.output}`);
  }
  if (commit.kind === "failed") {
    return failed(`commit+push failed:\n\n${commit.output}`);
  }

  // A clean tree has no commit sha to reuse. Durable so the PR head is
  // pinned to one value; conditional on the memoized `kind`, so the step
  // plan is identical on every replay.
  const branchSha =
    (commit.kind === "pushed" ? commit.commitSha : "") ||
    (await run.stepRun("read-head-sha", async () => readHeadSha(await args.container())));

  await run.stepRun("set-status-pushed", () =>
    deps.runInTx((tx) => deps.store.updateTaskStatus(tx, { id: run.taskId, status: "pushed" })),
  );
  await run.stepRun("emit-pushed", () =>
    inngest
      .send({
        name: "coding/task/pushed",
        data: { taskId: run.taskId, branchSha },
        id: `pushed-${run.taskId}`,
      })
      .then(() => undefined),
  );
  return { kind: "done", value: { branchSha } };
}

export interface OpenTaskPrDeps extends TaskStoreDeps {
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
  inngest: Pick<Inngest, "send">,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    remote: { owner: string; repo: string };
    assignment: WorktreeAssignment;
    identity: GitHubIdentity;
    branchSha: string;
    verifyOutput: string;
  },
): Promise<PublishOutcome<{ url: string; number: number }>> {
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
  if (pr.kind === "auth_failed") return failed(`PR open failed (auth): ${pr.message}`);
  if (pr.kind === "validation_failed") {
    return failed(`PR open failed (validation): ${pr.message}`);
  }
  // The branch is pushed but has no PR; it stays upstream for a re-delegate.
  if (pr.kind === "failed") return failed(`PR open failed: ${pr.message}`);

  const metadata: PrMetadata = {
    url: pr.url,
    number: pr.number,
    branchSha: pr.branchSha,
    openedAt: pr.openedAt,
  };
  await run.stepRun("set-pr-metadata", () =>
    deps.runInTx((tx) => deps.store.setTaskPrMetadata(tx, run.taskId, metadata)),
  );
  await run.stepRun("set-status-pr-open", () =>
    deps.runInTx((tx) => deps.store.updateTaskStatus(tx, { id: run.taskId, status: "pr_open" })),
  );
  await run.stepRun("emit-pr-opened", () =>
    inngest
      .send({
        name: "coding/task/pr-opened",
        data: { taskId: run.taskId, prUrl: pr.url, prNumber: pr.number },
        // Matters more than its siblings: `auto-register-skill` subscribes
        // to this one, and a re-send re-enters the register flow (mostly
        // absorbed by its `no_op` tip resolution) alongside any user-facing
        // notification firing twice.
        id: `pr-opened-${run.taskId}`,
      })
      .then(() => undefined),
  );
  if (deps.sandbox.capabilities.workingTreeTransport === "git-remote") {
    await fetchBackFeatureBranch(run, { repo, branch: assignment.branch, identity });
  }
  return { kind: "done", value: { url: pr.url, number: pr.number } };
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

function failed(reason: string): { kind: "failed"; reason: string } {
  return { kind: "failed", reason };
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
