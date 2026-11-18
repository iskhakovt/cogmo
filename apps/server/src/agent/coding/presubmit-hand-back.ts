/**
 * The verify run's hand-back of a refused skills-repo tip to a fix pass
 * (design/coding-delegation.md → Skills-repo pre-submit → The fix pass):
 * `transition-pending-fix`, `teardown-before-fix`, then
 * `emit-presubmit-refused`, which the execute orchestrator takes as its
 * second trigger.
 */

import { match, P } from "ts-pattern";
import { codingTaskPresubmitRefused } from "../../inngest/events.js";
import type { SandboxClient } from "../../sandbox/index.js";
import type { AskpassLease } from "./askpass-lease.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { type TaskLeft, taskLeft } from "./task-lifecycle.js";

/**
 * `advanced`: the task is at `pending_fix` with the next pass granted.
 * `failed_by_run`: the task reads `failed` with `presubmit_refused`, which
 * only this run's own memoized `transition-presubmit-failed` writes, from a
 * build that failed every refusal. `settled`: it reads `pushed` or `pr_open`,
 * which only this run's own memoized steps reach, from a build whose
 * pre-submit always proceeded. `left`: another writer moved it.
 */
export type PendingFix =
  | { kind: "advanced" }
  | { kind: "failed_by_run" }
  | { kind: "settled" }
  | TaskLeft;

/**
 * `transition-pending-fix`: `verifying → pending_fix` at pass `fixPass`, the
 * run's own refusal on the row. The claim pins the count, so the row at
 * `verifying`, or at `pending_fix` with a count other than `fixPass + 1`, is
 * an invariant violation, and the step throws.
 */
export async function transitionPendingFix(
  run: CodingRun,
  deps: TaskStoreDeps,
  fixPass: number,
): Promise<PendingFix> {
  const transition = await run.stepRun("transition-pending-fix", async () => {
    const written = await deps.runInTx((tx) =>
      deps.store.transitionTaskPendingFix(tx, run.taskId, { runId: run.runId, fixPass }),
    );
    const violated = ({ status, fixPasses }: { status: string; fixPasses: number }): never => {
      throw new Error(
        `coding task ${run.taskId} at ${status} with ${fixPasses} fix passes, not this run's refusal at pass ${fixPass}`,
      );
    };
    return match(written)
      .with({ kind: "not_found" }, () => {
        throw new Error(`coding task ${run.taskId} vanished before transition-pending-fix`);
      })
      .with({ kind: "stale", status: "verifying" }, violated)
      .with(
        { kind: "stale", status: "pending_fix", fixPasses: P.when((n) => n !== fixPass + 1) },
        violated,
      )
      .with({ kind: "transitioned" }, { kind: "stale" }, (owned) => owned)
      .exhaustive();
  });
  return match(transition)
    .returnType<PendingFix>()
    .with({ kind: "transitioned" }, { kind: "stale", status: "pending_fix" }, () => ({
      kind: "advanced",
    }))
    .with({ kind: "stale", status: "failed", failureReason: "presubmit_refused" }, () => ({
      kind: "failed_by_run",
    }))
    .with({ kind: "stale", status: P.union("pushed", "pr_open") }, () => ({ kind: "settled" }))
    .with({ kind: "stale" }, (stale) => taskLeft(stale))
    .exhaustive();
}

/** `emit-presubmit-refused`, under `presubmit-refused-<taskId>-f<n>` for the pass it grants. */
export async function emitPresubmitRefused(run: CodingRun, fixPass: number): Promise<void> {
  await run.stepSendEvent("emit-presubmit-refused", {
    ...codingTaskPresubmitRefused.create({ taskId: run.taskId, fixPass }),
    id: `presubmit-refused-${run.taskId}-f${fixPass}`,
  });
}

/**
 * The verify run's sandbox and askpass dir. A hand-back reaps both in
 * `teardown-before-fix`, ahead of the emit, since the fix pass's sandbox
 * carries the same task label and askpass path; the run's `finally` reaps
 * them otherwise. Only that step's returned result moves the reap.
 */
export class VerifySandboxLease {
  readonly #sandbox: Pick<SandboxClient, "deleteByTaskId">;
  readonly #askpass: AskpassLease;
  #tornDown = false;

  constructor(sandbox: Pick<SandboxClient, "deleteByTaskId">, askpass: AskpassLease) {
    this.#sandbox = sandbox;
    this.#askpass = askpass;
  }

  /** `teardown-before-fix`. Inside the step, so no replay releases a path the fix pass has provisioned. */
  async tearDownBeforeFix(run: CodingRun): Promise<void> {
    await run.stepRun("teardown-before-fix", async () => {
      await this.#reap(run);
    });
    this.#tornDown = true;
  }

  /** The `finally`'s sweep and release, unless `teardown-before-fix` has returned. */
  async release(run: CodingRun): Promise<void> {
    if (this.#tornDown) return;
    await this.#reap(run);
  }

  async #reap(run: CodingRun): Promise<void> {
    // Idempotent at the label-index layer, and it reaps managed-backend state
    // a thrown create left behind.
    await this.#sandbox.deleteByTaskId(run.taskId).catch((err: unknown) => {
      run.log.warn({ err }, "verify: deleteByTaskId failed");
    });
    // After the sweep: on Local-Docker `deleteByTaskId` already wiped the
    // bind-mount source, and this idempotent release still removes the host
    // dir on Daytona, where only the sandbox-side copy is wiped.
    this.#askpass.release();
  }
}
