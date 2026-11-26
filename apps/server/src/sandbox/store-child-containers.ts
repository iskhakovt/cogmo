import { okAsync, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import type { DockerFacade } from "./docker-facade.js";
import { insertChildContainer } from "./insert-child-container.js";
import { markChildRunning } from "./mark-child-running.js";
import { markContainerExited } from "./mark-container-exited.js";
import type { ChildContainers, StoreFailed } from "./proxy/index.js";
import type { SandboxStore } from "./store/index.js";

/**
 * `ChildContainers` over the sandbox store and the daemon, which the
 * socket proxy calls once the daemon has answered a task's create, start or
 * removal of a child (design/sandbox.md → Container state machine). A
 * failed store write is a value: `record_failed` for an insert, whose
 * container is then removed, and `store_failed` for a transition.
 */
export function storeChildContainers(deps: {
  store: SandboxStore;
  runInTx: Transactor;
  docker: DockerFacade;
}): ChildContainers {
  return {
    record: (child) => new ResultAsync(insertChildContainer(deps, child)).map(() => undefined),
    started: (child) =>
      ResultAsync.fromPromise(
        markChildRunning(deps, { id: child.id, dockerId: child.dockerId, at: new Date() }),
        storeFailed,
      ),
    removed: (child) =>
      match(child.status)
        .with("starting", "running", (from) =>
          ResultAsync.fromPromise(
            markContainerExited(deps, {
              id: child.id,
              dockerId: child.dockerId,
              from,
              at: new Date(),
              cause: "removed_by_task",
            }),
            storeFailed,
          ).map(() => undefined),
        )
        // The stale pass found it missing first; the row already says so.
        .with("exited", () => okAsync<void, StoreFailed>(undefined))
        .exhaustive(),
  };
}

function storeFailed(cause: unknown): StoreFailed {
  return { kind: "store_failed", cause };
}
