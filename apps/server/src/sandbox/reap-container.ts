import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { DockerFacade } from "./docker-facade.js";
import { type DaemonError, killAndRemoveContainer } from "./kill-and-remove-container.js";
import type {
  ContainerReapReason,
  ContainerRow,
  ContainerTransitionResult,
  SandboxStore,
} from "./store/index.js";

const log = logger.child({ component: "sandbox" });

export interface ReapContainerDeps {
  docker: DockerFacade;
  store: SandboxStore;
  runInTx: Transactor;
}

export interface ReapContainerArgs {
  id: string;
  dockerId: string;
  reason: ContainerReapReason;
  at: Date;
}

/**
 * Kill and remove the daemon object, then move the row to `reaped` from
 * whatever live state it holds, recording `reason` on it. The daemon goes
 * first: a crash between the
 * two leaves a live-looking row with no container, which the reaper's stale
 * pass marks `exited`; the other order would leave a `reaped` row over a
 * running container that no pass looks at again. A daemon refusal is
 * returned as `DaemonError` with the row untouched. `stale` means another
 * path reaped the row while this one was killing the container; it is logged
 * at debug and returned for the caller's accounting.
 */
export async function reapContainer(
  deps: ReapContainerDeps,
  args: ReapContainerArgs,
): Promise<Result<ContainerTransitionResult, DaemonError>> {
  const removed = await killAndRemoveContainer(deps.docker, args.dockerId);
  if (removed.isErr()) return err(removed.error);
  const result = await deps.runInTx((tx) =>
    deps.store.transitionContainerStatus(tx, {
      id: args.id,
      to: "reaped",
      reason: args.reason,
      at: args.at,
    }),
  );
  const fields = { dockerId: args.dockerId, reason: args.reason };
  match(result)
    .with({ kind: "transitioned" }, () => log.info(fields, "container reaped"))
    .with({ kind: "stale" }, ({ status }) =>
      log.debug({ ...fields, status }, "container row already finished by another path"),
    )
    .exhaustive();
  return ok(result);
}

/**
 * Reap a daemon object found by listing the daemon. Its row may be missing
 * (a create whose row insert failed), in which case only the daemon object
 * is left to remove.
 */
export async function reapDiscoveredContainer(
  deps: ReapContainerDeps,
  args: {
    dockerId: string;
    row: ContainerRow | undefined;
    reason: ContainerReapReason;
    at: Date;
  },
): Promise<Result<void, DaemonError>> {
  if (args.row === undefined) return killAndRemoveContainer(deps.docker, args.dockerId);
  const reaped = await reapContainer(deps, {
    id: args.row.id,
    dockerId: args.dockerId,
    reason: args.reason,
    at: args.at,
  });
  return reaped.map(() => undefined);
}
