/**
 * Verify → push → PR orchestrator (`coding-task-verify`).
 *
 * Triggered by `coding/task/cli-done` after the execute orchestrator flips
 * the task to `pending_verify`. Drives:
 *
 *   pending_verify → verifying → (failed) | pushed → pr_open
 *
 *   claim → credentials → verify sandbox → run verify → push branch →
 *   open PR
 *
 * The execute run already reaped its container, so this one creates a
 * fresh container with the askpass mount bound, which only this run can
 * `exec` against. On any failure: status=failed, reason persisted, worktree,
 * container and askpass torn down.
 */

import type { Octokit } from "@octokit/rest";
import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import { codingTaskCliDone } from "../../inngest/events.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import type { AskpassMaterials } from "../../sandbox/askpass.js";
import type { SandboxClient, SandboxSession, SandboxSessionState } from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import {
  describeResolveIdentityError,
  type GitHubIdentity,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { describeError } from "../../util/describe-error.js";
import { AskpassLease } from "./askpass-lease.js";
import type { loadCodingSandboxEnv } from "./auth.js";
import { type CodingRun, codingRun, loadTaskAndRepo } from "./coding-run.js";
import { parseRemoteUrl } from "./open-pr.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "./store/index.js";
import { failTaskFromCatch, recordTaskFailed } from "./task-failure.js";
import { CLAIMS, claimTask } from "./task-lifecycle.js";
import {
  checkoutFeatureBranchStep,
  lazySession,
  loadSandboxEnv,
  taskImage,
  taskSessionSpec,
} from "./task-sandbox.js";
import { safeTeardownWorktree } from "./teardown.js";
import type { WorktreeAssignment } from "./types.js";
import { runVerifyStreaming, type VerifyResult } from "./verify.js";
import { openTaskPr, pushVerifiedBranch } from "./verify-publish.js";

const log = logger.child({ component: "coding.verify-orchestrator" });

export interface VerifyOrchestratorDeps {
  runInTx: Transactor;
  store: CodingStore;
  sandbox: SandboxClient;
  /** Resolves `github_identity:<name>` rows. */
  secretsStore: SecretsStore;
  /** Host root for per-task askpass material. */
  askpassBaseDir: string;
  /** Default base image when the repo has no devcontainer override. */
  devbaseImage: string;
  defaultResourceLimits: ResourceLimits;
  taskTtlMs: number;
  /**
   * Optional Octokit factory. Tests inject a stub; production omits it
   * and `runOpenPr` constructs a real client from the resolved PAT.
   * Threaded as a factory rather than a pre-built instance because the
   * PAT isn't known until the identity bundle is decrypted per-task.
   */
  octokitFactory?: (pat: string) => Octokit;
  /** Test-only — same role as `CodingOrchestratorDeps.loadCodingSandboxEnv`. */
  loadCodingSandboxEnv?: typeof loadCodingSandboxEnv;
}

export interface VerifyOrchestratorResult {
  status: "pr_open" | "pushed" | "failed" | "skipped";
  failureReason?: string;
  prUrl?: string;
  prNumber?: number;
}

export function createCodingVerifyOrchestrator(deps: VerifyOrchestratorDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-task-verify",
      triggers: [codingTaskCliDone],
      retries: 0,
      // Sequentialize per task — guards against duplicate fires from the
      // execute orchestrator's retry path.
      concurrency: { limit: 1, key: "event.data.taskId" },
    },
    async ({ event, step, runId }) => {
      return runCodingVerify({
        taskId: event.data.taskId,
        runId,
        deps,
        stepRun: step.run,
        stepSendEvent: step.sendEvent,
        inngest,
      });
    },
  );
}

interface RunParams {
  taskId: string;
  /** See {@link CodingRun.runId}. */
  runId: string;
  deps: VerifyOrchestratorDeps;
  stepRun: StepRun;
  /** See {@link CodingRun.stepSendEvent}. */
  stepSendEvent: StepSendEvent;
  inngest: Pick<Inngest, "send">;
}

