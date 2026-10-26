/**
 * The coding orchestrators' failure channel: `status = failed` plus
 * `coding/task/failed`, which the cleanup subscribers (run-branch deletion)
 * hook into without polling the row. Both functions mask the reason with
 * `redactSecretsInText` before writing or emitting it, since it can carry git
 * or SDK error text, and resolve to the masked reason so the caller's chat
 * message and return value carry the same text.
 */

import { codingTaskFailed } from "../../inngest/events.js";
import { redactSecretsInText } from "../../util/redact-secrets.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";

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
 * A failure the run's normal flow observed (a CLI error, a failed verify, a
 * rejected push): the status write as its own step, then the event.
 */
export async function recordTaskFailed(
  run: CodingRun,
  deps: TaskStoreDeps,
  reason: string,
  statusStepId: string,
): Promise<string> {
  const failureReason = redactSecretsInText(reason);
  await run.stepRun(statusStepId, () =>
    deps.runInTx((tx) =>
      deps.store.updateTaskStatus(tx, { id: run.taskId, status: "failed", failureReason }),
    ),
  );
  await emitTaskFailed(run, failureReason);
  return failureReason;
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
