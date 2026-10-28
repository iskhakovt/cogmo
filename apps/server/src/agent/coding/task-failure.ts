/**
 * The coding orchestrators' failure channel: `status = failed` plus
 * `coding/task/failed`, which the cleanup subscribers (run-branch deletion)
 * hook into without polling the row. A failure is a `TaskFailure`: the
 * `coding_task_failure_reason` the writer's branch stands for, and the
 * masked text that branch had. Both functions mask the detail with
 * `redactSecretsInText` before writing or emitting it, since it can carry git
 * or SDK error text, and resolve to the masked failure so the caller's chat
 * message and return value carry the same text.
 */

import { match } from "ts-pattern";
import { codingTaskFailed } from "../../inngest/events.js";
import { describeError } from "../../util/describe-error.js";
import { redactSecretsInText } from "../../util/redact-secrets.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingTaskStatus } from "./store/index.js";
import type { CodingTaskFailureReason, TaskFailure } from "./types.js";

/** `failure`, its detail masked. */
export function maskTaskFailure(failure: TaskFailure): TaskFailure {
  return { reason: failure.reason, detail: redactSecretsInText(failure.detail) };
}

/** A thrown error as a failure: the orchestrators' catch path. */
function unexpectedFailure(err: unknown): TaskFailure {
  return { reason: "unexpected_error", detail: describeError(err) };
}

const FAILURE_LABELS: Readonly<Record<CodingTaskFailureReason, string>> = {
  cli_exit_error: "The CLI session failed",
  no_plan_produced: "The plan session produced no plan",
  claude_auth_failed: "Claude Code authentication failed",
  push_failed: "The push failed",
  branch_conflict: "The push was rejected: branch conflict",
  auth_failed: "The push was rejected: GitHub authentication failed",
  verify_failed: "Verify failed",
  verify_timed_out: "Verify timed out",
  pr_auth_failed: "PR open failed: GitHub authentication failed",
  pr_validation_failed: "PR open failed: GitHub rejected the request",
  pr_open_failed: "PR open failed",
  credentials_unavailable: "Credentials unavailable",
  run_terminated: "The run terminated abnormally",
  start_emit_failed: "The task could not be started",
  unexpected_error: "Unexpected error",
  user_cancelled: "Cancelled by the user",
  user_requested_revisions: "The user requested revisions",
  unknown: "Unknown failure",
};

/** One line for the user: the reason's label, then the detail where there is one. */
export function describeTaskFailure(failure: TaskFailure): string {
  const label = FAILURE_LABELS[failure.reason];
  return failure.detail === "" ? label : `${label}: ${failure.detail}`;
}

/**
 * Emits `coding/task/failed` under `task-failed-<taskId>`, which collapses a
 * repeat fire for the same task inside the bus's dedup window.
 */
async function emitTaskFailed(run: CodingRun, failure: TaskFailure): Promise<void> {
  await run.stepSendEvent("emit-task-failed", {
    ...codingTaskFailed.create({ taskId: run.taskId, ...failure }),
    id: `task-failed-${run.taskId}`,
  });
}

/**
 * `recorded`: the task reads `failed` and `coding/task/failed` is out;
 * `failure` is the masked failure this run emitted and reports, and the row's
 * `failure_reason` / `failure_detail` unless reconcile wrote `failed` first.
 * `ended`: the task was already terminal under another writer — a Cancel
 * during the session — so nothing was written or emitted, and the run
 * reclaims what it holds instead of reporting a failure.
 */
export type RecordedFailure =
  | { kind: "recorded"; failure: TaskFailure }
  | { kind: "ended"; status: CodingTaskStatus };

/**
 * A failure the run's normal flow observed (a CLI error, a failed verify, a
 * rejected push): a conditional `→ failed` as its own step, then the event.
 *
 * The transition fires only on a non-terminal row, so a Cancel that landed
 * while the session streamed stays `cancelled`. A row already at `failed`
 * counts as recorded: this step re-executing after a lost result, or
 * `coding-task-reconcile` getting there first — either way the task reads
 * `failed` and the emit's `task-failed-<taskId>` id absorbs the repeat.
 */
export async function recordTaskFailed(
  run: CodingRun,
  deps: TaskStoreDeps,
  failure: TaskFailure,
  transitionStepId: string,
): Promise<RecordedFailure> {
  const masked = maskTaskFailure(failure);
  const transition = await run.stepRun(transitionStepId, () =>
    deps.runInTx((tx) => deps.store.failTaskIfNonTerminal(tx, run.taskId, masked)),
  );
  return await match(transition)
    .with(
      { kind: "failed" },
      { kind: "already_terminal", status: "failed" },
      async (): Promise<RecordedFailure> => {
        await emitTaskFailed(run, masked);
        return { kind: "recorded", failure: masked };
      },
    )
    .with({ kind: "already_terminal" }, async ({ status }): Promise<RecordedFailure> => {
      run.log.info({ status }, "task ended under the run before its failure — not recorded");
      return { kind: "ended", status };
    })
    .with({ kind: "not_found" }, () => {
      // The row this run claimed at its head cannot have gone missing.
      throw new Error(`coding task ${run.taskId} vanished before its failure was recorded`);
    })
    .exhaustive();
}

/**
 * A failure that reached an orchestrator's catch, recorded as
 * `unexpected_error`. Deliberately broad: every throw, `StepError` from a
 * permanently-failed step included, belongs in this one designed channel.
 *
 * The emit goes first. If `step.sendEvent` exhausts its retries on a real bus
 * outage, the catch throws, the function fails, and `inngest/function.failed`
 * reaches `coding-task-reconcile`, which re-emits for a row it still finds
 * non-terminal. A status write landing first would leave the row terminal,
 * and reconcile would skip it as `already_terminal`.
 *
 * Letting the status write throw is load-bearing too: a DB blip after a
 * successful emit would otherwise return normally to Inngest, suppress
 * `function.failed`, and leave the row non-terminal for good.
 */
export async function failTaskFromCatch(
  run: CodingRun,
  deps: TaskStoreDeps,
  err: unknown,
): Promise<TaskFailure> {
  const failure = maskTaskFailure(unexpectedFailure(err));
  await emitTaskFailed(run, failure);
  await deps.runInTx((tx) =>
    deps.store.updateTaskStatus(tx, { id: run.taskId, status: "failed", failure }),
  );
  return failure;
}
