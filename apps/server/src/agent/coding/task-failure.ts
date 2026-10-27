/**
 * The coding orchestrators' failure channel: `status = failed` plus
 * `coding/task/failed`, which the cleanup subscribers (run-branch deletion)
 * hook into without polling the row. Both functions mask the reason with
 * `redactSecretsInText` before writing or emitting it, since it can carry git
 * or SDK error text, and resolve to the masked reason so the caller's chat
 * message and return value carry the same text.
 */

import { match } from "ts-pattern";
import { codingTaskFailed } from "../../inngest/events.js";
import { redactSecretsInText } from "../../util/redact-secrets.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingTaskStatus } from "./store/index.js";

/**
 * Emits `coding/task/failed` under `task-failed-<taskId>`, which collapses a
 * repeat fire for the same task inside the bus's dedup window.
 */
async function emitTaskFailed(run: CodingRun, reason: string): Promise<void> {
  await run.stepSendEvent("emit-task-failed", {
    ...codingTaskFailed.create({ taskId: run.taskId, reason }),
    id: `task-failed-${run.taskId}`,
  });
}

/**
 * `recorded`: the task reads `failed` and `coding/task/failed` is out;
 * `reason` is the masked text this run emitted and reports, and the row's
 * `failure_reason` unless reconcile wrote `failed` first. `ended`: the task
 * was already terminal under another writer — a Cancel during the session —
 * so nothing was written or emitted, and the run reclaims what it holds
 * instead of reporting a failure.
 */
export type RecordedFailure =
  | { kind: "recorded"; reason: string }
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
  reason: string,
  transitionStepId: string,
): Promise<RecordedFailure> {
  const failureReason = redactSecretsInText(reason);
  const transition = await run.stepRun(transitionStepId, () =>
    deps.runInTx((tx) => deps.store.failTaskIfNonTerminal(tx, run.taskId, failureReason)),
  );
  return await match(transition)
    .with(
      { kind: "failed" },
      { kind: "already_terminal", status: "failed" },
      async (): Promise<RecordedFailure> => {
        await emitTaskFailed(run, failureReason);
        return { kind: "recorded", reason: failureReason };
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
 * A failure that reached an orchestrator's catch. Deliberately broad: every
 * throw, `StepError` from a permanently-failed step included, belongs in this
 * one designed channel.
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
  reason: string,
): Promise<string> {
  const failureReason = redactSecretsInText(reason);
  await emitTaskFailed(run, failureReason);
  await deps.runInTx((tx) =>
    deps.store.updateTaskStatus(tx, { id: run.taskId, status: "failed", failureReason }),
  );
  return failureReason;
}
