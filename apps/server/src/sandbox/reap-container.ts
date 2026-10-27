import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { DockerFacade } from "./docker-facade.js";
import { type DaemonError, killAndRemoveContainer } from "./kill-and-remove-container.js";
import type {
  ContainerRow,
  ContainerStatus,
  ContainerTransitionResult,
  SandboxStore,
} from "./store/index.js";

const log = logger.child({ component: "sandbox" });

/**
 * Why a container is being reaped. Carried on the transition's log line; the
 * planned `reaped_reason` column (design/sandbox.md → Container state
 * machine, tracked in todo.md) will record it on the row.
 */
export type ContainerReapReason =
  | "ttl_expired"
  | "cascade"
  | "dead_instance"
  | "crash_reconcile"
  | "start_failed";

export interface ReapContainerDeps {
  docker: DockerFacade;
  store: SandboxStore;
  runInTx: Transactor;
}

export interface ReapContainerArgs {
  id: string;
  dockerId: string;
  from: Exclude<ContainerStatus, "reaped">;
  reason: ContainerReapReason;
  at: Date;
}

/**
 * Kill and remove the daemon object, then move the row to `reaped`. The
 * daemon goes first: a crash between the two leaves a live-looking row with
 * no container, which the reaper's stale pass marks `exited`; the other order
 * would leave a `reaped` row over a running container that no pass looks at
 * again. A daemon refusal is returned as `DaemonError` with the row untouched.
 * `stale` means another path finished the row while this one was killing the
 * container; the container is gone either way, so it is logged at debug and
 * returned for the caller's accounting.
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
      from: args.from,
      to: "reaped",
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
 * Reap a daemon object found by listing the daemon: a row may be missing (a
 * create whose row insert failed) or already `reaped` (a remove the daemon
 * was still finishing), and in both cases only the daemon object is left to
 * remove.
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
  return match(args.row)
    .with(P.nullish, { status: "reaped" }, () => killAndRemoveContainer(deps.docker, args.dockerId))
    .with({ status: P.union("starting", "running", "exited") }, async (row) => {
      const reaped = await reapContainer(deps, {
        id: row.id,
        dockerId: args.dockerId,
        from: row.status,
        reason: args.reason,
        at: args.at,
      });
      return reaped.map(() => undefined);
    })
    .exhaustive();
}
