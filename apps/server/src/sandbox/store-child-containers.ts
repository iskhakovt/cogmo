import { ResultAsync } from "neverthrow";
import type { Transactor } from "../db/index.js";
import type { DockerFacade } from "./docker-facade.js";
import { insertChildContainer } from "./insert-child-container.js";
import { markChildExited } from "./mark-child-exited.js";
import { markChildRunning } from "./mark-child-running.js";
import type { ChildContainers } from "./proxy/index.js";
import { reconcileChildContainers } from "./reconcile-child-containers.js";
import type { SandboxStore } from "./store/index.js";

/**
 * `ChildContainers` over the sandbox store and the daemon, which the
 * socket proxy calls once the daemon has answered a task's create, start or
 * removal of a child, and before a create that would reach the child cap
 * (design/sandbox.md → Container state machine). A failed store write is a
 * value: `record_failed` for an insert, whose container is then removed,
 * and `store_failed` otherwise.
 */
export function storeChildContainers(deps: {
  store: SandboxStore;
  runInTx: Transactor;
  docker: DockerFacade;
}): ChildContainers {
  return {
    record: (child, deadline) =>
      new ResultAsync(insertChildContainer(deps, child, deadline)).map(() => undefined),
    started: (child) =>
      new ResultAsync(
        markChildRunning(deps, { id: child.id, dockerId: child.dockerId, at: new Date() }),
      ),
    removed: (child) =>
      new ResultAsync(markChildExited(deps, { child, cause: "removed_by_task", at: new Date() })),
    reconcile: (children) => new ResultAsync(reconcileChildContainers(deps, children)),
  };
}
