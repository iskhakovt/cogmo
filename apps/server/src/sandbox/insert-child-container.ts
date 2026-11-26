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
 * the proxy answers the task. A failed insert leaves the daemon holding a
 * container no row records, so it is removed here, with its anonymous
 * volumes; a removal the daemon refuses is logged, and the orphan pass
 * removes the rowless container once its grace window has passed.
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
