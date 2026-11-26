import { ok, Result, ResultAsync } from "neverthrow";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { type DockerFacade, statusCodeOf } from "./docker-facade.js";
import { markChildExited } from "./mark-child-exited.js";
import type { StoreFailed, TaskContainerRow } from "./proxy/index.js";
import type { SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

interface ReconcileChildContainersDeps {
  store: SandboxStore;
  runInTx: Transactor;
  docker: DockerFacade;
}

/**
 * The live children the daemon still has, for a create that finds the
 * child count at 16 (design/sandbox.md → Proxy Design → Caps and cost). A
 * child the daemon answers 404 for is gone: a `docker run --rm` child
 * removes itself, with no `DELETE` through the proxy. Its row moves to
 * `exited`, the transition the reaper's stale pass would make on its next
 * tick, and it no longer counts. A child that exited but was not removed is
 * still on the daemon and still counts: marked `exited`, a restart of it
 * would run under an `exited` row, which neither the TTL pass nor the cap
 * counts. An inspect that fails otherwise counts the child as live.
 */
export async function reconcileChildContainers(
  deps: ReconcileChildContainersDeps,
  children: ReadonlyArray<TaskContainerRow>,
): Promise<Result<ReadonlyArray<TaskContainerRow>, StoreFailed>> {
  const at = new Date();
  const verdicts = await Promise.all(
    children.map(async (child): Promise<Result<TaskContainerRow[], StoreFailed>> => {
      if (await onDaemon(deps.docker, child.dockerId)) return ok([child]);
      return (await markChildExited(deps, { child, cause: "missing_from_daemon", at })).map(
        () => [],
      );
    }),
  );
  return Result.combine(verdicts).map((live) => live.flat());
}

async function onDaemon(docker: DockerFacade, dockerId: string): Promise<boolean> {
  const inspected = await ResultAsync.fromPromise(
    docker.getContainer(dockerId).inspect(),
    (cause) => cause,
  );
  return inspected.match(
    () => true,
    (cause) => {
      if (statusCodeOf(cause) === 404) return false;
      log.warn({ err: cause, dockerId }, "child reconcile inspect failed; counting it live");
      return true;
    },
  );
}
