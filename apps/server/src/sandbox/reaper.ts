import type Docker from "dockerode";
import type { Inngest } from "inngest";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { statusCodeOf } from "./docker-facade.js";
import { markContainerExited } from "./mark-container-exited.js";
import { reapContainer, reapDiscoveredContainer } from "./reap-container.js";
import {
  type ContainerRow,
  type ContainerTransitionResult,
  isLiveContainer,
  type SandboxStore,
} from "./store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "./supervisor.js";

const log = logger.child({ component: "sandbox.reaper" });

/**
 * How long the orphan pass leaves a container that is labelled with a live
 * instance and has no row: the gap between a create's daemon answer and
 * its row insert, in the supervisor or the proxy, is one round trip.
 */
const ROWLESS_GRACE_MS = 2 * 60_000;

/** What the orphan and stale passes read of a listed container. */
type ListedContainer = Pick<Docker.ContainerInfo, "Id" | "Labels" | "Created">;

/**
 * Cron reaper for the sandbox module. Runs three passes per tick:
 *
 * 1. **TTL pass.** Every container/network/volume owned by the current
 *    Cogmo instance whose `ttl_expires_at` is in the past gets reaped.
 *    Containers are killed in cascade order (depth DESC) so a parent
 *    isn't removed while a child still references its namespace.
 *
 * 2. **Orphan pass.** Walks every container the daemon reports as
 *    `cogmo.managed=true`. Anything stamped with an instance id that
 *    isn't live (or isn't a known Cogmo instance at all) gets reaped at
 *    once, and so does one with no matching DB row once it is 2 minutes
 *    old. Catches:
 *    - Containers from a previous Cogmo run that crashed before
 *      graceful shutdown.
 *    - Containers created by Docker whose row insert failed, in the
 *      supervisor or the proxy, and whose removal failed too. The grace
 *      window leaves alone a create between the daemon's answer and its
 *      row insert.
 *
 * 3. **Stale DB pass.** Rows the DB still considers live but the
 *    daemon doesn't know about — most often a manual `docker rm`
 *    outside Cogmo's control. Mark them `exited` (no exit code; the
 *    daemon never reported one) so admission accounting frees the
 *    slot.
 *
 * Every status write is a conditional transition from the status the
 * pass read (design/sandbox.md → Container state machine), so a row a
 * cascade or an overlapping tick finished first is left as it is and
 * not counted. A second tick for the same row is a no-op: the filters
 * exclude rows already terminal.
 *
 * Scoped to the **current instance** for the TTL + stale passes — two
 * Cogmo instances on the same host shouldn't race each other for
 * each other's containers. The orphan pass is necessarily cross-
 * instance because it discovers from Docker side; the
 * `cogmo.instance` label check ensures we only reap our own past
 * runs, not the live containers of a peer instance.
 */
