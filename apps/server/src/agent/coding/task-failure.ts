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

/** What the progress stream says once a run's failure is settled. */
export function describeRecordedFailure(recorded: RecordedFailure): string {
  return match(recorded)
    .with({ kind: "recorded" }, ({ failure }) => describeTaskFailure(failure))
    .with({ kind: "ended" }, ({ status }) => `The task had already ended (${status}).`)
    .exhaustive();
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
 * The same shape as {@link recordTaskFailed}: a conditional `→ failed` in its
 * own step, `record-catch-failure`, then the emit, planned on the memoized
 * outcome. The catch body re-runs at every later boundary (the failed step
 * replays its `StepError`, and the emit is a boundary of its own), so a
 * bare-body write would read itself back as terminal on the next invocation.
 * The step's id is its own: an in-run exit may already have memoized
 * `transition-failed`.
 *
 * A task already terminal — `pr_open` after a failed `emit-pr-opened`,
 * `failed` after a failed in-run `emit-task-failed`, `cancelled` under the
 * run — keeps its status and reason, and nothing is emitted. Otherwise the
 * write commits, then the emit; an emit that exhausts its retries fails the
 * function, and the task reads `failed` unannounced, the in-run exits'
 * residual. A write that throws fails the function, and reconcile, which
 * finds the row non-terminal, finishes the job.
 */
export async function failTaskFromCatch(
  run: CodingRun,
  deps: TaskStoreDeps,
  err: unknown,
): Promise<RecordedFailure> {
  const failure = maskTaskFailure(unexpectedFailure(err));
  // The failure rides in the result, so every invocation reports the text
  // the write committed.
  const written = await run.stepRun("record-catch-failure", async () => ({
    transition: await deps.runInTx((tx) =>
      deps.store.failTaskIfNonTerminal(tx, run.taskId, failure),
    ),
    failure,
  }));
  return await match(written.transition)
    .with({ kind: "failed" }, async (): Promise<RecordedFailure> => {
      await emitTaskFailed(run, written.failure);
      return { kind: "recorded", failure: written.failure };
    })
    .with({ kind: "already_terminal" }, ({ status }): RecordedFailure => {
      run.log.warn(
        { status, failure: written.failure },
        "run threw on a task already terminal — status and reason kept, not announced",
      );
      return { kind: "ended", status };
    })
    .with({ kind: "not_found" }, () => {
      // The row this run claimed at its head cannot have gone missing.
      throw new Error(`coding task ${run.taskId} vanished before its error was recorded`);
    })
    .exhaustive();
}
