import { match, P } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { TaskOutcome } from "../protocol.js";
import type {
  ExecutedOutcome,
  ExecuteRunTransition,
  PreDispatchErrorKind,
  SkillStore,
} from "../store/index.js";
import type { SkillRunResourceUsage } from "../types.js";

/**
 * The `started → executed` transition of a run its runtime never sent: the
 * pool, the worker or the populate stopped the task, or its gate withheld
 * it, so no skill code ran. Records the runtime's pausing error, saying so;
 * `swept` when the sweeper finished the run first, as it has when the gate
 * withheld the task.
 */
export async function failBeforeDispatch(
  deps: { store: SkillStore; runInTx: Transactor },
  args: {
    id: string;
    result: TaskOutcome;
    resourceUsage: SkillRunResourceUsage;
    finishedAt: Date;
  },
): Promise<{ outcome: ExecutedOutcome; transition: ExecuteRunTransition }> {
  const error = preDispatchError(args.id, args.result);
  const transition = await deps.runInTx((tx) =>
    deps.store.failBeforeDispatch(tx, {
      id: args.id,
      error,
      resourceUsage: args.resourceUsage,
      finishedAt: args.finishedAt,
    }),
  );
  return { outcome: { kind: "error", error }, transition };
}

/**
 * The failure a runtime reports for a task it never sent. Only the pool, the
 * worker and the populate stop a task before its dispatch, so an output or
 * any other kind here is a runtime bug.
 */
function preDispatchError(
  runId: string,
  result: TaskOutcome,
): { kind: PreDispatchErrorKind; message: string } {
  if (result.ok) {
    throw new Error(`skill run ${runId}: the runtime returned an output for a task it never sent`);
  }
  return match(result.errorKind)
    .returnType<{ kind: PreDispatchErrorKind; message: string }>()
    .with(P.union("runtime_unavailable", "dependency_unavailable"), (kind) => ({
      kind,
      message: `${result.error} (no skill code ran)`,
    }))
    .with(
      P.union(
        "load_failed",
        "input_invalid",
        "skill_raised",
        "skill_failed",
        "skill_retryable",
        "memory_exceeded",
        "output_invalid",
        "wall_clock_exceeded",
        "result_lost",
      ),
      (kind) => {
        throw new Error(
          `skill run ${runId}: the runtime reported ${kind} for a task it never sent`,
        );
      },
    )
    .exhaustive();
}
