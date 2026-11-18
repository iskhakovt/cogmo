/**
 * Posts a skills-repo task's failure into its conversation when no run
 * renders it (design/coding-delegation.md → Skills-repo pre-submit →
 * Announcing): after the first execute session verify publishes nothing, and
 * the registry has released the execute stream, so a task that had a fix
 * pass announces any failure. Subscribes to
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
      reason: "reason_not_announced" | "task_not_found" | "not_skills_repo" | "no_conversation";
    };

/** The failures no run renders on a skills-repo task that had no fix pass: the pre-submit's own. */
const ANNOUNCED_REASONS: ReadonlyArray<CodingTaskFailureReason> = [
  "presubmit_refused",
  "presubmit_stale_base",
];

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
  const loaded = await deps.runInTx(async (tx) => {
    const task = await deps.store.getTask(tx, taskId);
    const repo = task && (await deps.store.getRepoById(tx, task.repoId));
    return task && repo ? { task, repo } : null;
  });
  if (loaded === null) return { kind: "skipped", reason: "task_not_found" };
  const { task, repo } = loaded;
  if (repo.name !== SKILLS_CODING_REPO_NAME) return { kind: "skipped", reason: "not_skills_repo" };
  if (!ANNOUNCED_REASONS.includes(failed.reason) && task.presubmitFixPasses === 0) {
    return { kind: "skipped", reason: "reason_not_announced" };
  }
  if (task.conversationId === null) return { kind: "skipped", reason: "no_conversation" };
  // The pre-submit, and so a fix pass, judges a branch the verify run pushed.
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
