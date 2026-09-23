import { match } from "ts-pattern";
import type { ApprovePlanResult } from "./store/index.js";

/**
 * Whether clearing a task's plan gate should emit `coding/task/plan-approved`,
 * and which timestamp the event carries. Returns `null` when no event is owed.
 *
 * Two callers clear the gate — the plan orchestrator's in-run path (profile
 * `coding_autoapprove_mode='on'`, or a trigger with no interactive gate) and
 * the Telegram Approve callback — and both have to answer the same question
 * about a stamp that is already there. Keeping the answer here is what stops
 * the two from drifting apart.
 *
 * `already_approved` emits. It means an earlier attempt committed the stamp
 * and lost its follow-through: a step result Inngest never recorded, or a
 * `send` that threw after the transaction committed. The emit is the only
 * trigger of `coding-task-execute`, so treating a present stamp as proof the
 * handoff happened leaves a task holding a plan, a stamp and no execute run —
 * and neither caller fails, so nothing reconciles it. A duplicate costs
 * nothing: the bus dedups on `plan-approved-<taskId>`, and past that window
 * the execute claim is conditional on `awaiting_approval`, so a second run
 * finds the first one's `executing` and stands down. The event then carries
 * the row's stored timestamp rather than the caller's fresh one, so payload
 * and row agree.
 *
 * `not_pending` and `not_found` owe nothing: the task was cancelled, moved on
 * under another run, or is gone.
 */
export function planGateEmission(
  result: ApprovePlanResult,
  mintedAt: Date,
): { approvedAt: string } | null {
  return match(result)
    .with({ kind: "approved" }, () => ({ approvedAt: mintedAt.toISOString() }))
    .with({ kind: "already_approved" }, (r) => ({ approvedAt: r.approvedAt.toISOString() }))
    .with({ kind: "not_pending" }, { kind: "not_found" }, () => null)
    .exhaustive();
}
