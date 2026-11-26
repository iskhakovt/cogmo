import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { ChildExitCause } from "./proxy/index.js";
import type { ContainerTransitionResult, SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

/**
 * Mark a row `exited` because the daemon no longer has its container and
 * Cogmo did not remove it: the reaper's stale pass found it missing (a
 * `docker rm` outside Cogmo, or a crash between a reap's remove and its
 * transition), or the task removed its child through the proxy. No exit
 * code: the daemon never reported one. `stale` means another path finished
 * or moved the row first and is logged at debug.
 */
export async function markContainerExited(
  deps: { store: SandboxStore; runInTx: Transactor },
  args: {
    id: string;
    dockerId: string;
    from: "starting" | "running";
    at: Date;
    cause: ChildExitCause;
  },
): Promise<ContainerTransitionResult> {
  const result = await deps.runInTx((tx) =>
    deps.store.transitionContainerStatus(tx, {
      id: args.id,
      from: args.from,
      to: "exited",
      at: args.at,
    }),
  );
  logExit(args, result);
  return result;
}

/** Log an `exited` transition's outcome, `stale` at debug. */
export function logExit(
  args: { dockerId: string; cause: ChildExitCause },
  result: ContainerTransitionResult,
): void {
  match(result)
    .with({ kind: "transitioned" }, () =>
      match(args.cause)
        .with("missing_from_daemon", () =>
          log.info({ dockerId: args.dockerId }, "container missing from the daemon, marked exited"),
        )
        .with("removed_by_task", () =>
          log.debug({ dockerId: args.dockerId }, "child removed by its task, marked exited"),
        )
        .exhaustive(),
    )
    .with({ kind: "stale" }, ({ status }) =>
      log.debug(
        { dockerId: args.dockerId, status },
        "container row already finished by another path",
      ),
    )
    .exhaustive();
}
