import { err, ok, type Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { DockerFacade } from "./docker-facade.js";
import { killAndRemoveContainer } from "./kill-and-remove-container.js";
import type { ChildStartOutcome, StoreFailed } from "./proxy/index.js";
import type { ContainerTransitionResult, SandboxStore } from "./store/index.js";

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
 * again, and nothing is written. A row already `exited` belongs to a child
 * that is gone: a `--rm` child that ran, exited and removed itself before
 * this write, which the stale pass or the cap's reconcile recorded; the
 * daemon's answer stands, and there is nothing to kill. Only a `reaped`
 * row means the start lost: a TTL pass or the cascade finished the row
 * while the daemon started the container, no pass looks at the row again,
 * so the container this start brought up is killed and removed. A kill the
 * daemon refuses is logged: the container then runs under a reaped row
 * until its instance row closes and the orphan pass takes it.
 *
 * A failed store write is `store_failed`; only the transition is caught, so
 * an invariant violation after it stays a bug and rejects.
 */
export async function markChildRunning(
  deps: MarkChildRunningDeps,
  args: { id: string; dockerId: string; at: Date },
): Promise<Result<ChildStartOutcome, StoreFailed>> {
  const written = await ResultAsync.fromPromise(
    deps.runInTx((tx) =>
      deps.store.transitionContainerStatus(tx, {
        id: args.id,
        from: "starting",
        to: "running",
        at: args.at,
      }),
    ),
    (cause): StoreFailed => ({ kind: "store_failed", cause }),
  );
  if (written.isErr()) return err(written.error);
  return ok(await outcomeOf(deps, args, written.value));
}

async function outcomeOf(
  deps: MarkChildRunningDeps,
  args: { id: string; dockerId: string },
  result: ContainerTransitionResult,
): Promise<ChildStartOutcome> {
  return match(result)
    .with({ kind: "transitioned" }, async (): Promise<ChildStartOutcome> => {
      log.debug({ dockerId: args.dockerId }, "child container running");
      return { kind: "started" };
    })
    .with({ kind: "stale", status: "running" }, async (): Promise<ChildStartOutcome> => {
      log.debug({ dockerId: args.dockerId }, "child container started again");
      return { kind: "started" };
    })
    .with({ kind: "stale", status: "exited" }, async (): Promise<ChildStartOutcome> => {
      log.debug({ dockerId: args.dockerId }, "child container gone since its start");
      return { kind: "started" };
    })
    .with({ kind: "stale", status: "reaped" }, async ({ status }): Promise<ChildStartOutcome> => {
      log.warn({ dockerId: args.dockerId, status }, "child row reaped while it started, removing");
      const removed = await killAndRemoveContainer(deps.docker, args.dockerId);
      removed.match(
        () => undefined,
        (e) =>
          log.warn(
            { err: e.error, op: e.op, dockerId: args.dockerId },
            "removing the child of a finished row failed",
          ),
      );
      return { kind: "reaped" };
    })
    .with({ kind: "stale", status: "starting" }, () => {
      // The guard is `status = 'starting'`, so a row still in it cannot be stale.
      throw new Error(`markChildRunning: row ${args.id} is starting yet the transition is stale`);
    })
    .exhaustive();
}
