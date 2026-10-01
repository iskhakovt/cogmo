/**
 * The plan (`coding-task-start`) and execute (`coding-task-execute`)
 * orchestrators. Each is a sequence of named stages over one coding task;
 * the stages live in their own modules, and this file owns the order, the
 * early exits and the failure channel around them.
 *
 *   plan:    claim → allocate worktree → plan sandbox → plan session →
 *            persist plan → plan gate
 *   execute: claim → execute sandbox → execute session → (git-remote)
 *            push execute changes → hand off to verify
 */

import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskPlanApproved, codingTaskStart } from "../../inngest/events.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import type { SandboxClient } from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { describeError } from "../../util/describe-error.js";
import { allocateTaskWorktree } from "./allocate-task-worktree.js";
import { AskpassLease } from "./askpass-lease.js";
import type { loadCodingSandboxEnv } from "./auth.js";
import type { CodingBackend } from "./backend.js";
import { type CodingRun, codingRun, loadTaskAndRepo } from "./coding-run.js";
import {
  checkExecutable,
  endExecuteFailed,
  handOffToVerify,
  pushExecuteChanges,
} from "./execute-outcomes.js";
import { acquireExecuteSandbox } from "./execute-sandbox.js";
import { persistSessionUsage, runExecuteSession } from "./execute-session.js";
import { parkPlanAtGate } from "./plan-gate-stage.js";
import { preparePlanSandbox } from "./plan-sandbox.js";
import { runPlanSession } from "./plan-session.js";
import {
  type ExecuteStreamHandle,
  NULL_EXECUTE_STREAM,
  NULL_PLAN_STREAM,
  type PlanStreamHandle,
} from "./progress-stream.js";
import type { CodingRepoRow, CodingStore } from "./store/index.js";
import { failTaskFromCatch, recordTaskFailed } from "./task-failure.js";
import { CLAIMS, claimTask } from "./task-lifecycle.js";
import { lazySession, reapTaskSandbox } from "./task-sandbox.js";
import { safeTeardownWorktree } from "./teardown.js";
import type { WorktreeAssignment } from "./types.js";

const log = logger.child({ component: "coding.orchestrator" });

export type { StepSendEvent } from "../../inngest/index.js";

export interface CodingOrchestratorDeps {
  runInTx: Transactor;
  store: CodingStore;
  sandbox: SandboxClient;
  backend: CodingBackend;
  /**
   * Resolves the Claude Code subscription token for the sandbox env, and
   * the `github_identity:<name>` rows behind the git-remote run-branch push
   * and the failure-cascade WIP push.
   */
  secretsStore: SecretsStore;
  /** Default base image when the repo has no devcontainer override. */
  devbaseImage: string;
  /** Per-task resource caps. P2 reads these from `coding_repos` overrides. */
  defaultResourceLimits: ResourceLimits;
  /** Idle TTL for the task container — the reaper picks up after this expires. */
  taskTtlMs: number;
  /** Host root for per-task git worktrees — `${worktreesDir}/<repo>/<id-short>`. */
  worktreesDir: string;
  /**
   * Host root for per-task askpass material. On git-remote the plan phase
   * provisions it on its container, and the execute phase pushes claude's
   * edits to the run-branch from inside its sandbox — they ride to the
   * verify sandbox via the remote. Bind-mount transports share the worktree
   * on the host and need no execute-side push.
   */
  askpassBaseDir: string;
  /** The task's plan progress. Bootstrap passes the registry's; defaults to `NULL_PLAN_STREAM`. */
  openPlanStream?: (taskId: string) => Promise<PlanStreamHandle>;
  /** The task's execute progress. Bootstrap passes the registry's; defaults to `NULL_EXECUTE_STREAM`. */
  openExecuteStream?: (taskId: string) => Promise<ExecuteStreamHandle>;
  /**
   * Test-only override for the in-sandbox coding-auth resolver. Threaded
   * from `BootstrapOptions.codingAuthOverride`; production leaves it
   * undefined so missing `claude_code_oauth_token` still fails fast.
   */
  loadCodingSandboxEnv?: typeof loadCodingSandboxEnv;
}

export interface CodingOrchestratorResult {
  /**
   * `skipped` covers two different outcomes, distinguishable in the logs:
   * a duplicate `coding/task/start` that another run already claimed (nothing
   * happened), and a task cancelled while `plan-cli` was streaming (the
   * worktree, sandbox and askpass were reclaimed on the way out).
   */
  status: "awaiting_approval" | "failed" | "skipped";
  plan?: string;
  failureReason?: string;
}

export interface CodingExecuteResult {
  status: "pending_verify" | "failed" | "skipped";
  failureReason?: string;
}

