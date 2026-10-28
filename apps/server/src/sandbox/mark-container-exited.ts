import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { ContainerTransitionResult, SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

/**
 * Mark a row `exited` because the daemon no longer has its container and
 * Cogmo did not remove it (a `docker rm` outside Cogmo, or a crash between
 * a reap's remove and its transition). No exit code: the daemon never
 * reported one. `stale` means another path finished the row first and is
 * logged at debug.
 */
export async function markContainerExited(
  deps: { store: SandboxStore; runInTx: Transactor },
  args: { id: string; dockerId: string; from: "starting" | "running"; at: Date },
): Promise<ContainerTransitionResult> {
  const result = await deps.runInTx((tx) =>
    deps.store.transitionContainerStatus(tx, {
      id: args.id,
      from: args.from,
      to: "exited",
      at: args.at,
    }),
  );
  match(result)
    .with({ kind: "transitioned" }, () =>
      log.info({ dockerId: args.dockerId }, "container missing from the daemon, marked exited"),
    )
    .with({ kind: "stale" }, ({ status }) =>
      log.debug(
        { dockerId: args.dockerId, status },
        "container row already finished by another path",
      ),
    )
    .exhaustive();
  return result;
}
