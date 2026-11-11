import type { ContainerInfo } from "dockerode";
import { type Result, ResultAsync } from "neverthrow";
import { describeError } from "../util/describe-error.js";
import type { DockerFacade } from "./docker-facade.js";
import { LABEL_MANAGED } from "./supervisor.js";

/** How long the daemon has to list the containers before the listing counts as failed. */
const LIST_TIMEOUT_MS = 10_000;

/**
 * The host paths every `cogmo.managed` container on the daemon binds, stopped
 * ones included, so a caller removes none a container may still read; why
 * not, when the daemon cannot list them or has not within 10 s, which aborts
 * the request.
 */
export async function managedBindSources(
  docker: Pick<DockerFacade, "listContainers">,
): Promise<Result<ReadonlySet<string>, string>> {
  return ResultAsync.fromPromise(listManaged(docker), describeError).map(
    (containers): ReadonlySet<string> =>
      new Set(
        containers.flatMap((c) => c.Mounts.filter((m) => m.Type === "bind").map((m) => m.Source)),
      ),
  );
}

/** The listing, rejecting once {@link LIST_TIMEOUT_MS} passes without it. */
async function listManaged(docker: Pick<DockerFacade, "listContainers">): Promise<ContainerInfo[]> {
  const controller = new AbortController();
  const timedOut = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`the Docker daemon listed no containers within ${LIST_TIMEOUT_MS / 1000} s`),
      ),
    LIST_TIMEOUT_MS,
  );
  const listing = docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_MANAGED}=true`] },
    abortSignal: controller.signal,
  });
  // Past the timeout the race has settled, so the aborted request's own
  // rejection has nobody to reach.
  listing.catch(() => undefined);
  try {
    return await Promise.race([listing, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
