/**
 * How the execute phase ends, once its session has run: claude's commits
 * pushed to the run-branch (git-remote), then either handed to verify,
 * failed, or abandoned to a task that ended under the run.
 */

import type { Inngest } from "inngest";
import type { SandboxClient, SandboxSession } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { BackendUsage } from "./backend.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { commitAuthorFor, runCommitAndPush } from "./commit-push.js";
import type { ExecutePushCredentials } from "./execute-sandbox.js";
import { completionTokens } from "./execute-session.js";
import { runBranchFor } from "./git-as-transport.js";
import type { ExecuteStreamHandle } from "./progress-stream.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import { recordTaskFailed } from "./task-failure.js";
import { advanceTask, reclaimEndedTask } from "./task-lifecycle.js";
import { reapTaskSandbox, WORKTREE_DIR_IN_CONTAINER } from "./task-sandbox.js";
import { safeTeardownWorktree } from "./teardown.js";
import type { WorktreeAssignment } from "./types.js";

export interface ExecuteOutcomeDeps extends TaskStoreDeps {
  sandbox: Pick<SandboxClient, "deleteByTaskId">;
  secretsStore: SecretsStore;
}

/** The task's repo, worktree and progress stream, which every exit touches. */
export interface ExecuteExitContext {
  repo: CodingRepoRow;
  assignment: WorktreeAssignment;
  stream: ExecuteStreamHandle;
}

/**
 * Below the claim on purpose: a throw here fails the function, which sends
 * `coding-task-reconcile` at a row that — before the claim — this run has no
 * title to. The three fields are the plan phase's and this run never writes
 * them, so checking them in the bare body is stable across replays.
 */
export async function checkExecutable(
  task: CodingTaskRow,
  stream: ExecuteStreamHandle,
): Promise<{ sessionId: string; worktreeAssignment: WorktreeAssignment }> {
  const failedCheck = async (message: string): Promise<Error> => {
    await stream.fail(message).catch(() => {});
    return new Error(message);
  };
  if (!task.planApprovedAt) {
    throw await failedCheck(
      `coding task ${task.id} has no plan_approved_at — execute fired prematurely`,
    );
  }
  if (!task.sessionId) {
    throw await failedCheck(
      `coding task ${task.id} has no session_id — plan phase didn't capture it`,
    );
  }
  if (!task.worktreeAssignment) {
    throw await failedCheck(`coding task ${task.id} has no worktree_assignment`);
  }
  return { sessionId: task.sessionId, worktreeAssignment: task.worktreeAssignment };
}

/**
 * git-remote: push claude's commits from inside the execute sandbox to the
 * run-branch `cogmo/run/<task-id>` — the ref the verify sandbox clones.
 * Verify then creates `cogmo/<idShort>` from its tip and pushes that as the
 * PR head. Returns the failure reason, or null when the push landed (or
 * there was nothing to commit).
 */
export async function pushExecuteChanges(
  run: CodingRun,
  args: {
    task: CodingTaskRow;
    assignment: WorktreeAssignment;
    credentials: ExecutePushCredentials;
    container: () => Promise<SandboxSession>;
  },
): Promise<string | null> {
  const { assignment, credentials } = args;
  if (assignment.type !== "git-remote") {
    throw new Error(
      `git-remote push step requires a git-remote worktree assignment, got ${assignment.type}`,
    );
  }
  const result = await run.stepRun("commit-and-push-execute-changes", async () =>
    runCommitAndPush({
      container: await args.container(),
      worktreeDir: WORKTREE_DIR_IN_CONTAINER,
      branch: assignment.branch,
      remoteBranch: runBranchFor(run.taskId),
      commitMessage: args.task.goal,
      signingKeyPath: credentials.askpass.signingKeyPath,
      askpassEnv: {
        GIT_ASKPASS: credentials.askpass.helperPath,
        GIT_TERMINAL_PROMPT: "0",
      },
      author: commitAuthorFor(credentials.identity),
    }),
  );
  if (result.kind === "pushed" || result.kind === "nothing_to_commit") return null;
  return `execute push failed (${result.kind}):\n\n${result.output}`;
}

/** Step ids of one execute failure exit; each exit has its own. */
export interface ExecuteFailureSteps {
  status: string;
  /** Null where the transport leaves no host worktree to tear down. */
  teardownWorktree: string | null;
  teardown: string;
  sandboxDeleted: string;
  /** Tells the two exits' stream-notification warnings apart in the logs. */
  logSuffix: string;
}

