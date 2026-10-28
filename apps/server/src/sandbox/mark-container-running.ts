import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { ContainerTransitionResult, SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

/**
 * Mark a row `running` once the daemon has started its container. `stale`
 * means another path finished the row while the daemon was starting it; the
 * caller owns the container it just started and decides what to do with it.
 */
export async function markContainerRunning(
  deps: { store: SandboxStore; runInTx: Transactor },
  args: { id: string; dockerId: string; at: Date },
): Promise<ContainerTransitionResult> {
  const result = await deps.runInTx((tx) =>
    deps.store.transitionContainerStatus(tx, {
      id: args.id,
      from: "starting",
      to: "running",
      at: args.at,
    }),
  );
  match(result)
    .with({ kind: "transitioned" }, () =>
      log.debug({ dockerId: args.dockerId }, "container running"),
    )
    .with({ kind: "stale" }, ({ status }) =>
      log.warn(
        { dockerId: args.dockerId, status },
        "container row finished by another path before it started",
      ),
    )
    .exhaustive();
  return result;
}