/**
 * `retries: 0`: the plan-mode `claude` session can't resume mid-stream, so
 * a retry after the session id is captured would start a fresh CLI session
 * that doesn't match what's persisted, and replay the streamed plan too.
 * Failures are terminal for the task; the user re-delegates.
 */
export function createCodingOrchestrator(deps: CodingOrchestratorDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-task-start",
      triggers: [codingTaskStart],
      retries: 0,
      // Sequentialize per task — guards against duplicate fires.
      concurrency: { limit: 1, key: "event.data.taskId" },
    },
    async ({ event, step, runId }) => {
      return runCodingTask({
        taskId: event.data.taskId,
        runId,
        deps,
        stepRun: step.run,
        stepSendEvent: step.sendEvent,
      });
    },
  );
}

/**
 * Consumes `coding/task/plan-approved` and runs `claude -p --resume <sid>
 * --permission-mode bypassPermissions` in the task container (recreating it
 * if the reaper got it first). Sandbox isolation is the security boundary;
 * the CLI resolves every tool call locally. `retries: 0` for the same
 * reason as the plan function: file edits inside the container are not
 * idempotent under retry.
 */
export function createCodingExecuteOrchestrator(deps: CodingOrchestratorDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-task-execute",
      triggers: [codingTaskPlanApproved],
      retries: 0,
      concurrency: { limit: 1, key: "event.data.taskId" },
    },
    async ({ event, step, runId }) => {
      return runCodingExecute({
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
  deps: CodingOrchestratorDeps;
  stepRun: StepRun;
  /** See {@link CodingRun.stepSendEvent}. */
  stepSendEvent: StepSendEvent;
}

interface ExecuteRunParams extends RunParams {
  /** Emits `coding/task/cli-done`, the hand-off to the verify orchestrator. */
  inngest: Pick<Inngest, "send">;
}

/**
 * The plan orchestration. `stepRun` is Inngest's `step.run` in production
 * and an inline shim in tests, so this runs without booting Inngest.
 */
export async function runCodingTask(params: RunParams): Promise<CodingOrchestratorResult> {
  const { deps } = params;
  const run = codingRun(params, log);
  const { task, repo } = await loadTaskAndRepo(deps, run.taskId);

  // A duplicate `coding/task/start` returns here, before `sandbox.create`
  // mints a second container and `plan-cli` pays for a second session.
  // `delegate`'s `task-start-<id>` emit id collapses a re-send inside the
  // bus's dedup window; this claim holds outside it.
  const claim = await claimTask(run, deps, CLAIMS.plan);
  if (claim.kind === "lost") {
    run.log.info(
      { claim: claim.transition },
      "plan: status transition lost the race (already started or terminated)",
    );
    return { status: "skipped" };
  }

  // Null on a fresh task until allocation; the catch tears down whatever
  // allocation got as far as assigning.
  let assignment = task.worktreeAssignment;
  // Ahead of the try, so a failure before the CLI streams still reaches it.
  const stream = await (deps.openPlanStream ?? (async () => NULL_PLAN_STREAM))(run.taskId);
  const askpass = new AskpassLease(deps.askpassBaseDir, run.taskId);
  try {
    const worktree = await allocateTaskWorktree(run, deps, {
      repo,
      persisted: assignment,
      onAssigned: (next) => {
        assignment = next;
      },
    });
    const state = await preparePlanSandbox(run, deps, {
      task,
      repo,
      assignment: worktree,
      askpass,
    });
    const result = await runPlanSession(run, deps, { task, repo, state, stream });
    if (result.isError || !result.plan) {
      const reason = result.failureReason ?? "plan phase produced no plan";
      return await endPlanFailed(run, deps, { repo, assignment: worktree, stream }, reason);
    }
    const plan = result.plan;
    await run.stepRun("persist-plan", () =>
      deps.runInTx((tx) => deps.store.setTaskPlan(tx, run.taskId, plan)),
    );
    const gate = await parkPlanAtGate(run, deps, {
      task,
      repo,
      assignment: worktree,
      plan,
      stream,
    });
    if (gate === "left_planning") return { status: "skipped" };
    return { status: "awaiting_approval", plan };
  } catch (err) {
    const reason = describeError(err);
    run.log.error({ err }, "coding task failed");
    await failTaskFromCatch(run, deps, reason);
    if (assignment) {
      await safeTeardownWorktree({
        runInTx: deps.runInTx,
        secretsStore: deps.secretsStore,
        repo,
        taskId: run.taskId,
        worktreeAssignment: assignment,
      }).catch(() => {});
    }
    await deps.sandbox.deleteByTaskId(run.taskId).catch(() => {});
    // Best-effort — don't let a delivery failure mask the original error.
    await stream.fail(reason).catch(() => {});
    return { status: "failed", failureReason: reason };
  } finally {
    askpass.release();
  }
}

/** The plan session failed or produced no plan. */
async function endPlanFailed(
  run: CodingRun,
  deps: CodingOrchestratorDeps,
  args: { repo: CodingRepoRow; assignment: WorktreeAssignment; stream: PlanStreamHandle },
  reason: string,
): Promise<CodingOrchestratorResult> {
  await recordTaskFailed(run, deps, reason, "set-status-failed");
  await run.stepRun("teardown-worktree", () =>
    safeTeardownWorktree({
      runInTx: deps.runInTx,
      secretsStore: deps.secretsStore,
      repo: args.repo,
      taskId: run.taskId,
      worktreeAssignment: args.assignment,
    }),
  );
  await reapTaskSandbox(run, deps.sandbox, "teardown");
  // The status is committed: a subscriber error must not reach the catch
  // and write a second failed status that masks this reason.
  await args.stream.fail(reason).catch((streamErr: unknown) => {
    run.log.warn({ err: streamErr }, "plan stream fail notification failed");
  });
  return { status: "failed", failureReason: reason };
}

/**
 * The execute orchestration. Same `stepRun` injection as `runCodingTask`.
 */
export async function runCodingExecute(params: ExecuteRunParams): Promise<CodingExecuteResult> {
  const { deps } = params;
  const run = codingRun(params, log);
  const { task, repo } = await loadTaskAndRepo(deps, run.taskId);

  const claim = await claimTask(run, deps, CLAIMS.execute);
  if (claim.kind === "lost") {
    run.log.info(
      { transition: claim.transition },
      "execute: status transition lost the race (already cancelled or transitioned)",
    );
    return { status: "skipped" };
  }

  // Ahead of the checks and the try, so every failure from here reaches it.
  const stream = await (deps.openExecuteStream ?? (async () => NULL_EXECUTE_STREAM))(run.taskId);
  const { sessionId, worktreeAssignment: assignment } = await checkExecutable(task, stream);
  const exit = { repo, assignment, stream };

  const askpass = new AskpassLease(deps.askpassBaseDir, run.taskId);
  try {
    const sandbox = await acquireExecuteSandbox(run, deps, { task, repo, assignment, askpass });
    const container = lazySession(deps.sandbox, sandbox.state);
    const result = await runExecuteSession(run, deps, {
      task,
      repo,
      sessionId,
      container,
      stream,
    });
    if (result.isError) {
      const reason = result.failureReason ?? "execute phase failed";
      await endExecuteFailed(run, deps, exit, reason, {
        status: "set-status-failed",
        teardownWorktree: "teardown-worktree",
        teardown: "teardown",
        sandboxDeleted: "persist-sandbox-deleted",
        logSuffix: "",
      });
      return { status: "failed", failureReason: reason };
    }
    await persistSessionUsage(run, deps, result.usage);
    if (sandbox.push) {
      const pushFailure = await pushExecuteChanges(run, {
        task,
        assignment,
        credentials: sandbox.push,
        container,
      });
      if (pushFailure !== null) {
        // `safeTeardownWorktree` is a no-op for git-remote, the only
        // transport that pushes here, so no worktree teardown step.
        await endExecuteFailed(run, deps, exit, pushFailure, {
          status: "set-status-failed-after-push",
          teardownWorktree: null,
          teardown: "teardown-after-push-failure",
          sandboxDeleted: "persist-sandbox-deleted-after-push-failure",
          logSuffix: " (push failure)",
        });
        return { status: "failed", failureReason: pushFailure };
      }
    }
    const handOff = await handOffToVerify(run, deps, params.inngest, {
      ...exit,
      usage: result.usage,
    });
    return handOff === "handed_off" ? { status: "pending_verify" } : { status: "skipped" };
  } catch (err) {
    const reason = describeError(err);
    run.log.error({ err }, "coding execute failed");
    await failTaskFromCatch(run, deps, reason);
    await safeTeardownWorktree({
      runInTx: deps.runInTx,
      secretsStore: deps.secretsStore,
      repo,
      taskId: run.taskId,
      worktreeAssignment: assignment,
    }).catch(() => {});
    await deps.sandbox.deleteByTaskId(run.taskId).catch(() => {});
    // So wall_clock = deleted_at - created_at is computable for a task that
    // crashed mid-execute. A no-op when no sandbox block was persisted.
    await deps
      .runInTx((tx) => deps.store.setTaskSandboxDeletedAt(tx, run.taskId, new Date().toISOString()))
      .catch(() => {});
    await stream.fail(reason).catch(() => {});
    return { status: "failed", failureReason: reason };
  } finally {
    askpass.release();
  }
}
