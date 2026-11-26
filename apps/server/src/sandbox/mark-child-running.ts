import { match, P } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { DockerFacade } from "./docker-facade.js";
import { killAndRemoveContainer } from "./kill-and-remove-container.js";
import type { ChildStartOutcome } from "./proxy/index.js";
import type { SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

interface MarkChildRunningDeps {
  store: SandboxStore;
  runInTx: Transactor;
  docker: DockerFacade;
}

/**
 * Mark a child's row `running` once the daemon has started its container
 * at the task's request (design/sandbox.md → Container state machine).
 *
 * A row already `running` belongs to a child the task stopped and started
 * again, and nothing is written. A row that is `exited` or `reaped` was
 * finished by another path while the daemon started the container (a TTL
 * pass, the cascade, or the stale pass); no pass looks at a terminal row
 * again, so the container this start brought up is killed and removed. A
 * kill the daemon refuses is logged: the container then runs under a
 * terminal row until its instance row closes and the orphan pass takes it.
 */
export async function markChildRunning(
  deps: MarkChildRunningDeps,
  args: { id: string; dockerId: string; at: Date },
): Promise<ChildStartOutcome> {
  const result = await deps.runInTx((tx) =>
    deps.store.transitionContainerStatus(tx, {
      id: args.id,
      from: "starting",
      to: "running",
      at: args.at,
    }),
  );
  return match(result)
    .with({ kind: "transitioned" }, async (): Promise<ChildStartOutcome> => {
      log.debug({ dockerId: args.dockerId }, "child container running");
      return { kind: "running" };
    })
    .with({ kind: "stale", status: "running" }, async (): Promise<ChildStartOutcome> => {
      log.debug({ dockerId: args.dockerId }, "child container started again");
      return { kind: "running" };
    })
    .with(
      { kind: "stale", status: P.union("exited", "reaped") },
      async ({ status }): Promise<ChildStartOutcome> => {
        log.warn(
          { dockerId: args.dockerId, status },
          "child row finished while it started, removing",
        );
        const removed = await killAndRemoveContainer(deps.docker, args.dockerId);
        removed.match(
          () => undefined,
          (e) =>
            log.warn(
              { err: e.error, op: e.op, dockerId: args.dockerId },
              "removing the child of a finished row failed",
            ),
        );
        return { kind: "finished" };
      },
    )
    .with({ kind: "stale", status: "starting" }, () => {
      // The guard is `status = 'starting'`, so a row still in it cannot be stale.
      throw new Error(`markChildRunning: row ${args.id} is starting yet the transition is stale`);
    })
    .exhaustive();
}
