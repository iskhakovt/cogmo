/**
 * One orchestrator run over one coding task: the handles every stage
 * takes, and the task/repo load each run opens with.
 */

import type { Logger } from "pino";
import type { Transactor } from "../../db/index.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "./store/index.js";

export interface CodingRun {
  taskId: string;
  /**
   * Inngest run id, stamped on the ownership claim so a re-executed claim can
   * tell its own committed write from a duplicate delivery's. Tests pass any
   * stable string.
   */
  runId: string;
  stepRun: StepRun;
  /**
   * Durable bus emit. The failure channel uses it so a transient send blip
   * surfaces as a function failure (caught by the `coding-task-reconcile`
   * system-event subscriber) rather than a silently-swallowed
   * `coding/task/failed` event.
   */
  stepSendEvent: StepSendEvent;
  log: Logger;
}

/** The store handles a stage needs to read or write the task row. */
export interface TaskStoreDeps {
  runInTx: Transactor;
  store: CodingStore;
}

/** Reads the task and its repo. Outside any step: cheap point reads, re-run on every invocation. */
export async function loadTaskAndRepo(
  deps: TaskStoreDeps,
  taskId: string,
): Promise<{ task: CodingTaskRow; repo: CodingRepoRow }> {
  const task = await deps.runInTx((tx) => deps.store.getTask(tx, taskId));
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await deps.runInTx((tx) => deps.store.getRepoById(tx, task.repoId));
  if (!repo) throw new Error(`coding repo not found: ${task.repoId}`);
  return { task, repo };
}
