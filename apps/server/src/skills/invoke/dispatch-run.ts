import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { DispatchDecision } from "../protocol.js";
import type { SkillStore } from "../store/index.js";

/**
 * How long past its wall clock a dispatched run has to report before the
 * sweeper takes it as lost: the runtime's kill, its grace, the result frame
 * and a one-shot container's teardown, which precedes the record
 * (design/skills.md → Stuck runs).
 */
const DISPATCH_GRACE_S = 60;

/** When a run dispatched at `now` with `wallClockS` is lost if it has not reported. */
export function dispatchDeadline(now: Date, wallClockS: number): Date {
  return new Date(now.getTime() + (wallClockS + DISPATCH_GRACE_S) * 1000);
}

/**
 * The `started → dispatched` transition a runtime takes immediately before it
 * sends the task. `withhold` when the sweeper finished the run first: the
 * task must not be sent, and the run's own error is what the invocation
 * returns.
 */
export async function dispatchRun(
  deps: { store: SkillStore; runInTx: Transactor },
  args: { runId: string; deadlineAt: Date },
): Promise<DispatchDecision> {
  const transition = await deps.runInTx((tx) =>
    deps.store.transitionToDispatched(tx, { id: args.runId, deadlineAt: args.deadlineAt }),
  );
  return match(transition)
    .returnType<DispatchDecision>()
    .with({ kind: "dispatched" }, () => ({ kind: "send" }))
    .with({ kind: "swept" }, () => ({ kind: "withhold" }))
    .exhaustive();
}
