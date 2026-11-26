import { ok, Result, ResultAsync } from "neverthrow";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { type DockerFacade, statusCodeOf } from "./docker-facade.js";
import { markChildExited } from "./mark-child-exited.js";
import type { StoreFailed, TaskContainerRow } from "./proxy/index.js";
import type { SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

/**
 * How long one child's inspect may take before the child counts as live.
 * The daemon answers an inspect in milliseconds, and the inspects run at
 * once, so a wedged daemon holds a create at the cap for this long, not
 * for ever: the reconcile runs before the create's deadline starts.
 */
const INSPECT_TIMEOUT_MS = 5_000;

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
 * counts. An inspect that fails otherwise, does not answer within 5
 * seconds, or is cut off by `signal`, the task's, counts the child as live.
 */
export async function reconcileChildContainers(
  deps: ReconcileChildContainersDeps,
  args: { children: ReadonlyArray<TaskContainerRow>; at: Date; signal: AbortSignal },
): Promise<Result<ReadonlyArray<TaskContainerRow>, StoreFailed>> {
  const { children, at, signal } = args;
  const verdicts = await Promise.all(
    children.map(async (child): Promise<Result<TaskContainerRow[], StoreFailed>> => {
      if (await onDaemon(deps.docker, child.dockerId, signal)) return ok([child]);
      return (await markChildExited(deps, { child, cause: "missing_from_daemon", at })).map(
        () => [],
      );
    }),
  );
  return Result.combine(verdicts).map((live) => live.flat());
}

async function onDaemon(
  docker: DockerFacade,
  dockerId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error("the daemon did not answer the inspect in time")),
    INSPECT_TIMEOUT_MS,
  );
  const inspected = await ResultAsync.fromPromise(
    docker
      .getContainer(dockerId)
      .inspect({ abortSignal: AbortSignal.any([signal, timeout.signal]) }),
    (cause) => cause,
  );
  clearTimeout(timer);
  return inspected.match(
    () => true,
    (cause) => {
      if (statusCodeOf(cause) === 404) return false;
      log.warn({ err: cause, dockerId }, "child reconcile inspect failed; counting it live");
      return true;
    },
  );
}
