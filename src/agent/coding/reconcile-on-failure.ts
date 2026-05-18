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

/** Result of a single reconcile evaluation — exposed so unit tests can assert. */
export type ReconcileResult =
  | { status: "reconciled"; taskId: string }
  | { status: "skipped"; reason: "not_coding_orchestrator" }
  | { status: "skipped"; reason: "missing_task_id" }
  | { status: "skipped"; reason: "task_not_found" }
  | { status: "skipped"; reason: "already_terminal"; priorStatus: string };

/**
 * Pure reconciliation logic — exported for unit tests so we don't have to
 * drive the full Inngest function wrapper to exercise the conditional
 * UPDATE + emit + skip branches. Production callers go through
 * `createCodingTaskReconcile`.
 *
 * Idempotency: `failTaskIfNonTerminal` is a conditional SQL `UPDATE`
 * keyed on `status NOT IN (terminal)`. A second reconcile invocation
 * finds the row already `failed` and returns `already_terminal` — the
 * caller skips the `coding/task/failed` emit, so the existing cleanup
 * chain (`cleanup-run-branch`) doesn't double-fire.
 */
export async function reconcileCodingTaskFailure(
  deps: CodingTaskReconcileDeps,
  inngest: Pick<Inngest, "send">,
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

  // Emit `coding/task/failed` so the existing cleanup chain fires —
  // `cleanup-run-branch.ts` deletes the orphan `cogmo/run/<task-id>`
  // ref, and any downstream observer / telemetry consumer hooks in
  // without polling the DB.
  await inngest.send(codingTaskFailed.create({ taskId, reason: failureReason }));

  log.warn(
    {
      taskId,
      runId: payload.runId,
      functionId: payload.functionId,
      errorMessage: payload.errorMessage,
    },
    "reconcile: coding task marked failed from inngest/function.failed",
  );
  return { status: "reconciled", taskId };
}

export function createCodingTaskReconcile(deps: CodingTaskReconcileDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-task-reconcile",
      // `retries: 3` — a DB blip during reconcile shouldn't lose a
      // recovery, and the work is idempotent (conditional UPDATE +
      // already-terminal short-circuit).
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
      // Wrap the reconcile in one `step.run` so a duplicate event
      // delivery (Inngest retry, dev-server replay) reuses the cached
      // outcome instead of re-evaluating + re-emitting.
      return step.run("reconcile", () =>
        reconcileCodingTaskFailure(deps, inngest, {
          functionId: function_id,
          runId: run_id,
          errorMessage,
          taskId,
        }),
      );
    },
  );
}
