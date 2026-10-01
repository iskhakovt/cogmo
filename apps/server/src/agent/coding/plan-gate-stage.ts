/**
 * The plan phase's gate stage: park the finished plan at
 * `awaiting_approval`, and clear the gate in-run when no human tap is owed.
 */

import { match } from "ts-pattern";
import { codingTaskPlanApproved } from "../../inngest/events.js";
import type { SandboxClient } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { planGateEmission } from "./plan-gate.js";
import type { PlanStreamHandle } from "./progress-stream.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import { safeTeardownWorktree } from "./teardown.js";
import type { WorktreeAssignment } from "./types.js";

export interface PlanGateDeps extends TaskStoreDeps {
  sandbox: Pick<SandboxClient, "deleteByTaskId">;
  secretsStore: SecretsStore;
}

/** Who clears a task's plan gate. */
type Gate = "human_tap" | "profile_autoapprove" | "no_interactive_gate";

/**
 * `parked`: the plan awaits approval (and, if this run cleared the gate,
 * execute has been handed off). `left_planning`: the task moved out of
 * `planning` under this run, which no longer owns it.
 */
export type PlanGateOutcome = "parked" | "left_planning";

/**
 * Every trigger parks the plan at `awaiting_approval` — the status means
 * "plan is ready, the approval gate is what happens next" — and
 * `coding-task-execute` stays the only writer of `executing`. What differs
 * is who clears the gate: the human's Telegram tap (a separate run) for a
 * `user` task with autoapprove off; this run for autoapprove on, and for
 * `evolution` / `signal_pipeline`, which have no interactive gate by design
 * (the PR merge is their human checkpoint).
 */
export async function parkPlanAtGate(
  run: CodingRun,
  deps: PlanGateDeps,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    assignment: WorktreeAssignment;
    plan: string;
    stream: PlanStreamHandle;
  },
): Promise<PlanGateOutcome> {
  const { task, stream } = args;
  const gate = await resolveGate(run, deps, task);

  // Conditional on `planning`: `plan-cli` runs for minutes, and a Cancel
  // landing inside it takes `cancelTaskIfActive`'s `FOR UPDATE` path and
  // writes `cancelled`. An unconditional write here would resurrect that
  // task, render an approval keyboard for work the user already cancelled,
  // and put the row back into `countActiveTasksForRepo`. No `runId`: this
  // is not an ownership claim, and supplying one would widen the store's
  // predicate to adopt an unclaimed row at the target.
  const awaiting = await run.stepRun("set-status-plan-ready", () =>
    deps.runInTx((tx) =>
      deps.store.transitionTaskStatus(tx, run.taskId, "planning", "awaiting_approval"),
    ),
  );
  // `stale` at the target is this step re-executing after a lost result.
  if (
    awaiting.kind !== "transitioned" &&
    !(awaiting.kind === "stale" && awaiting.status === "awaiting_approval")
  ) {
    // A task that ENDED (cancelled, or failed by a sibling run's catch) has
    // no owner, so this run reclaims what it allocated. One that moved
    // FORWARD is being worked by another run on those very resources.
    const ended =
      awaiting.kind === "stale" &&
      (awaiting.status === "cancelled" || awaiting.status === "failed");
    run.log.info({ awaiting, ended }, "plan: task left `planning` mid-session — stopping");
    if (ended) await reclaimEndedPlan(run, deps, args);
    return "left_planning";
  }

  const clearsGateInRun = gate !== "human_tap";
  // Durable because two more boundaries follow when this run clears the
  // gate, and a bare-body finalize would re-render the plan message on
  // each. Once the status is committed a subscriber error must not regress
  // the task to failed, so it is logged, not thrown.
  await run.stepRun("notify-plan-finalized", async () => {
    await stream
      .finalize(args.plan, { autoApproved: clearsGateInRun })
      .catch((streamErr: unknown) => {
        run.log.warn(
          { err: streamErr },
          "plan stream finalize notification failed (task already awaiting_approval)",
        );
      });
    return null;
  });
  if (clearsGateInRun) await clearGateInRun(run, deps, gate);
  return "parked";
}

