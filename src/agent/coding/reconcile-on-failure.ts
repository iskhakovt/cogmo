/**
 * Reconcile a `coding_tasks` row when its orchestrator's Inngest run
 * terminated abnormally — connect-mode worker disconnect, OOM, SIGKILL,
 * or any other path where the in-worker `try/catch` inside
 * `runCodingTask` / `runCodingExecute` / `runCodingVerify` never ran.
 *
 * Subscribes to the `inngest/function.failed` system event filtered to
 * coding orchestrator function ids. Inngest fires this event
 * environment-wide for every terminal-failed run, regardless of how the
 * worker exited — strictly more general than per-function `onFailure`
 * which is documented as "after maximum retries" and observed not to
 * invoke reliably on worker disconnect
 * ([inngest/inngest#3549](https://github.com/inngest/inngest/issues/3549)).
 *
 * See design/coding-delegation.md → Worker-death reconciliation.
 *
 * Idempotency:
 *  - `failTaskIfNonTerminal` is a conditional SQL `UPDATE` keyed on
 *    `status NOT IN (terminal)`. A second reconcile invocation finds the
 *    row already `failed` and returns `already_terminal` without emitting
 *    `coding/task/failed` again. Same when the in-worker catch wrote
 *    `failed` before the reconcile arrived.
 *  - Concurrency keyed on the failing run's id so the same failed-event
 *    payload never racefights itself across replays.
 */

import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskFailed, inngestFunctionFailed } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { CodingStore } from "./store/index.js";

const log = logger.child({ component: "coding.reconcile-on-failure" });

/**
 * Inngest function ids the reconciler watches. Must match the `id` field
 * on the corresponding `inngest.createFunction({ id: ... })` call —
 * cogmo's are bare slugs (`"coding-task-start"`), but real Inngest
 * deployments may prefix with the app id. The reconciler matches by
 * suffix so either form works.
 */
const CODING_ORCHESTRATOR_FUNCTION_IDS = [
  "coding-task-start",
  "coding-task-execute",
  "coding-task-verify",
] as const;

export function matchesCodingOrchestrator(functionId: string): boolean {
  return CODING_ORCHESTRATOR_FUNCTION_IDS.some(
    (id) => functionId === id || functionId.endsWith(`-${id}`) || functionId.endsWith(`/${id}`),
  );
}

export interface CodingTaskReconcileDeps {
  runInTx: Transactor;
  store: CodingStore;
}

/**
 * Result of a single reconcile evaluation — exposed so unit tests can
 * assert. `reconciled` carries `failureReason` so the outer Inngest
 * wrapper can emit `coding/task/failed` durably (via `step.sendEvent`)
 * AFTER this returns. Putting the emit inside `reconcileCodingTaskFailure`
 * — which lives inside a `step.run` cache — was a durability bug: a
 * transient `inngest.send` failure would throw the step, the retry would
 * find the row already `failed` (DB UPDATE already committed), return
 * `already_terminal`, and the event would never be emitted. See PR #267
 * review for the full trace.
 */
export type ReconcileResult =
  | { status: "reconciled"; taskId: string; failureReason: string }
  | { status: "skipped"; reason: "not_coding_orchestrator" }
  | { status: "skipped"; reason: "missing_task_id" }
  | { status: "skipped"; reason: "task_not_found" }
  | { status: "skipped"; reason: "already_terminal"; priorStatus: string };

/**
 * Pure reconciliation logic — exported for unit tests so we don't have to
 * drive the full Inngest function wrapper to exercise the conditional
 * UPDATE + skip branches. Production callers go through
 * `createCodingTaskReconcile`, which wraps this in `step.run` and then
 * emits `coding/task/failed` via `step.sendEvent` on the `reconciled`
 * branch.
 *
 * No `inngest` dependency: event emission belongs to the durable wrapper,
 * not the cached body. This separation is the fix for the bug described
 * on `ReconcileResult` above.
 *
 * Idempotency: `failTaskIfNonTerminal` is a conditional SQL `UPDATE`
 * keyed on `status NOT IN (terminal)`. A second reconcile invocation
 * finds the row already `failed` and returns `already_terminal` — the
 * wrapper skips the emit step on that branch.
 */