/** What a run fails with: the task's repo and worktree, for teardown. */
interface VerifyFailureContext {
  repo: CodingRepoRow;
  assignment: WorktreeAssignment;
}

/**
 * Pure orchestration — `stepRun` is Inngest's `step.run` in production
 * and an inline shim in tests.
 */
export async function runCodingVerify(params: RunParams): Promise<VerifyOrchestratorResult> {
  const { taskId, deps, inngest } = params;
  const run = codingRun(params, log);
  const { task, repo } = await loadTaskAndRepo(deps, taskId);
  if (!task.worktreeAssignment) {
    throw new Error(`coding task ${taskId} has no worktree_assignment`);
  }
  const assignment = task.worktreeAssignment;

  // Ahead of the credential checks too, since each of them fails the task: a
  // duplicate event tripping, say, a rotated secret would otherwise flip a
  // task another run owns to `failed`. The cost is that a run failing one of
  // them passes through `verifying` for the millisecond the decrypts take —
  // invisible, as both statuses are non-terminal.
  const claim = await claimTask(run, deps, CLAIMS.verify);
  if (claim.kind === "lost") {
    run.log.info(
      { transition: claim.transition },
      "verify: status transition lost the race (already verifying or terminal)",
    );
    return { status: "skipped" };
  }

  const failure: VerifyFailureContext = { repo, assignment };
  const credentials = await resolveVerifyCredentials(deps, repo);
  if (credentials.isErr()) return await failVerify(run, deps, failure, credentials.error);
  const { remote, identity, env } = credentials.value;

  const askpassLease = new AskpassLease(deps.askpassBaseDir, taskId);
  try {
    const askpass = await askpassLease.provision(run, identity);
    const state = await createVerifySandbox(run, deps, {
      task,
      repo,
      assignment,
      identity,
      askpass,
      env,
    });
    const container = lazySession(deps.sandbox, state);

    const verdict = await runVerifyStage(run, inngest, { repo, container });
    if (!verdict.ok) {
      const reason = `verify failed (exit ${verdict.exitCode})\n\n${verdict.output}`;
      return await failVerify(run, deps, failure, reason);
    }

    const pushed = await pushVerifiedBranch(run, deps, inngest, {
      task,
      branch: assignment.branch,
      identity,
      askpass,
      container,
    });
    if (pushed.isErr()) return await failVerify(run, deps, failure, pushed.error);

    const pr = await openTaskPr(run, deps, inngest, {
      task,
      repo,
      remote,
      assignment,
      identity,
      branchSha: pushed.value.branchSha,
      verifyOutput: verdict.output,
    });
    if (pr.isErr()) return await failVerify(run, deps, failure, pr.error);
    return { status: "pr_open", prUrl: pr.value.url, prNumber: pr.value.number };
  } catch (err) {
    const reason = describeError(err);
    run.log.error({ err }, "coding verify failed");
    await failTaskFromCatch(run, deps, reason);
    await safeTeardownWorktree({
      secretsStore: deps.secretsStore,
      runInTx: deps.runInTx,
      repo,
      taskId,
      worktreeAssignment: assignment,
    }).catch(() => undefined);
    return { status: "failed", failureReason: reason };
  } finally {
    // Unconditional sweep — idempotent at the label-index layer, reaps
    // managed-backend state that survived a thrown create, and a no-op when
    // no labelled sandbox exists.
    await deps.sandbox.deleteByTaskId(taskId).catch((err: unknown) => {
      run.log.warn({ err }, "verify: deleteByTaskId failed");
    });
    // After the sweep: on Local-Docker `deleteByTaskId` already wiped the
    // bind-mount source, and this second, idempotent release still removes
    // the host dir on Daytona, where only the sandbox-side copy is wiped.
    askpassLease.release();
  }
}

interface VerifyCredentials {
  remote: { owner: string; repo: string };
  identity: GitHubIdentity;
  env: Readonly<Record<string, string>>;
}

/**
 * Resolved before any container work, so a repo the wizard hasn't finished
 * fails fast rather than after spinning up a container to throw away — and
 * before askpass is provisioned on disk. The error is the failure reason.
 */
