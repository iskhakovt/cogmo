/**
 * The coding task's status transitions as the orchestrators drive them:
 * the run-ownership claim each opens with, the conditional advances within a
 * run, and what a run does when the task leaves its status under it. The
 * transition table as a whole lives in design/coding-delegation.md → Task
 * lifecycle.
 */

import { match, P } from "ts-pattern";
import type { SandboxClient } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import {
  type CodingRepoRow,
  type CodingStore,
  type CodingTaskStatus,
  isTerminalCodingTaskStatus,
} from "./store/index.js";
import { safeTeardownWorktree } from "./teardown.js";
import type { WorktreeAssignment } from "./types.js";

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

type TransitionResult = Awaited<ReturnType<CodingStore["transitionTaskStatus"]>>;

type ClaimOutcome = { kind: "owned" } | { kind: "lost"; transition: TransitionResult };

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

/** `advanced`: the task is at `to`. `left`: it moved out of `from` under this run. */
type AdvanceOutcome = { kind: "advanced" } | TaskLeft;

/**
 * The task moved out of the status a stage expected, under the run that
 * expected it. `ended`: it went terminal (a Cancel, a sibling run's
 * failure, or `pr_open` where the advance does not settle it) — no owner
 * left, so the run reclaims what it allocated. `moved`:
 * it went forward, and another run is working on those very resources.
 */
export interface TaskLeft {
  kind: "left";
  via: "ended" | "moved";
  transition: TransitionResult;
}

interface Advance extends Claim {
  /**
   * Statuses past `to` that only this run's own later steps write. `stale`
   * at one of them is this step executing after the run already moved on —
   * a run in flight across the deploy that introduced the step — and reads
   * as advanced, so the run carries on through its memoized later steps to
   * the ones it has not run yet.
   */
  settledAt?: ReadonlyArray<CodingTaskStatus>;
}

/**
 * A conditional `from → to` UPDATE inside an already-owned run, as a step
 * whose result the bare body branches on. No `runId`: it is not an
 * ownership claim, and supplying one would widen the store's predicate to
 * adopt an unclaimed row at the target. `stale` at `to` is this step
 * re-executing after a lost result; `stale` at any other terminal status
 * (`isTerminalCodingTaskStatus`) is a task that ended under the run.
 */
export async function advanceTask(
  run: CodingRun,
  deps: TaskStoreDeps,
  advance: Advance,
): Promise<AdvanceOutcome> {
  const transition = await run.stepRun(advance.stepId, () =>
    deps.runInTx((tx) => deps.store.transitionTaskStatus(tx, run.taskId, advance.from, advance.to)),
  );
  const settled = [advance.to, ...(advance.settledAt ?? [])];
  return match(transition)
    .with({ kind: "transitioned" }, (): AdvanceOutcome => ({ kind: "advanced" }))
    .with(
      { kind: "stale", status: P.when((status) => settled.includes(status)) },
      (): AdvanceOutcome => ({ kind: "advanced" }),
    )
    .with(
      { kind: "stale", status: P.when(isTerminalCodingTaskStatus) },
      (left): AdvanceOutcome => ({ kind: "left", via: "ended", transition: left }),
    )
    .with(
      { kind: "stale" },
      (left): AdvanceOutcome => ({ kind: "left", via: "moved", transition: left }),
    )
    .with({ kind: "not_found" }, () => {
      // The row this run claimed at its head cannot have gone missing.
      throw new Error(`coding task ${run.taskId} vanished before ${advance.stepId}`);
    })
    .exhaustive();
}

/** What `reclaimEndedTask` reclaims, and whom it tells. */
interface ReclaimArgs {
  repo: CodingRepoRow;
  assignment: WorktreeAssignment;
  /**
   * `reap`: delete the task's sandbox here, then stamp
   * `resource_usage.sandbox.deleted_at` under `stampStepId` (a no-op when
   * the task never persisted a sandbox block, as on the plan run).
   * `swept_by_caller`: the verify run, whose `finally` sweeps the sandbox
   * unconditionally — or, on its pre-`try` credentials exit, has created
   * none yet — so a delete here would only double the provider round-trip.
   */
  sandbox: { kind: "reap"; stampStepId: string } | { kind: "swept_by_caller" };
  /**
   * The run's progress stream and the message it fails with; null for the
   * verify run, which has no stream of its own.
   */
  notify: { stream: { fail(message: string): Promise<void> }; message: string } | null;
}

/**
 * Reclaims the task's resources when it left by ending. A task that moved
 * forward belongs to another run, whose resources this one must not touch.
 */
export async function reclaimIfEnded(
  run: CodingRun,
  deps: ReclaimDeps,
  left: TaskLeft,
  args: ReclaimArgs,
): Promise<void> {
  await match(left.via)
    .with("ended", () => reclaimEndedTask(run, deps, args))
    .with("moved", () => Promise.resolve())
    .exhaustive();
}

type ReclaimDeps = TaskStoreDeps & {
  sandbox: Pick<SandboxClient, "deleteByTaskId">;
  secretsStore: SecretsStore;
};

/**
 * Reclaims the worktree, sandbox and stream of a task that ended under this
 * run. The run returns from inside its `try`, past the catch that normally
 * owns cleanup, so it happens here. The status stays exactly as the
 * canceller wrote it: `safeTeardownWorktree` only reads it, and a sandbox
 * delete failure is logged rather than thrown, since reaching the catch
 * would overwrite `cancelled` with `failed`. The periodic reaper is the
 * backstop.
 */
export async function reclaimEndedTask(
  run: CodingRun,
  deps: ReclaimDeps,
  args: ReclaimArgs,
): Promise<void> {
  await run.stepRun("teardown-worktree-cancelled", () =>
    safeTeardownWorktree({
      runInTx: deps.runInTx,
      secretsStore: deps.secretsStore,
      repo: args.repo,
      taskId: run.taskId,
      worktreeAssignment: args.assignment,
    }).then(() => null),
  );
  await match(args.sandbox)
    .with({ kind: "reap" }, async ({ stampStepId }) => {
      await run.stepRun("teardown-cancelled", () =>
        deps.sandbox
          .deleteByTaskId(run.taskId)
          .then(() => null)
          .catch((err: unknown) => {
            run.log.warn({ err }, "cancelled-path teardown failed — sandbox left to the reaper");
            return null;
          }),
      );
      await stampSandboxDeleted(run, deps, stampStepId);
    })
    .with({ kind: "swept_by_caller" }, () => Promise.resolve())
    .exhaustive();
  // Last, after the durable work: a bare-body notify re-fires once per
  // later boundary, and nothing follows it here.
  if (args.notify) await args.notify.stream.fail(args.notify.message).catch(() => {});
}

/**
 * Stamps `resource_usage.sandbox.deleted_at`; a no-op when no sandbox block
 * was persisted or the stamp is already there.
 */
export async function stampSandboxDeleted(
  run: CodingRun,
  deps: TaskStoreDeps,
  stepId: string,
): Promise<void> {
  await run.stepRun(stepId, () =>
    deps.runInTx((tx) =>
      deps.store.setTaskSandboxDeletedAt(tx, run.taskId, new Date().toISOString()),
    ),
  );
}
