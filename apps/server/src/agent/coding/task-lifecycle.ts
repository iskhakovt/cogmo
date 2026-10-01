/**
 * The coding task's run-ownership claims. Each orchestrator opens by moving
 * the task out of the status its trigger event hands over; the transition
 * table as a whole lives in design/coding-delegation.md → Task lifecycle.
 */

import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { CodingStore, CodingTaskStatus } from "./store/index.js";

interface Claim {
  stepId: string;
  from: CodingTaskStatus;
  to: CodingTaskStatus;
}

/** Step ids are a contract with runs in flight: never rename one. */
export const CLAIMS = {
  plan: { stepId: "claim-task-planning", from: "queued", to: "planning" },
  execute: { stepId: "set-status-executing", from: "awaiting_approval", to: "executing" },
  verify: { stepId: "set-status-verifying", from: "pending_verify", to: "verifying" },
} as const satisfies Record<string, Claim>;

export type TransitionResult = Awaited<ReturnType<CodingStore["transitionTaskStatus"]>>;

export type ClaimOutcome = { kind: "owned" } | { kind: "lost"; transition: TransitionResult };

/**
 * Takes the run's ownership claim: a conditional `from → to` UPDATE stamping
 * `claimed_by_run_id`, inside a step so the bare body branches on the
 * memoized result rather than on a status its own steps go on to change.
 *
 * Callers sit it ahead of their failure machinery: a run that loses the race
 * must not reach the catch that fails the task and reaps the sandbox out from
 * under the run that owns it.
 *
 * `stale` at the claim's own target is ambiguous by status alone. It is either
 * this run's earlier attempt — the UPDATE committed and the step result was
 * lost — which must resume, or a duplicate delivery finding a dead run's row,
 * which must not mint a second sandbox and a second paid CLI session.
 * `claimedByRunId` separates them: a fresh delivery is a fresh Inngest run.
 * A row at the target with no claimant (every row predating migration 0054)
 * is adopted by the transition itself and comes back `transitioned`.
 */
export async function claimTask(
  run: CodingRun,
  deps: TaskStoreDeps,
  claim: Claim,
): Promise<ClaimOutcome> {
  const transition = await run.stepRun(claim.stepId, () =>
    deps.runInTx((tx) =>
      deps.store.transitionTaskStatus(tx, run.taskId, claim.from, claim.to, run.runId),
    ),
  );
  const owned =
    transition.kind === "transitioned" ||
    (transition.kind === "stale" &&
      transition.status === claim.to &&
      transition.claimedByRunId === run.runId);
  return owned ? { kind: "owned" } : { kind: "lost", transition };
}
