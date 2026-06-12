/**
 * Verify → push → PR orchestrator (slice 4.0h).
 *
 * Triggered by `coding/task/cli-done` after the execute orchestrator
 * (`coding-task-execute`) flips the task to `pending_verify`. Drives:
 *
 *   pending_verify → verifying → (failed) | pushed → pr_open
 *
 * with durable Inngest steps so an Inngest replay re-enters the same
 * code path and the in-progress steps are checkpointed. Container
 * creation is re-done by this function (the execute teardown already
 * cleaned the previous one) so the askpass mount is bound to a fresh
 * container that only this orchestrator can `exec` against.
 *
 * On any failure: status=failed, captured reason persisted, container
 * + askpass torn down. Optional `refs/cogmo-wip/<task-id>` push on
 * verify-fail is gated behind `CODING_VERIFY_WIP_PUSH=true` (default
 * off — see slice4-plan.md decision 5); flipping it on requires
 * implementing the push, which is currently a no-op.
 */

import type { Octokit } from "@octokit/rest";
import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskCliDone, codingTaskFailed } from "../../inngest/events.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import { cleanupAskpass, provisionAskpass } from "../../sandbox/askpass.js";
import type { SandboxClient, SandboxSession } from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import {
  describeResolveIdentityError,
  type GitHubIdentity,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { loadCodingSandboxEnv } from "./auth.js";
import { commitAuthorFor, runCommitAndPush } from "./commit-push.js";
import { fetchFeatureBranch } from "./git-as-transport.js";
import { parseRemoteUrl, runOpenPr } from "./open-pr.js";
import {
  buildWorktreeSpec,
  checkoutFeatureBranchInSandbox,
  type ExecuteStreamHandle,
  NULL_EXECUTE_STREAM,
} from "./orchestrator.js";
import type { CodingStore } from "./store/index.js";
import { safeTeardownWorktree } from "./teardown.js";
import type { PrMetadata } from "./types.js";
import { runVerifyStreaming } from "./verify.js";

const log = logger.child({ component: "coding.verify-orchestrator" });

const HOME_VOLUME_PREFIX = "cogmo-task-home";
const WORKTREE_DIR_IN_CONTAINER = "/workspace";

export interface VerifyOrchestratorDeps {
  runInTx: Transactor;
  store: CodingStore;
  sandbox: SandboxClient;
  /** Resolves `github_identity:<name>` rows. */
  secretsStore: SecretsStore;
  /** Host root for per-task askpass material (slice 4.0d). */
  askpassBaseDir: string;
  /** Default base image when the repo has no devcontainer override. */
  devbaseImage: string;
  defaultResourceLimits: ResourceLimits;
  taskTtlMs: number;
  openExecuteStream?: (taskId: string) => Promise<ExecuteStreamHandle>;
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
      // execute orchestrator's retry path. Matches the slice 1/2 pattern.
      concurrency: { limit: 1, key: "event.data.taskId" },
    },
    async ({ event, step }) => {
      return runCodingVerify({
        taskId: event.data.taskId,
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
  deps: VerifyOrchestratorDeps;
  stepRun: StepRun;
  /**
   * Durable bus emit. Used in the in-worker catch path so a transient
   * send blip surfaces as a function failure (caught by the reconcile
   * subscriber) rather than a silently-swallowed event.
   */
  stepSendEvent: StepSendEvent;
  inngest: Pick<Inngest, "send">;
}

/**
 * Pure orchestration — `stepRun` is Inngest's `step.run` in production
 * and an inline shim in tests.
 */
export async function runCodingVerify(params: RunParams): Promise<VerifyOrchestratorResult> {
  const { taskId, deps, stepRun, stepSendEvent, inngest } = params;
  const taskLog = log.child({ taskId });
  const { runInTx, store, sandbox, secretsStore, askpassBaseDir } = deps;
  const openExecuteStream = deps.openExecuteStream ?? (async () => NULL_EXECUTE_STREAM);

  const task = await runInTx((tx) => store.getTask(tx, taskId));
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await runInTx((tx) => store.getRepoById(tx, task.repoId));
  if (!repo) throw new Error(`coding repo not found: ${task.repoId}`);

  if (task.status !== "pending_verify") {
    taskLog.info(
      { status: task.status },
      "verify: task not in pending_verify — already started or terminated, skipping",
    );
    return { status: "skipped" };
  }
  if (!task.worktreeAssignment) {
    throw new Error(`coding task ${taskId} has no worktree_assignment`);
  }
  const worktreeAssignment = task.worktreeAssignment;

  /**
   * Local helper bundling status=failed + worktree teardown + stream
   * notification for every verify-orchestrator failure exit. Inlined as
   * a closure (rather than a top-level function with many params)
   * because it captures `stepRun`, `store`, `secretsStore`, `repo`,
   * `taskId`, `worktreeAssignment` from this scope.
   */
  const failAndTeardown = async (
    reason: string,
    stream?: ExecuteStreamHandle | null,
  ): Promise<VerifyOrchestratorResult> => {
    await stepRun("set-status-failed", () =>
      runInTx((tx) =>
        store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
      ),
    );
    await stepSendEvent("emit-task-failed", {
      ...codingTaskFailed.create({ taskId, reason }),
      id: `task-failed-${taskId}`,
    });
    await stepRun("teardown-worktree", () =>
      safeTeardownWorktree({ secretsStore, runInTx, repo, taskId, worktreeAssignment }),
    ).catch(() => undefined);
    if (stream) {
      await stream.fail(reason).catch(() => {});
    }
    return { status: "failed", failureReason: reason };
  };

  const remote = parseRemoteUrl(repo.remoteUrl);
  if (!remote) {
    return await failAndTeardown(`cannot parse owner/repo from remote URL: ${repo.remoteUrl}`);
  }

  // Identity resolution happens before any container work — fast-fail when
  // the wizard hasn't been run rather than spinning up a container we'll
  // throw away.
  const identityResult = await runInTx((tx) =>
    resolveGitHubIdentity(tx, secretsStore, repo.identityName),
  );
  if (identityResult.isErr()) {
    return await failAndTeardown(describeResolveIdentityError(identityResult.error));
  }
  const identity: GitHubIdentity = identityResult.value;

  // Same fail-fast contract for the Claude Code subscription token —
  // resolved here (not inside the create-container step) so a missing
  // secret doesn't waste an askpass provision on disk before surfacing.
  const loadAuth = deps.loadCodingSandboxEnv ?? loadCodingSandboxEnv;
  const authResult = await runInTx((tx) => loadAuth(tx, secretsStore));
  if (authResult.isErr()) {
    return await failAndTeardown(authResult.error.message);
  }
  const sandboxEnv = authResult.value;

  let executeStream: ExecuteStreamHandle | null = null;
  let askpassProvisioned = false;

  try {
    // Conditional UPDATE pending_verify → verifying so a duplicate
    // event (Inngest replay or operator nudge) finds the row already
    // verifying and returns kind=skipped.
    const transition = await stepRun("set-status-verifying", () =>
      runInTx((tx) => store.transitionTaskStatus(tx, taskId, "pending_verify", "verifying")),
    );
    if (transition.kind !== "transitioned") {
      taskLog.info(
        { transition },
        "verify: status transition lost the race (already verifying or terminal)",
      );
      return { status: "skipped" };
    }

    // Provision askpass material — host-side, per-task. Mark before the
    // step body executes so a partial provision (mkdir succeeded but a
    // writeFileSync threw) still triggers cleanup in the finally block.
    // The cleanup is a recursive `rm -rf`; absent or partial dirs are
    // no-ops so over-cleaning is harmless.
    askpassProvisioned = true;
    const askpass = await stepRun("provision-askpass", async () =>
      provisionAskpass({ baseDir: askpassBaseDir, rootTaskId: taskId, identity }),
    );

    // Create a fresh container with the askpass dir mounted read-only at
    // /tmp/cogmo-askpass. Cleanup goes through `deleteByTaskId(taskId)`
    // unconditionally in the finally block — idempotent at the
    // label-index layer, sweeps any provider-side state that survived
    // a thrown create on managed backends, and a no-op when nothing
    // labelled exists.
    const containerImage = repo.devcontainer?.image ?? deps.devbaseImage;
    // Delegate-gate on the named-snapshot warm. Boot fires-and-forgets;
    // a verify task arriving before warm completes shares the promise.
    await stepRun("ensure-image-present", async () => {
      await sandbox.ensureImagePresent(containerImage);
    });
    const sessionState = await stepRun("create-container", async () => {
      const session = await sandbox.create({
        taskId,
        worktree: buildWorktreeSpec({
          taskId,
          capability: sandbox.capabilities.workingTreeTransport,
          assignment: worktreeAssignment,
          remoteUrl: repo.remoteUrl,
          identityPat: identity.pat,
        }),
        ...(sandbox.capabilities.workingTreeTransport === "bind-mount" && {
          homeVolume: { volumeName: `${HOME_VOLUME_PREFIX}-${taskId}` },
        }),
        image: containerImage,
        resourceLimits: deps.defaultResourceLimits,
        expiresAt: new Date(Date.now() + deps.taskTtlMs),
        allowPrivilegedRunc: task.allowPrivilegedRunc,
        askpass: { hostDir: askpass.hostDir, containerDir: askpass.containerDir },
        env: sandboxEnv,
      });
      return session.state;
    });

    if (sandbox.capabilities.workingTreeTransport === "git-remote") {
      await stepRun("checkout-feature-branch", async () => {
        const session = await sandbox.resume(sessionState);
        await checkoutFeatureBranchInSandbox(session, worktreeAssignment.branch);
      });
    }
    const container: SandboxSession = await sandbox.resume(sessionState);

    executeStream = await openExecuteStream(taskId);

    // 1. Verify ───────────────────────────────────────────────────────
    const verifyResult = await runVerifyStreaming({
      container,
      verifyCommand: repo.verifyCommand,
      timeoutSeconds: repo.verifyTimeoutSeconds,
      executeStream,
    });
    await stepRun("emit-verify-complete", () =>
      inngest
        .send({
          name: "coding/task/verify-complete",
          data: {
            taskId,
            ok: verifyResult.ok,
            exitCode: verifyResult.exitCode,
            durationMs: verifyResult.durationMs,
          },
        })
        .then(() => undefined),
    );
    if (!verifyResult.ok) {
      const reason = `verify failed (exit ${verifyResult.exitCode})\n\n${verifyResult.output}`;
      return await failAndTeardown(reason, executeStream);
    }

    // 2. Commit + push ────────────────────────────────────────────────
    const branch = worktreeAssignment.branch;
    const commitResult = await runCommitAndPush({
      container,
      worktreeDir: WORKTREE_DIR_IN_CONTAINER,
      branch,
      commitMessage: task.goal,
      signingKeyPath: askpass.signingKeyPath,
      askpassEnv: askpass.env,
      author: commitAuthorFor(identity),
    });

    if (commitResult.kind === "branch_conflict") {
      return await failAndTeardown(
        `push rejected — branch conflict on cogmo/<idShort>:\n\n${commitResult.output}`,
        executeStream,
      );
    }
    if (commitResult.kind === "auth_failed") {
      return await failAndTeardown(
        `push rejected — GitHub authentication failed:\n\n${commitResult.output}`,
        executeStream,
      );
    }
    if (commitResult.kind === "failed") {
      return await failAndTeardown(`commit+push failed:\n\n${commitResult.output}`, executeStream);
    }

    // `nothing_to_commit` is a valid outcome — the verify passed on a
    // clean tree (re-running an already-pushed task). We still try to
    // open the PR; if octokit reports `validation_failed` (PR already
    // exists), surface it as a failure with that reason.
    let branchSha = commitResult.kind === "pushed" ? commitResult.commitSha : "";
    if (!branchSha) {
      // Re-derive HEAD via the container — the verify-only path didn't
      // run rev-parse. Cheap exec.
      branchSha = await readHeadSha(container);
    }

    await stepRun("set-status-pushed", () =>
      runInTx((tx) => store.updateTaskStatus(tx, { id: taskId, status: "pushed" })),
    );
    await stepRun("emit-pushed", () =>
      inngest
        .send({ name: "coding/task/pushed", data: { taskId, branchSha } })
        .then(() => undefined),
    );

    // 3. Open PR ─────────────────────────────────────────────────────
    const planText = task.plan ?? "";
    const prResult = await runOpenPr({
      pat: identity.pat,
      owner: remote.owner,
      repo: remote.repo,
      head: branch,
      base: repo.defaultBranch,
      goal: task.goal,
      plan: planText,
      verifyOutput: verifyResult.output,
      branchSha,
      ...(deps.octokitFactory && { octokit: deps.octokitFactory(identity.pat) }),
    });

    if (prResult.kind === "auth_failed") {
      return await failAndTeardown(`PR open failed (auth): ${prResult.message}`, executeStream);
    }
    if (prResult.kind === "validation_failed") {
      return await failAndTeardown(
        `PR open failed (validation): ${prResult.message}`,
        executeStream,
      );
    }
    if (prResult.kind === "failed") {
      // The branch is pushed but no PR — log + leave for retry per
      // slice4-plan.md. Surface as failed so the operator sees it on
      // Telegram and can re-delegate; the pushed branch is preserved
      // upstream.
      return await failAndTeardown(`PR open failed: ${prResult.message}`, executeStream);
    }

    const metadata: PrMetadata = {
      url: prResult.url,
      number: prResult.number,
      branchSha: prResult.branchSha,
      openedAt: prResult.openedAt,
    };
    await stepRun("set-pr-metadata", () =>
      runInTx((tx) => store.setTaskPrMetadata(tx, taskId, metadata)),
    );
    await stepRun("set-status-pr-open", () =>
      runInTx((tx) => store.updateTaskStatus(tx, { id: taskId, status: "pr_open" })),
    );
    await stepRun("emit-pr-opened", () =>
      inngest
        .send({
          name: "coding/task/pr-opened",
          data: { taskId, prUrl: prResult.url, prNumber: prResult.number },
        })
        .then(() => undefined),
    );

    // git-remote backends don't bind-mount the worktree, so the local
    // mirror's `refs/remotes/origin/cogmo/<idShort>` lags the sandbox's
    // push. Fetch it back so a future host-side merge or `git log`
    // reflects the actual PR head. Best-effort — origin is the source
    // of truth and any later op can fetch on demand.
    if (sandbox.capabilities.workingTreeTransport === "git-remote") {
      await stepRun("fetch-feature-branch", () =>
        fetchFeatureBranch({
          localRepoPath: repo.localPath,
          remoteUrl: repo.remoteUrl,
          branch: worktreeAssignment.branch,
          identity,
        }),
      );
    }

    if (executeStream) {
      await executeStream
        .complete(true)
        .catch((err) => taskLog.warn({ err }, "execute stream complete failed"));
    }

    return { status: "pr_open", prUrl: prResult.url, prNumber: prResult.number };
  } catch (err) {
    const reason = (err as Error).message;
    taskLog.error({ err }, "coding verify failed");
    // Emit BEFORE the DB status update — see the rationale on the
    // matching catch in `runCodingTask`.
    await stepSendEvent("emit-task-failed", {
      ...codingTaskFailed.create({ taskId, reason }),
      id: `task-failed-${taskId}`,
    });
    // Letting this throw is load-bearing — see the matching catch in
    // `runCodingTask`.
    await runInTx((tx) =>
      store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
    );
    await safeTeardownWorktree({
      secretsStore,
      runInTx,
      repo,
      taskId,
      worktreeAssignment,
    }).catch(() => undefined);
    if (executeStream) {
      await executeStream.fail(reason).catch(() => {});
    }
    return { status: "failed", failureReason: reason };
  } finally {
    // Unconditional sandbox sweep — idempotent at the label-index layer
    // and reaps managed-backend state (Daytona) that survived a thrown
    // create. No-op when no labelled sandbox exists.
    await sandbox.deleteByTaskId(taskId).catch((err: unknown) => {
      taskLog.warn({ err }, "verify: deleteByTaskId failed");
    });
    // The host-side askpass dir holds the PAT + signing key and is
    // independent of the sandbox lifecycle — wipe it whenever
    // provisioning got far enough to create the directory. Idempotent
    // + tolerant of missing dirs (recursive remove with force:true),
    // which matters here because on Local-Docker the
    // `sandbox.deleteByTaskId` above already calls `cleanupAskpass`
    // internally (supervisor's `delete()` owns the bind-mount); the
    // second call is harmless and removes the per-task dir even on
    // Daytona (where the sandbox-side copy is wiped server-side but
    // the host source dir would otherwise leak the PAT).
    if (askpassProvisioned) {
      cleanupAskpass({ baseDir: askpassBaseDir, rootTaskId: taskId });
    }
  }
}

async function readHeadSha(container: Pick<SandboxSession, "execStreaming">): Promise<string> {
  const handle = await container.execStreaming(["git", "rev-parse", "HEAD"], {
    workingDir: WORKTREE_DIR_IN_CONTAINER,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stdout) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  // Drain stderr to avoid backpressure.
  const drain = (async () => {
    for await (const _ of handle.stderr) {
      // discard
    }
  })();
  await handle.wait();
  await drain;
  return Buffer.concat(chunks).toString("utf8").trim();
}
