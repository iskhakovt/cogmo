import { DrizzleQueryError } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { DockerFacade } from "./docker-facade.js";
import { killAndRemoveContainer } from "./kill-and-remove-container.js";
import type { ChildRecord, ChildRecordFailed } from "./proxy/index.js";
import type { ContainerRow, SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

interface InsertChildContainerDeps {
  store: SandboxStore;
  runInTx: Transactor;
  docker: DockerFacade;
}

/**
 * Insert the `containers` row of a child the daemon created through the
 * proxy, in `starting` (design/sandbox.md → Container state machine), before
 * the proxy answers the task. An insert the store or its driver fails
 * leaves the daemon holding a container no row records, so it is removed
 * here, with its anonymous volumes; a removal the daemon refuses is
 * logged, and the orphan pass removes the rowless container once its grace
 * window has passed. Any other throw, a column's schema refusing the row
 * among them, is a bug and is rethrown.
 */
export async function insertChildContainer(
  deps: InsertChildContainerDeps,
  child: ChildRecord,
): Promise<Result<ContainerRow, ChildRecordFailed>> {
  try {
    const row = await deps.runInTx((tx) =>
      deps.store.insertContainer(tx, { ...child, labels: { ...child.labels } }),
    );
    log.debug({ dockerId: child.dockerId, rowId: row.id }, "child container recorded");
    return ok(row);
  } catch (cause) {
    if (!isStoreFailure(cause)) throw cause;
    log.error(
      { err: cause, dockerId: child.dockerId },
      "child container row insert failed, removing",
    );
    const removed = await killAndRemoveContainer(deps.docker, child.dockerId);
    removed.match(
      () => undefined,
      (e) =>
        log.warn(
          { err: e.error, op: e.op, dockerId: child.dockerId },
          "removing the rowless child failed; the orphan pass removes it",
        ),
    );
    return err({ kind: "record_failed" });
  }
}

/** How far down the `cause` chain a driver's error is worth looking for. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Whether the store or its driver raised `cause`: a statement Drizzle sent
 * (`DrizzleQueryError`), or an error carrying a driver or system `code`
 * (a SQLSTATE, `CONNECTION_CLOSED`, `ECONNRESET`) on it or down its
 * `cause` chain, as a transaction's own `begin` or `commit` raises it.
 */
function isStoreFailure(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof DrizzleQueryError) return true;
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && typeof current.code === "string") return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}
