import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { CodingStore, CodingTaskStatus } from "./store/index.js";
import type { CodingTaskCancelReason } from "./types.js";

export interface CancelCodingTaskDeps {
  runInTx: Transactor;
  codingStore: CodingStore;
}

export type CancelCodingTaskError =
  | { kind: "already_terminal"; status: CodingTaskStatus }
  | { kind: "not_found" };

/**
 * Cancel a task that has not ended, which frees its repo's admission slot. A
 * run holding the task finds it cancelled at its next conditional transition
 * and reclaims what it holds; a task no run holds is skipped by the next
 * claim, and at `awaiting_approval`, `pending_verify` or `pending_fix` its
 * bind-mount worktree stays (design/coding-delegation.md → Task lifecycle).
 */
export async function cancelCodingTask(
  deps: CancelCodingTaskDeps,
  args: { taskId: string; reason: CodingTaskCancelReason },
): Promise<Result<void, CancelCodingTaskError>> {
  const { taskId, reason } = args;
  const result = await deps.runInTx((tx) =>
    deps.codingStore.cancelTaskIfActive(tx, taskId, reason),
  );
  return match(result)
    .returnType<Result<void, CancelCodingTaskError>>()
    .with({ kind: "cancelled" }, () => ok(undefined))
    .with({ kind: "already_terminal" }, ({ status }) => err({ kind: "already_terminal", status }))
    .with({ kind: "not_found" }, () => err({ kind: "not_found" }))
    .exhaustive();
}