export async function reconcileCodingTaskFailure(
  deps: CodingTaskReconcileDeps,
  payload: {
    functionId: string;
    runId: string;
    errorMessage: string;
    taskId: string | undefined;
  },
): Promise<ReconcileResult> {
  if (!matchesCodingOrchestrator(payload.functionId)) {
    return { status: "skipped", reason: "not_coding_orchestrator" };
  }
  if (typeof payload.taskId !== "string" || payload.taskId.length === 0) {
    log.warn(
      { functionId: payload.functionId, runId: payload.runId },
      "reconcile: failed coding-orchestrator run missing taskId",
    );
    return { status: "skipped", reason: "missing_task_id" };
  }
  const taskId = payload.taskId;
  const failureReason = `inngest run terminated abnormally (run_id ${payload.runId}, function_id ${payload.functionId}): ${payload.errorMessage}`;

  const result = await deps.runInTx((tx) =>
    deps.store.failTaskIfNonTerminal(tx, taskId, failureReason),
  );

  if (result.kind === "not_found") {
    log.warn(
      { taskId, runId: payload.runId, functionId: payload.functionId },
      "reconcile: task row not found",
    );
    return { status: "skipped", reason: "task_not_found" };
  }
  if (result.kind === "already_terminal") {
    // Either the in-worker catch won the race, or a duplicate event
    // arrived after a prior reconcile. Both are expected; no event
    // emit, no warn.
    log.info(
      {
        taskId,
        runId: payload.runId,
        functionId: payload.functionId,
        status: result.status,
      },
      "reconcile: task already in terminal state, no-op",
    );
    return {
      status: "skipped",
      reason: "already_terminal",
      priorStatus: result.status,
    };
  }

  log.warn(
    {
      taskId,
      runId: payload.runId,
      functionId: payload.functionId,
      errorMessage: payload.errorMessage,
    },
    "reconcile: coding task marked failed from inngest/function.failed",
  );
  return { status: "reconciled", taskId, failureReason };
}

export function createCodingTaskReconcile(deps: CodingTaskReconcileDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-task-reconcile",
      // `retries: 3` — a DB blip during reconcile shouldn't lose a
      // recovery. Two separate durable steps below (`reconcile`,
      // `emit-failed`) — each retries independently, and the cached
      // first step's return value carries `failureReason` forward so
      // the second step's retry has what it needs.
      retries: 3,
      // One invocation per failing run. Inngest dedups events by id on
      // the bus; the concurrency key here is defense-in-depth against
      // any path that emits twice for the same run.
      concurrency: { limit: 1, key: "event.data.run_id" },
      triggers: [inngestFunctionFailed],
    },
    async ({ event, step }) => {
      const { function_id, run_id, error } = event.data;
      const taskId = event.data.event.data.taskId;
      const errorMessage = error.message ?? error.name ?? "unknown";
      // Step 1: durable DB write. Cached on success — a retry of
      // step 2 below won't re-run this.
      const result = await step.run("reconcile", () =>
        reconcileCodingTaskFailure(deps, {
          functionId: function_id,
          runId: run_id,
          errorMessage,
          taskId,
        }),
      );
      // Step 2: durable event emission. Only fires on the
      // `reconciled` branch (the other branches don't have a new row
      // transition to announce). Explicit idempotency `id` deduplicates
      // at the Inngest bus, so a retry of this step after a transient
      // send failure doesn't double-fire `cleanup-run-branch`. Without
      // this split, a `inngest.send` failure inside the cached step 1
      // would leave the row `failed` but the event never emitted —
      // step 1's retry would see `already_terminal` and skip. See
      // PR #267 review for the bug trace.
      if (result.status === "reconciled") {
        await step.sendEvent("emit-failed", {
          ...codingTaskFailed.create({
            taskId: result.taskId,
            reason: result.failureReason,
          }),
          id: `reconcile-${run_id}`,
        });
      }
      return result;
    },
  );
}
