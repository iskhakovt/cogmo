import { type Result, ResultAsync } from "neverthrow";
import { describeError } from "../util/describe-error.js";
import type { DockerFacade } from "./docker-facade.js";
import { LABEL_MANAGED } from "./supervisor.js";

/**
 * The host paths every `cogmo.managed` container on the daemon binds, stopped
 * ones included, so a caller removes none a container may still read; why
 * not, when the daemon cannot list them.
 */
export async function managedBindSources(
  docker: Pick<DockerFacade, "listContainers">,
): Promise<Result<ReadonlySet<string>, string>> {
  return ResultAsync.fromPromise(
    docker.listContainers({ all: true, filters: { label: [`${LABEL_MANAGED}=true`] } }),
    describeError,
  ).map(
    (containers): ReadonlySet<string> =>
      new Set(
        containers.flatMap((c) => c.Mounts.filter((m) => m.Type === "bind").map((m) => m.Source)),
      ),
  );
}