export async function endExecuteFailed(
  run: CodingRun,
  deps: ExecuteOutcomeDeps,
  exit: ExecuteExitContext,
  reason: string,
  steps: ExecuteFailureSteps,
): Promise<void> {
  await recordTaskFailed(run, deps, reason, steps.status);
  if (steps.teardownWorktree !== null) {
    await run.stepRun(steps.teardownWorktree, () =>
      safeTeardownWorktree({
        runInTx: deps.runInTx,
        secretsStore: deps.secretsStore,
        repo: exit.repo,
        taskId: run.taskId,
        worktreeAssignment: exit.assignment,
      }),
    );
  }
  await reapTaskSandbox(run, deps.sandbox, steps.teardown);
  await stampSandboxDeleted(run, deps, steps.sandboxDeleted);
  // The status is committed: a subscriber error must not reach the catch
  // and write a second, less informative failed status over this reason.
  await exit.stream.complete(false).catch((streamErr: unknown) => {
    run.log.warn(
      { err: streamErr },
      `execute stream complete(false) notification failed${steps.logSuffix}`,
    );
  });
  await exit.stream.fail(reason).catch((streamErr: unknown) => {
    run.log.warn({ err: streamErr }, "execute stream fail notification failed");
  });
}

/**
 * `handed_off`: the task is at `pending_verify` and `coding/task/cli-done`
 * is out. `left_executing`: the task moved out of `executing` under this
 * run — a Cancel during `execute-cli` — so no hand-off happened.
 */
export type HandOffOutcome = "handed_off" | "left_executing";

/**
 * `pending_verify`, then reap this container before emitting
 * `coding/task/cli-done`, so the verify run gets a fresh container with its
 * own secrets bound rather than reusing this one. The step boundary covers
 * replay; the `cli-done-<taskId>` id covers the crash window it can't, and
 * past the bus's window the verify claim skips a duplicate.
 *
 * The transition is conditional on `executing`, so a Cancel that landed
 * during `execute-cli` stays cancelled, and the run reclaims the worktree
 * and sandbox it holds instead of handing off.
 */
export async function handOffToVerify(
  run: CodingRun,
  deps: ExecuteOutcomeDeps,
  inngest: Pick<Inngest, "send">,
  exit: ExecuteExitContext & { usage: BackendUsage | undefined },
): Promise<HandOffOutcome> {
  // `transition-pending-verify` supersedes `set-status-pending-verify`, an
  // unconditional write that memoized `void`. A run in flight that already
  // ran the old step never asks for it again; it runs this one instead,
  // finds the row `stale` at `pending_verify` (verify can't claim it before
  // `emit-cli-done`), and carries on.
  const pendingVerify = await advanceTask(run, deps, {
    stepId: "transition-pending-verify",
    from: "executing",
    to: "pending_verify",
  });
  if (pendingVerify.kind === "left") {
    run.log.info(
      { transition: pendingVerify.transition, ended: pendingVerify.ended },
      "execute: task left `executing` mid-session — stopping",
    );
    if (pendingVerify.ended) {
      await reclaimEndedTask(run, deps, {
        repo: exit.repo,
        assignment: exit.assignment,
        stream: exit.stream,
        message: "Task cancelled while executing.",
      });
    }
    return "left_executing";
  }
  await reapTaskSandbox(run, deps.sandbox, "teardown");
  await stampSandboxDeleted(run, deps, "persist-sandbox-deleted");
  await run.stepRun("emit-cli-done", () =>
    inngest
      .send({
        name: "coding/task/cli-done",
        data: { taskId: run.taskId },
        id: `cli-done-${run.taskId}`,
      })
      .then(() => undefined),
  );
  // After the durable work: a subscriber failure (a transient Telegram error
  // on the final edit) must not regress `pending_verify` to `failed`.
  await exit.stream.complete(true, completionTokens(exit.usage)).catch((streamErr: unknown) => {
    run.log.warn(
      { err: streamErr },
      "execute stream complete notification failed (task already pending_verify)",
    );
  });
  return "handed_off";
}

/**
 * Stamps `resource_usage.sandbox.deleted_at`; a no-op when no sandbox block
 * was persisted or the stamp is already there.
 */
async function stampSandboxDeleted(
  run: CodingRun,
  deps: TaskStoreDeps,
  stepId: string,
): Promise<void> {
  await run.stepRun(stepId, () =>
    deps.runInTx((tx) =>
      deps.store.setTaskSandboxDeletedAt(tx, run.taskId, new Date().toISOString()),
    ),
  );
}
