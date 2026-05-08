import type Docker from "dockerode";
import type { Inngest } from "inngest";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { SandboxStore } from "./store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "./supervisor.js";

const log = logger.child({ component: "sandbox.reaper" });

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
 *    isn't live (or isn't a known Cogmo instance at all), or that has
 *    no matching DB row, gets reaped. Catches:
 *    - Containers from a previous Cogmo run that crashed before
 *      graceful shutdown.
 *    - Containers created by Docker but whose DB write failed (rare,
 *      but possible across a network blip between createContainer
 *      and `setTaskContainerId`).
 *
 * 3. **Stale DB pass.** Rows the DB still considers live but the
 *    daemon doesn't know about — most often a manual `docker rm`
 *    outside Cogmo's control. Mark them `exited` (no exit code; the
 *    daemon never reported one) so admission accounting frees the
 *    slot.
 *
 * Idempotent: every state transition lands on the terminal `reaped`
 * or `exited` row. A second tick re-running for the same row is a
 * no-op (the filter excludes rows already in those states).
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
    .filter(
      (c) =>
        c.ttlExpiresAt.getTime() < now.getTime() &&
        (c.status === "running" || c.status === "starting"),
    )
    .sort((a, b) => b.depth - a.depth);
  for (const row of expired) {
    try {
      await killAndRemove(deps.docker, row.dockerId);
      await deps.runInTx((tx) =>
        deps.store.updateContainerStatus(tx, {
          id: row.id,
          status: "reaped",
          exitedAt: now,
        }),
      );
      result.ttlReaped += 1;
    } catch (err) {
      log.warn({ err, dockerId: row.dockerId }, "reaper ttl pass: kill+remove failed");
    }
  }

  // 2. Orphan pass — discover from Docker side. The dockerListOk flag
  // gates the stale-DB pass below: if listContainers failed, an empty
  // `dockerContainers` array is indistinguishable from "no containers",
  // and the stale pass would mark every live row `exited`. Skip the
  // stale pass when we don't have a trusted Docker view.
  let dockerContainers: Array<{ Id: string; Labels?: Record<string, string> }> = [];
  let dockerListOk = false;
  try {
    dockerContainers = (await deps.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    })) as Array<{ Id: string; Labels?: Record<string, string> }>;
    dockerListOk = true;
  } catch (err) {
    log.warn({ err }, "reaper orphan pass: docker.listContainers failed");
  }

  const liveInstanceIds = new Set(
    (await deps.runInTx((tx) => deps.store.listLiveInstances(tx))).map((i) => i.id),
  );
  for (const c of dockerContainers) {
    const stamped = c.Labels?.[LABEL_INSTANCE];
    const dbRow = await deps.runInTx((tx) => deps.store.getContainerByDockerId(tx, c.Id));
    // Orphan if: no instance label, label points at a dead instance,
    // OR no DB row exists at all (rare orphaned create).
    const isOrphan = !stamped || !liveInstanceIds.has(stamped) || !dbRow;
    if (!isOrphan) continue;
    try {
      await killAndRemove(deps.docker, c.Id);
      if (dbRow && dbRow.status !== "reaped") {
        await deps.runInTx((tx) =>
          deps.store.updateContainerStatus(tx, {
            id: dbRow.id,
            status: "reaped",
            exitedAt: now,
          }),
        );
      }
      result.orphansReaped += 1;
    } catch (err) {
      log.warn({ err, dockerId: c.Id }, "reaper orphan pass: kill+remove failed");
    }
  }

  // 3. Stale DB pass — rows we think are live but Docker doesn't know about.
  // Only safe to run if we successfully read the Docker side; otherwise
  // every live row would look "missing from Docker" and get marked exited.
  if (dockerListOk) {
    const dockerIdSet = new Set(dockerContainers.map((c) => c.Id));
    for (const row of ourContainers) {
      if (row.status !== "running" && row.status !== "starting") continue;
      // Skip rows the TTL pass just marked reaped — re-reading is cheaper
      // than threading the freshly-reaped set through, and the next tick
      // sees the consistent state regardless.
      if (expired.some((e) => e.id === row.id)) continue;
      if (dockerIdSet.has(row.dockerId)) continue;
      await deps.runInTx((tx) =>
        deps.store.updateContainerStatus(tx, {
          id: row.id,
          status: "exited",
          exitedAt: now,
        }),
      );
      result.staleMarked += 1;
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
        .catch((err: { statusCode?: number }) => {
          if (err.statusCode !== 404) throw err;
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
        .catch((err: { statusCode?: number }) => {
          if (err.statusCode !== 404) throw err;
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

async function killAndRemove(docker: Docker, dockerId: string): Promise<void> {
  const c = docker.getContainer(dockerId);
  try {
    await c.kill({ signal: "SIGTERM" });
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 304 && e.statusCode !== 404) throw err;
  }
  try {
    await c.remove({ force: true });
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 404) throw err;
  }
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
