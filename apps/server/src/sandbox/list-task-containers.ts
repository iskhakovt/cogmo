import * as R from "remeda";
import type { Transactor } from "../db/index.js";
import type { TaskContainerRow } from "./proxy/index.js";
import type { SandboxStore } from "./store/index.js";

/**
 * The `containers` rows that carry a task's `root_task_id` and are not
 * `reaped`, which the socket proxy reads on every request that checks
 * ownership (design/sandbox.md → Proxy Design → Ownership). A store failure
 * rejects.
 */
export async function listTaskContainers(
  deps: { store: SandboxStore; runInTx: Transactor },
  taskId: string,
): Promise<ReadonlyArray<TaskContainerRow>> {
  const rows = await deps.runInTx((tx) => deps.store.listContainersForTask(tx, taskId));
  return R.pipe(
    rows,
    R.filter((row) => row.status !== "reaped"),
    R.map((row) => ({ id: row.id, dockerId: row.dockerId, parentId: row.parentId })),
  );
}
