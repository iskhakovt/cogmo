/**
 * Recovers `coding_tasks` rows from `inngest/function.failed` system
 * events. See design/coding-delegation.md → Worker-death reconciliation.
 */

import type { Inngest } from "inngest";
import { z } from "zod";
import type { Transactor } from "../../db/index.js";
import { codingTaskFailed, inngestFunctionFailed } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { CodingStore } from "./store/index.js";
import { maskTaskFailure } from "./task-failure.js";
import { type TaskFailure, TaskFailureSchema } from "./types.js";

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

/**
 * What the `reconcile` step memoizes. `failure` lives on the `reconciled`
 * variant so the durable wrapper passes it to `step.sendEvent`. A run in
 * flight may hold a memo with `failureReason`, the text alone; it reads as
 * the `run_terminated` failure with that text as the detail, the only
 * failure this function writes.
 */
const ReconcileResultSchema = z.union([
  z
    .object({
      status: z.literal("reconciled"),
      taskId: z.string(),
      failure: TaskFailureSchema.optional(),
      failureReason: z.string().optional(),
    })
    .refine((memo) => memo.failure !== undefined || memo.failureReason !== undefined, {
      message: "a reconciled memo carries its failure",
    })
    .transform(({ failure, failureReason, ...rest }) => ({
      ...rest,
      failure: failure ?? { reason: "run_terminated" as const, detail: failureReason ?? "" },
    })),
  z.object({
    status: z.literal("skipped"),
    reason: z.enum(["not_coding_orchestrator", "missing_task_id", "task_not_found"]),
  }),
  z.object({
    status: z.literal("skipped"),
    reason: z.literal("already_terminal"),
    priorStatus: z.string(),
  }),
]);

export type ReconcileResult = z.output<typeof ReconcileResultSchema>;

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
  const failure: TaskFailure = maskTaskFailure({
    reason: "run_terminated",
    detail: `inngest run terminated abnormally (run_id ${payload.runId}, function_id ${payload.functionId}): ${payload.errorMessage}`,
  });

  const result = await deps.runInTx((tx) => deps.store.failTaskIfNonTerminal(tx, taskId, failure));

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
  return { status: "reconciled", taskId, failure };
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
      // Parsed on every invocation, so a memo an older build stored reads
      // the same as a live result.
      const result = ReconcileResultSchema.parse(
        await step.run("reconcile", () =>
          reconcileCodingTaskFailure(deps, {
            functionId: function_id,
            runId: run_id,
            errorMessage,
            taskId,
          }),
        ),
      );
      if (result.status === "reconciled") {
        await step.sendEvent("emit-failed", {
          ...codingTaskFailed.create({
            taskId: result.taskId,
            // Masked again: a run resumed on a newer build replays the
            // `reconcile` result an older one stored.
            ...maskTaskFailure(result.failure),
          }),
          id: `reconcile-${run_id}`,
        });
      }
      return result;
    },
  );
}