async function resolveVerifyCredentials(
  deps: VerifyOrchestratorDeps,
  repo: CodingRepoRow,
): Promise<Result<VerifyCredentials, string>> {
  const remote = parseRemoteUrl(repo.remoteUrl);
  if (!remote) return err(`cannot parse owner/repo from remote URL: ${repo.remoteUrl}`);
  const identity = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, repo.identityName),
  );
  if (identity.isErr()) return err(describeResolveIdentityError(identity.error));
  const auth = await loadSandboxEnv(deps);
  if (auth.isErr()) return err(auth.error.message);
  return ok({ remote, identity: identity.value, env: auth.value });
}

/**
 * The failure exit for every failure this run observes: status, event, and
 * worktree teardown. The sandbox and askpass are reaped by the caller's
 * `finally`.
 */
async function failVerify(
  run: CodingRun,
  deps: VerifyOrchestratorDeps,
  failure: VerifyFailureContext,
  reason: string,
): Promise<VerifyOrchestratorResult> {
  await recordTaskFailed(run, deps, reason, "set-status-failed");
  await run
    .stepRun("teardown-worktree", () =>
      safeTeardownWorktree({
        secretsStore: deps.secretsStore,
        runInTx: deps.runInTx,
        repo: failure.repo,
        taskId: run.taskId,
        worktreeAssignment: failure.assignment,
      }),
    )
    .catch(() => undefined);
  return { status: "failed", failureReason: reason };
}

/** A fresh container with the askpass dir mounted read-only. */
async function createVerifySandbox(
  run: CodingRun,
  deps: VerifyOrchestratorDeps,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    assignment: WorktreeAssignment;
    identity: GitHubIdentity;
    askpass: AskpassMaterials;
    env: Readonly<Record<string, string>>;
  },
): Promise<SandboxSessionState> {
  const { sandbox } = deps;
  const image = taskImage(args.repo, deps.devbaseImage);
  // Delegate-gate on the named-snapshot warm. Boot fires-and-forgets; a
  // verify task arriving before warm completes shares the promise.
  await run.stepRun("ensure-image-present", async () => {
    await sandbox.ensureImagePresent(image);
  });
  const state = await run.stepRun("create-container", async () => {
    const session = await sandbox.create(
      taskSessionSpec({
        sandbox,
        task: args.task,
        repo: args.repo,
        assignment: args.assignment,
        identityPat: args.identity.pat,
        askpass: args.askpass,
        image,
        resourceLimits: deps.defaultResourceLimits,
        taskTtlMs: deps.taskTtlMs,
        env: args.env,
      }),
    );
    return session.state;
  });
  if (sandbox.capabilities.workingTreeTransport === "git-remote") {
    await checkoutFeatureBranchStep(run, sandbox, state, args.assignment.branch);
  }
  return state;
}

/**
 * `run-verify`, then `coding/task/verify-complete`. Durable: the repo's
 * entire suite, and `ok` selects disjoint step sets downstream, so a verdict
 * drifting between replays would plan a step graph the executor never
 * asked for. The runner caps `output` at 8 KiB, keeping the return small.
 */
async function runVerifyStage(
  run: CodingRun,
  inngest: Pick<Inngest, "send">,
  args: { repo: CodingRepoRow; container: () => Promise<SandboxSession> },
): Promise<VerifyResult> {
  const verdict = await run.stepRun("run-verify", async () =>
    runVerifyStreaming({
      container: await args.container(),
      verifyCommand: args.repo.verifyCommand,
      timeoutSeconds: args.repo.verifyTimeoutSeconds,
    }),
  );
  await run.stepRun("emit-verify-complete", () =>
    inngest
      .send({
        name: "coding/task/verify-complete",
        data: {
          taskId: run.taskId,
          ok: verdict.ok,
          exitCode: verdict.exitCode,
          durationMs: verdict.durationMs,
        },
        // The step boundary covers replay, the id the crash window it
        // can't. One verify verdict per task, so the id is unambiguous.
        id: `verify-complete-${run.taskId}`,
      })
      .then(() => undefined),
  );
  return verdict;
}
