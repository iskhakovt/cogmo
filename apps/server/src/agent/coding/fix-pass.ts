/**
 * What an execute run reads from the row on a skills-repo fix pass, inside
 * the step bodies that use it (design/coding-delegation.md → Skills-repo
 * pre-submit → The fix pass): the refused tip its git-remote checkout starts
 * from, and the findings and budget its prompt carries. Never in the bare
 * body, since the next verify run rewrites the verdict while this run's later
 * boundaries still replay.
 */

import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { AskpassMaterials } from "../../sandbox/askpass.js";
import type { SandboxClient, SandboxSessionState } from "../../sandbox/index.js";
import type { FixContext } from "./backend.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { runCheckoutFixBase } from "./commit-push.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import { WORKTREE_DIR_IN_CONTAINER } from "./task-sandbox.js";
import type { PresubmitVerdict, TaskFailure } from "./types.js";

type RefusedVerdict = Extract<PresubmitVerdict, { kind: "refused" }>;

/** The task and the refusal that granted its fix pass, which `chk_coding_tasks_fix_owed` held at `pending_fix`. */
async function loadRefusal(
  deps: TaskStoreDeps,
  taskId: string,
): Promise<{ task: CodingTaskRow; refusal: RefusedVerdict }> {
  const task = await deps.runInTx((tx) => deps.store.getTask(tx, taskId));
  if (!task) throw new Error(`coding task ${taskId} vanished during its fix pass`);
  const refusal = task.presubmitVerdict;
  if (refusal?.kind !== "refused") {
    throw new Error(`coding task ${taskId} has no refused pre-submit verdict for its fix pass`);
  }
  return { task, refusal };
}

/** The row and the `fix` prompt's context, for the fix session's `execute-cli` body. */
export async function loadFixContext(
  deps: TaskStoreDeps,
  taskId: string,
  repo: CodingRepoRow,
): Promise<{ task: CodingTaskRow; fix: FixContext }> {
  const { task, refusal } = await loadRefusal(deps, taskId);
  const used = (task.resourceUsage?.tokens_input ?? 0) + (task.resourceUsage?.tokens_output ?? 0);
  return {
    task,
    fix: {
      findings: refusal.findings,
      tokenBudgetLeft: Math.max(0, repo.taskTokenBudget - used),
    },
  };
}

/**
 * The fix pass's `checkout-feature-branch` on git-remote: fetch `branch` and
 * check out the refused tip under the provisioned askpass env. A fetch the
 * remote refuses on auth is the task's `auth_failed` failure.
 */
export async function checkoutFixBaseStep(
  run: CodingRun,
  deps: TaskStoreDeps & { sandbox: Pick<SandboxClient, "resume"> },
  args: { state: SandboxSessionState; branch: string; askpass: AskpassMaterials },
): Promise<Result<void, TaskFailure>> {
  const checkout = await run.stepRun("checkout-feature-branch", async () => {
    const { refusal } = await loadRefusal(deps, run.taskId);
    return runCheckoutFixBase({
      container: await deps.sandbox.resume(args.state),
      worktreeDir: WORKTREE_DIR_IN_CONTAINER,
      branch: args.branch,
      sha: refusal.sha,
      askpassEnv: args.askpass.env,
    });
  });
  return match(checkout)
    .with({ kind: "checked_out" }, () => ok<void, TaskFailure>(undefined))
    .with({ kind: "auth_failed" }, ({ output }) =>
      err<void, TaskFailure>({ reason: "auth_failed", detail: output }),
    )
    .exhaustive();
}
