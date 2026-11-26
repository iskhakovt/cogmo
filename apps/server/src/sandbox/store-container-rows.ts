import { ResultAsync } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import type { ContainerRows, StoreFailed, TaskContainerRow } from "./proxy/index.js";
import type { ContainerStatus, SandboxStore } from "./store/index.js";

/**
 * `ContainerRows` over the sandbox store, which the socket proxy reads on
 * every request that checks ownership (design/sandbox.md → Proxy Design →
 * Ownership): a task's `containers` rows that are not `reaped`. A failed
 * store read is a `store_failed` value.
 */
export function storeContainerRows(deps: {
  store: SandboxStore;
  runInTx: Transactor;
}): ContainerRows {
  return {
    forTask: (taskId) =>
      ResultAsync.fromPromise(
        listTaskContainers(deps, taskId),
        (cause): StoreFailed => ({ kind: "store_failed", cause }),
      ),
  };
}

async function listTaskContainers(
  deps: { store: SandboxStore; runInTx: Transactor },
  taskId: string,
): Promise<ReadonlyArray<TaskContainerRow>> {
  const rows = await deps.runInTx((tx) => deps.store.listContainersForTask(tx, taskId));
  return R.pipe(
    rows,
    R.filter((row) => notReaped(row.status)),
    R.map((row) => ({ id: row.id, dockerId: row.dockerId, parentId: row.parentId })),
  );
}

function notReaped(status: ContainerStatus): boolean {
  return match(status)
    .with("starting", "running", "exited", () => true)
    .with("reaped", () => false)
    .exhaustive();
}
