/**
 * Recovers `coding_tasks` rows from `inngest/function.failed` system
 * events. See design/coding-delegation.md → Worker-death reconciliation.
 */

import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskFailed, inngestFunctionFailed } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { CodingStore } from "./store/index.js";

const log = logger.child({ component: "coding.reconcile-on-failure" });

/** Matched by suffix to accept both bare and `<app>-`/`<app>/` prefixed forms. */
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

/** `failureReason` lives on the `reconciled` variant so the durable wrapper passes it to `step.sendEvent`. */
export type ReconcileResult =
  | { status: "reconciled"; taskId: string; failureReason: string }
  | { status: "skipped"; reason: "not_coding_orchestrator" }
  | { status: "skipped"; reason: "missing_task_id" }
  | { status: "skipped"; reason: "task_not_found" }
  | { status: "skipped"; reason: "already_terminal"; priorStatus: string };

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
      retries: 3,
      concurrency: { limit: 1, key: "event.data.run_id" },
      triggers: [inngestFunctionFailed],
    },
    async ({ event, step }) => {
      const { function_id, run_id, error } = event.data;
      const taskId = event.data.event.data.taskId;
      const errorMessage = error.message ?? error.name ?? "unknown";
      // DB write and event emit are separate durable steps so a retry
      // after a transient send failure doesn't re-run the cached
      // UPDATE. Bus-level dedup via the explicit `id`.
      const result = await step.run("reconcile", () =>
        reconcileCodingTaskFailure(deps, {
          functionId: function_id,
          runId: run_id,
          errorMessage,
          taskId,
        }),
      );
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
