import type { Transactor } from "../../db/index.js";
import { type CodingStore, isTerminalCodingTaskStatus } from "./store/index.js";

export interface FindEndedCodingTasksDeps {
  runInTx: Transactor;
  store: CodingStore;
}

/** The tasks among `taskIds` that have ended: a terminal status, or no row. */
export async function findEndedCodingTasks(
  deps: FindEndedCodingTasksDeps,
  taskIds: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> {
  const rows = await deps.runInTx((tx) => deps.store.getTasksByIds(tx, taskIds));
  const live = new Set(
    rows.filter((row) => !isTerminalCodingTaskStatus(row.status)).map((row) => row.id),
  );
  return new Set(taskIds.filter((taskId) => !live.has(taskId)));
}
