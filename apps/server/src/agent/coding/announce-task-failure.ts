/**
 * Posts a skills-repo task's failure into its conversation when no run
 * renders it (design/coding-delegation.md → Skills-repo pre-submit →
 * Announcing): after the first execute session verify publishes nothing, and
 * the registry has released the execute stream. Subscribes to
 * `coding/task/failed` and emits `coding/task/failure-notice`, which the
 * channel renders as a coding-task failure.
 */

import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import type { EventPublisher } from "../../inngest/durable.js";
import { buildCodingTaskFailureNoticeEvent, codingTaskFailed } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import { SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import type { CodingStore } from "./store/index.js";
import type { CodingTaskFailureReason, TaskFailure } from "./types.js";

const log = logger.child({ component: "coding.announce-task-failure" });

export interface AnnounceTaskFailureDeps {
  runInTx: Transactor;
  store: CodingStore;
  publisher: EventPublisher;
}

/** What an announcer run did; `skipped` names why the failure gets no notice. */
export type FailureAnnouncement =
  | { kind: "announced" }
  | {
      kind: "skipped";
      reason: "reason_not_announced" | "not_skills_repo" | "no_conversation";
    };

/** Whether a skills-repo task's failure gets a notice: the pre-submit's own, which no run renders. */
const ANNOUNCED: Readonly<Record<CodingTaskFailureReason, boolean>> = {
  cli_exit_error: false,
  no_plan_produced: false,
  claude_auth_failed: false,
  push_failed: false,
  branch_conflict: false,
  auth_failed: false,
  verify_failed: false,
  verify_timed_out: false,
  presubmit_refused: true,
  presubmit_stale_base: true,
  pr_auth_failed: false,
  pr_validation_failed: false,
  pr_open_failed: false,
  credentials_unavailable: false,
  run_terminated: false,
  start_emit_failed: false,
  unexpected_error: false,
  user_cancelled: false,
  user_requested_revisions: false,
  unknown: false,
};

/**
 * Emits the notice under `failure-notice-<taskId>`, so a re-run after a lost
 * step result posts nothing twice. A task with no conversation (an automated
 * trigger) has nowhere to post it.
 */
export async function announceTaskFailure(
  deps: AnnounceTaskFailureDeps,
  failed: TaskFailure & { taskId: string },
): Promise<FailureAnnouncement> {
  const { taskId } = failed;
  if (!ANNOUNCED[failed.reason]) {
    return { kind: "skipped", reason: "reason_not_announced" };
  }
  // A failed task's row and its repo's stay: rows are never deleted, and the
  // foreign key holds the repo.
  const { task, repo } = await deps.runInTx(async (tx) => {
    const task = await deps.store.getTask(tx, taskId);
    if (!task) throw new Error(`coding task ${taskId} is missing after it failed`);
    const repo = await deps.store.getRepoById(tx, task.repoId);
    if (!repo) throw new Error(`coding repo ${task.repoId} of task ${taskId} is missing`);
    return { task, repo };
  });
  if (repo.name !== SKILLS_CODING_REPO_NAME) return { kind: "skipped", reason: "not_skills_repo" };
  if (task.conversationId === null) return { kind: "skipped", reason: "no_conversation" };
  // The pre-submit judges a branch the verify run pushed.
  if (!task.worktreeAssignment) {
    throw new Error(`coding task ${taskId} failed ${failed.reason} with no worktree_assignment`);
  }
  await deps.publisher.send(
    buildCodingTaskFailureNoticeEvent({
      conversationId: task.conversationId,
      taskId,
      reason: failed.reason,
      detail: failed.detail,
      branch: task.worktreeAssignment.branch,
    }),
  );
  log.info({ taskId, reason: failed.reason }, "announced the task's failure");
  return { kind: "announced" };
}

/**
 * Inngest function on `coding/task/failed`, durable for the run in its one
 * step, keyed per task as every `coding/task/failed` subscriber is, so a
 * repeat emit for one task collapses to one run.
 */
export function createTaskFailureAnnouncer(deps: AnnounceTaskFailureDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-announce-task-failure",
      idempotency: "event.data.taskId",
      triggers: [codingTaskFailed],
    },
    async ({ event, step }) =>
      await step.run("emit-failure-notice", () => announceTaskFailure(deps, event.data)),
  );
}
