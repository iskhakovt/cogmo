/**
 * The generic workflows the declarative layer generates its machinery from.
 * Sandboxed: imports `@temporalio/workflow` and types only.
 *
 * - `laneWorkflow`: one per concurrency key. Producers start-or-signal it;
 *   it runs each job as a child workflow, at most `limit` at once, in
 *   arrival order, and completes once its queue is empty.
 * - `debounceWorkflow`: one per debounce key. Each arrival resets the
 *   period; the window fires with its last event once the period passes
 *   quietly or the ceiling is reached.
 */

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
  allHandlersFinished,
  ChildWorkflowFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { FlowActivities } from "./activities.js";
import type {
  DebounceArgs,
  DebounceResult,
  FlowEvent,
  Job,
  LaneArgs,
  LaneResult,
} from "./types.js";

export const enqueueSignal = defineSignal<[Job]>("enqueue");
export const arriveSignal = defineSignal<[FlowEvent]>("arrive");
/** The lane's queued job ids, oldest first. */
export const pendingQuery = defineQuery<string[]>("pending");

const { startRun, reportFailure } = proxyActivities<FlowActivities>({
  startToCloseTimeout: "10s",
  retry: { initialInterval: "100ms" },
});

/** Jobs one lane run starts before it continues as new, bounding its history. */
const JOBS_PER_RUN = 200;

type JobOutcome = "ran" | "duplicate" | "failed";

async function runJob(job: Job): Promise<JobOutcome> {
  try {
    await executeChild(job.workflowType, {
      workflowId: job.jobId,
      args: [job.event, job.params],
      // A job id that already ran is a duplicate delivery of the same event.
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
    return "ran";
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return "duplicate";
    if (err instanceof ChildWorkflowFailure) {
      log.warn("lane job failed", { jobId: job.jobId, cause: err.cause?.message });
      await reportFailure({ functionId: job.functionId, jobId: job.jobId, event: job.event });
      return "failed";
    }
    throw err;
  }
}

export async function laneWorkflow(args: LaneArgs): Promise<LaneResult> {
  const queue: Job[] = [...args.carried];
  setHandler(enqueueSignal, (job) => {
    if (!queue.some((queued) => queued.jobId === job.jobId)) queue.push(job);
  });
  setHandler(pendingQuery, () => queue.map((job) => job.jobId));

  const result: LaneResult = { ran: 0, duplicates: 0, failed: 0 };
  let active = 0;
  let started = 0;

  for (;;) {
    while (active < args.limit && queue.length > 0 && started < JOBS_PER_RUN) {
      const job = queue.shift();
      if (job === undefined) break;
      active += 1;
      started += 1;
      void runJob(job).then((outcome) => {
        active -= 1;
        if (outcome === "ran") result.ran += 1;
        else if (outcome === "duplicate") result.duplicates += 1;
        else result.failed += 1;
      });
    }
    if (active === 0) {
      // A signal may land while the lane decides to finish: wait for every
      // handler, then finish only if the queue is still empty. The server
      // rejects a completion that races a new signal, and the replay sees it.
      await condition(allHandlersFinished);
      if (queue.length === 0) return result;
      if (started >= JOBS_PER_RUN || workflowInfo().continueAsNewSuggested) {
        return continueAsNew<typeof laneWorkflow>({ ...args, carried: queue });
      }
      continue;
    }
    await condition(
      () => active === 0 || (active < args.limit && queue.length > 0 && started < JOBS_PER_RUN),
    );
  }
}

export async function debounceWorkflow(args: DebounceArgs): Promise<DebounceResult> {
  let latest: FlowEvent | null = null;
  let arrivals = 0;
  setHandler(arriveSignal, (event) => {
    latest = event;
    arrivals += 1;
  });

  let consumed = 0;
  let fired = 0;
  for (;;) {
    await condition(() => arrivals > consumed);
    const windowStart = Date.now();
    let seen = arrivals;
    for (;;) {
      const untilCeiling =
        args.timeoutMs === null
          ? args.periodMs
          : Math.max(0, args.timeoutMs - (Date.now() - windowStart));
      if (untilCeiling === 0) break;
      const more = await condition(() => arrivals > seen, Math.min(args.periodMs, untilCeiling));
      if (!more) break;
      seen = arrivals;
    }
    const event: FlowEvent | null = latest;
    if (event === null) throw new Error("debounce window fired with no event");
    consumed = arrivals;
    await startRun({ functionId: args.functionId, event });
    fired += 1;
    await condition(allHandlersFinished);
    // Arrivals during the hand-off open the next window instead of being dropped.
    if (arrivals === consumed) return { fired };
  }
}