/**
 * Exhaustive over `coding_trigger_source` on purpose: a new member is a
 * compile error here rather than a silent default into the ungated arm,
 * which would hand it an unattended `--permission-mode bypassPermissions`
 * session. Only the user path pays for the autoapprove read — skipping it
 * keeps a step boundary off the automated path.
 */
async function resolveGate(
  run: CodingRun,
  deps: TaskStoreDeps,
  task: CodingTaskRow,
): Promise<Gate> {
  const autoapproveMode =
    task.triggerSource === "user"
      ? ((await run.stepRun("resolve-autoapprove-mode", () =>
          deps.runInTx((tx) => deps.store.getCodingAutoapproveModeForTask(tx, run.taskId)),
        )) ?? "off")
      : "off";
  return match(task.triggerSource)
    .with("user", (): Gate => (autoapproveMode === "on" ? "profile_autoapprove" : "human_tap"))
    .with("evolution", "signal_pipeline", (): Gate => "no_interactive_gate")
    .exhaustive();
}

/**
 * The same two effects as the Telegram approve callback: stamp
 * `plan_approved_at`, emit `coding/task/plan-approved`. The timestamp
 * records when the gate cleared, not that a human cleared it.
 * `approvePlanIfPending` is atomic against a Cancel landing between
 * `set-status-plan-ready` and here, which leaves the task cancelled.
 */
async function clearGateInRun(run: CodingRun, deps: TaskStoreDeps, gate: Gate): Promise<void> {
  // `approvedAt` is minted inside the step, so a replay's cached return
  // carries the original. `planGateEmission` is the decision the Telegram
  // callback makes too; see it for why a stamp already there still owes an
  // emit.
  const approveResult = await run.stepRun("auto-approve-plan", async () => {
    const approvedAt = new Date();
    const result = await deps.runInTx((tx) =>
      deps.store.approvePlanIfPending(tx, run.taskId, approvedAt),
    );
    return { kind: result.kind, emission: planGateEmission(result, approvedAt) };
  });
  if (!approveResult.emission) {
    // `not_pending` / `not_found`: the task left `awaiting_approval` under
    // us (a cancel, or a sibling run's failure cascade), so the emit is
    // correctly withheld.
    run.log.info(
      { gate, kind: approveResult.kind },
      "plan gate not cleared — task no longer awaiting approval",
    );
    return;
  }
  await run.stepSendEvent("emit-plan-approved", {
    ...codingTaskPlanApproved.create({
      taskId: run.taskId,
      approvedAt: approveResult.emission.approvedAt,
    }),
    // Collapses the recovery arm's deliberate re-emits — from this step and
    // from the Telegram tap alike — into one execute run inside the bus's
    // window. Safe across the task's lifetime because a Revise cancels the
    // task and re-plans under a fresh `taskId`; an in-place re-plan flow
    // would need a new id.
    id: `plan-approved-${run.taskId}`,
  });
  run.log.info({ gate, kind: approveResult.kind }, "plan gate cleared in-run — execute handed off");
}

/**
 * Reclaims the worktree, sandbox and stream of a task that ended while
 * planning. The run returns from inside its `try`, past the catch that
 * normally owns cleanup, so it happens here. The status stays exactly as
 * the canceller wrote it: `safeTeardownWorktree` only reads it, and a
 * sandbox delete failure is logged rather than thrown, since reaching the
 * catch would overwrite `cancelled` with `failed`. The periodic reaper is
 * the backstop.
 */
async function reclaimEndedPlan(
  run: CodingRun,
  deps: PlanGateDeps,
  args: { repo: CodingRepoRow; assignment: WorktreeAssignment; stream: PlanStreamHandle },
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
  await run.stepRun("teardown-cancelled", () =>
    deps.sandbox
      .deleteByTaskId(run.taskId)
      .then(() => null)
      .catch((err: unknown) => {
        run.log.warn({ err }, "cancelled-path teardown failed — sandbox left to the reaper");
        return null;
      }),
  );
  await args.stream.fail("Task cancelled while planning.").catch(() => {});
}