export interface ReaperDeps {
  docker: Docker;
  store: SandboxStore;
  runInTx: Transactor;
  instanceId: string;
  /** Override for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface ReapResult {
  ttlReaped: number;
  orphansReaped: number;
  staleMarked: number;
  networksReaped: number;
  volumesReaped: number;
}

const ZERO_RESULT: ReapResult = {
  ttlReaped: 0,
  orphansReaped: 0,
  staleMarked: 0,
  networksReaped: 0,
  volumesReaped: 0,
};

export async function runReap(deps: ReaperDeps): Promise<ReapResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: ReapResult = { ...ZERO_RESULT };

  // 1. TTL pass — containers
  const ourContainers = await deps.runInTx((tx) =>
    deps.store.listContainersForInstance(tx, deps.instanceId),
  );
  const expired = ourContainers
    .filter((c) => c.ttlExpiresAt.getTime() < now.getTime())
    .filter(isLiveContainer)
    .sort((a, b) => b.depth - a.depth);
  for (const row of expired) {
    const outcome = await reapContainer(deps, {
      id: row.id,
      dockerId: row.dockerId,
      reason: "ttl_expired",
      at: now,
    });
    result.ttlReaped += outcome.match(counted, (e) => {
      log.warn(
        { err: e.error, op: e.op, dockerId: row.dockerId },
        "reaper ttl pass: kill+remove failed",
      );
      return 0;
    });
  }

  // 2. Orphan pass — discover from Docker side. The dockerListOk flag
  // gates the stale-DB pass below: if listContainers failed, an empty
  // `dockerContainers` array is indistinguishable from "no containers",
  // and the stale pass would mark every live row `exited`. Skip the
  // stale pass when we don't have a trusted Docker view.
  let dockerContainers: ReadonlyArray<ListedContainer> = [];
  let dockerListOk = false;
  try {
    dockerContainers = await deps.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
    dockerListOk = true;
  } catch (err) {
    log.warn({ err }, "reaper orphan pass: docker.listContainers failed");
  }

  const liveInstanceIds = new Set(
    (await deps.runInTx((tx) => deps.store.listLiveInstances(tx))).map((i) => i.id),
  );
  for (const c of dockerContainers) {
    const dbRow = await deps.runInTx((tx) => deps.store.getContainerByDockerId(tx, c.Id));
    if (!isOrphan(c, dbRow, liveInstanceIds, now)) continue;
    // Counted per daemon object: the listing proved it existed, whatever
    // its row says.
    const outcome = await reapDiscoveredContainer(deps, {
      dockerId: c.Id,
      row: dbRow,
      reason: "dead_instance",
      at: now,
    });
    result.orphansReaped += outcome.match(
      () => 1,
      (e) => {
        log.warn(
          { err: e.error, op: e.op, dockerId: c.Id },
          "reaper orphan pass: kill+remove failed",
        );
        return 0;
      },
    );
  }

  // 3. Stale DB pass — rows we think are live but Docker doesn't know about.
  // Only safe to run if we successfully read the Docker side; otherwise
  // every live row would look "missing from Docker" and get marked exited.
  if (dockerListOk) {
    const dockerIdSet = new Set(dockerContainers.map((c) => c.Id));
    for (const row of ourContainers) {
      if (!isLiveContainer(row)) continue;
      // Rows the TTL pass handled this tick are its outcome, not this
      // pass's: reaped, or left for the next tick after a failed kill.
      if (expired.some((e) => e.id === row.id)) continue;
      if (dockerIdSet.has(row.dockerId)) continue;
      const outcome = await markContainerExited(deps, {
        id: row.id,
        dockerId: row.dockerId,
        from: row.status,
        at: now,
        cause: "missing_from_daemon",
      });
      result.staleMarked += counted(outcome);
    }
  }

  // 4. Networks + volumes — TTL pass for the current instance
  const ourNetworks = await deps.runInTx((tx) =>
    deps.store.listNetworksForInstance(tx, deps.instanceId),
  );
  for (const net of ourNetworks) {
    if (net.status !== "created") continue;
    if (net.ttlExpiresAt.getTime() >= now.getTime()) continue;
    try {
      await deps.docker
        .getNetwork(net.dockerId)
        .remove()
        .catch((err: unknown) => {
          if (statusCodeOf(err) !== 404) throw err;
        });
      await deps.runInTx((tx) =>
        deps.store.updateNetworkStatus(tx, { id: net.id, status: "reaped" }),
      );
      result.networksReaped += 1;
    } catch (err) {
      log.warn({ err, dockerId: net.dockerId }, "reaper networks pass: remove failed");
    }
  }

  const ourVolumes = await deps.runInTx((tx) =>
    deps.store.listVolumesForInstance(tx, deps.instanceId),
  );
  for (const vol of ourVolumes) {
    if (vol.status !== "created") continue;
    if (vol.ttlExpiresAt.getTime() >= now.getTime()) continue;
    try {
      await deps.docker
        .getVolume(vol.dockerId)
        .remove()
        .catch((err: unknown) => {
          if (statusCodeOf(err) !== 404) throw err;
        });
      await deps.runInTx((tx) =>
        deps.store.updateVolumeStatus(tx, { id: vol.id, status: "reaped" }),
      );
      result.volumesReaped += 1;
    } catch (err) {
      log.warn({ err, dockerId: vol.dockerId }, "reaper volumes pass: remove failed");
    }
  }

  return result;
}

/**
 * An orphan has no instance label, or one naming an instance that is not
 * live, or no row once the grace window has passed. The daemon's `Created`
 * is in seconds.
 */
function isOrphan(
  c: ListedContainer,
  row: ContainerRow | undefined,
  liveInstanceIds: ReadonlySet<string>,
  now: Date,
): boolean {
  const stamped = c.Labels?.[LABEL_INSTANCE];
  if (stamped === undefined || !liveInstanceIds.has(stamped)) return true;
  if (row !== undefined) return false;
  return now.getTime() - c.Created * 1000 >= ROWLESS_GRACE_MS;
}

/** A DB-driven pass counts the rows it finished; a row another path finished is its count. */
function counted(outcome: ContainerTransitionResult): 0 | 1 {
  return match(outcome)
    .with({ kind: "transitioned" }, () => 1 as const)
    .with({ kind: "stale" }, () => 0 as const)
    .exhaustive();
}

/**
 * Inngest scheduled wrapper. Runs once per minute (Inngest cron's
 * minimum interval). Slice3-plan + design/sandbox.md target every 30s,
 * but cron doesn't go below 1m natively — close enough at personal
 * scale, where TTL-expired containers spend at worst an extra minute
 * idle before reap. If sub-minute latency ever matters, switch to a
 * self-rescheduling function with `step.sleep("30s")`.
 */
export function createSandboxReaper(deps: ReaperDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "sandbox-reaper",
      // The reaper is purely cleanup — a transient docker daemon error
      // shouldn't keep retrying; the next minute's tick will pick up
      // anything we missed.
      retries: 0,
      triggers: [{ cron: "* * * * *" }],
    },
    async () => {
      const result = await runReap(deps);
      const total =
        result.ttlReaped +
        result.orphansReaped +
        result.staleMarked +
        result.networksReaped +
        result.volumesReaped;
      if (total > 0) {
        log.info({ ...result }, "reaper tick: cleaned up");
      }
      return result;
    },
  );
}
