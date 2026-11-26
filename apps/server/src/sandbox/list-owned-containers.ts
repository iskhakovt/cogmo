import * as R from "remeda";
import type { Transactor } from "../db/index.js";
import type { OwnedContainer } from "./proxy/index.js";
import type { SandboxStore } from "./store/index.js";

/**
 * The containers a task owns, as the socket proxy reads them on every
 * request (design/sandbox.md → Proxy Design → Ownership): its rows that
 * are not `reaped`. A store failure rejects.
 */
export async function listOwnedContainers(
  deps: { store: SandboxStore; runInTx: Transactor },
  taskId: string,
): Promise<ReadonlyArray<OwnedContainer>> {
  const rows = await deps.runInTx((tx) => deps.store.listContainersForTask(tx, taskId));
  return R.pipe(
    rows,
    R.filter((row) => row.status !== "reaped"),
    R.map((row) => ({ dockerId: row.dockerId, depth: row.depth })),
  );
}
