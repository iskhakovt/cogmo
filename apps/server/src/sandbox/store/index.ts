import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { match } from "ts-pattern";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { ContainerLabels, ResourceLimits } from "../types.js";
import {
  cogmoInstances,
  type containerReapedReason,
  containers,
  networks,
  volumes,
} from "./schema.js";

export type ContainerRuntime = "sysbox-runc" | "runc";
export type ContainerStatus = "starting" | "running" | "exited" | "reaped";

/** What a `reaped` row records as its reason: the `container_reaped_reason` pgEnum. */
export type ContainerReapedReason = (typeof containerReapedReason.enumValues)[number];

/** Why a container is being reaped — what a reap transition carries. */
export type ContainerReapReason = Exclude<ContainerReapedReason, "unknown">;

/**
 * The legal `containers.status` transitions (design/sandbox.md → Container
 * state machine). `at` stamps `started_at` on the way into `running` and
 * `exited_at` on the way into a terminal state; a row that is already
 * `exited` keeps its `exited_at` when it is reaped.
 *
 * A reap names no `from`: it is legal from every state but `reaped`, and it
 * must land on a row another path moved forward (`starting → running`)
 * between the reaper's read and its kill — the container is gone either way.
 */
export type ContainerTransition =
  | { from: "starting"; to: "running" }
  | { from: "starting" | "running"; to: "exited" }
  | { to: "reaped"; reason: ContainerReapReason };

export type ContainerTransitionResult =
  | { kind: "transitioned" }
  /** The row is not in `from` (for a reap: is already `reaped`); `status` is what it holds. */
  | { kind: "stale"; status: ContainerStatus };
export type NetworkStatus = "created" | "reaped";
export type VolumeStatus = "created" | "reaped";

export interface CogmoInstance {
  id: string;
  host: string;
  pid: number;
  stoppedAt: Date | null;
  createdAt: Date;
}

export interface ContainerRow {
  id: string;
  dockerId: string;
  parentId: string | null;
  rootTaskId: string;
  depth: number;
  image: string;
  runtime: ContainerRuntime;
  labels: ContainerLabels;
  resourceLimits: ResourceLimits;
  status: ContainerStatus;
  /** Set exactly when `status` is `reaped` (`chk_containers_reaped_reason`). */
  reapedReason: ContainerReapedReason | null;
  ttlExpiresAt: Date;
  startedAt: Date | null;
  exitedAt: Date | null;
  instanceId: string;
  createdAt: Date;
}

/** A row whose container the DB still expects to find on the daemon. */
export type LiveContainerRow = ContainerRow & { status: "starting" | "running" };

export function isLiveContainer(row: ContainerRow): row is LiveContainerRow {
  return row.status === "starting" || row.status === "running";
}

export interface NetworkRow {
  id: string;
  dockerId: string;
  parentId: string | null;
  rootTaskId: string;
  depth: number;
  labels: ContainerLabels;
  status: NetworkStatus;
  ttlExpiresAt: Date;
  instanceId: string;
  createdAt: Date;
}

export interface VolumeRow {
  id: string;
  dockerId: string;
  parentId: string | null;
  rootTaskId: string;
  depth: number;
  labels: ContainerLabels;
  status: VolumeStatus;
  ttlExpiresAt: Date;
  instanceId: string;
  createdAt: Date;
}

export interface SandboxObjectInsert {
  dockerId: string;
  parentId: string | null;
  rootTaskId: string;
  depth: number;
  labels: ContainerLabels;
  ttlExpiresAt: Date;
  instanceId: string;
}

export interface SandboxStore {
  // --- Instances ---

  /** Insert a new Cogmo instance row. Called once at boot. */
  insertInstance(tx: Transaction, params: { host: string; pid: number }): Promise<CogmoInstance>;

  /** Mark an instance as stopped, if it is still open. Called on graceful shutdown. */
  closeInstance(tx: Transaction, id: string): Promise<void>;

  /**
   * Mark every listed instance that is still open as stopped. Called by
   * boot-time reconcile on the prior instances whose containers it reaped;
   * a `stopped_at` another path already set is kept.
   */
  closeInstances(tx: Transaction, ids: readonly string[]): Promise<void>;

  /** Load an instance row by id. */
  getInstance(tx: Transaction, id: string): Promise<CogmoInstance | undefined>;

  /** List instances that are still considered live (stopped_at IS NULL). */
  listLiveInstances(tx: Transaction): Promise<readonly CogmoInstance[]>;

  // --- Containers ---

  /**
   * Insert a new container row. The supervisor calls this after Docker has
   * returned the container id so the row holds the real `docker_id` from the
   * start (no placeholder pattern in slice 1).
   */
  insertContainer(
    tx: Transaction,
    params: {
      dockerId: string;
      parentId: string | null;
      rootTaskId: string;
      depth: number;
      image: string;
      runtime: ContainerRuntime;
      labels: ContainerLabels;
      resourceLimits: ResourceLimits;
      ttlExpiresAt: Date;
      instanceId: string;
    },
  ): Promise<ContainerRow>;

  /**
   * Move a container to `to` in one conditional UPDATE, guarded on `from`
   * (or on `status <> 'reaped'` for a reap, which also writes its `reason`
   * to `reaped_reason`). `stale` means another path (the reaper, a cascade,
   * the supervisor) finished the row first; the caller decides whether that
   * matters. A missing row is an invariant violation and throws — callers
   * hold a row they just read, and rows are never deleted.
   */
  transitionContainerStatus(
    tx: Transaction,
    params: { id: string; at: Date } & ContainerTransition,
  ): Promise<ContainerTransitionResult>;

  /** Load a container row by Cogmo id. */
  getContainer(tx: Transaction, id: string): Promise<ContainerRow | undefined>;

  /** Load a container row by Docker id. */
  getContainerByDockerId(tx: Transaction, dockerId: string): Promise<ContainerRow | undefined>;

  /**
   * List every container belonging to an instance, regardless of status.
   * Used by the boot-time crash-recovery pass to reconcile DB rows with
   * the daemon's view.
   */
  listContainersForInstance(tx: Transaction, instanceId: string): Promise<readonly ContainerRow[]>;

  /** List containers in a root-task scope, ordered by depth DESC so cascade teardown reaps children before parents. */
  listContainersForTask(tx: Transaction, rootTaskId: string): Promise<readonly ContainerRow[]>;

  // --- Networks ---

  /** Insert a network row, status starts at 'created'. Called by the proxy on `POST /networks/create`. */
  insertNetwork(tx: Transaction, params: SandboxObjectInsert): Promise<NetworkRow>;

  /** Update a network's status (mainly to mark it 'reaped'). */
  updateNetworkStatus(
    tx: Transaction,
    params: { id: string; status: NetworkStatus },
  ): Promise<void>;

  /** Load a network by Cogmo id. */
  getNetwork(tx: Transaction, id: string): Promise<NetworkRow | undefined>;

  /** Load a network by Docker id (the daemon's network id). */
  getNetworkByDockerId(tx: Transaction, dockerId: string): Promise<NetworkRow | undefined>;

  /** List every network for an instance. Used by crash recovery. */
  listNetworksForInstance(tx: Transaction, instanceId: string): Promise<readonly NetworkRow[]>;

  /** List networks in a root-task scope, ordered by depth DESC for cascade teardown. */
  listNetworksForTask(tx: Transaction, rootTaskId: string): Promise<readonly NetworkRow[]>;

  // --- Volumes ---

  /** Insert a volume row, status starts at 'created'. Called by the proxy on `POST /volumes/create`. */
  insertVolume(tx: Transaction, params: SandboxObjectInsert): Promise<VolumeRow>;

  /** Update a volume's status (mainly to mark it 'reaped'). */
  updateVolumeStatus(tx: Transaction, params: { id: string; status: VolumeStatus }): Promise<void>;

  /** Load a volume by Cogmo id. */
  getVolume(tx: Transaction, id: string): Promise<VolumeRow | undefined>;

  /** Load a volume by Docker id (the volume name). */
  getVolumeByDockerId(tx: Transaction, dockerId: string): Promise<VolumeRow | undefined>;

  /** List every volume for an instance. Used by crash recovery. */
  listVolumesForInstance(tx: Transaction, instanceId: string): Promise<readonly VolumeRow[]>;

  /** List volumes in a root-task scope, ordered by depth DESC for cascade teardown. */
  listVolumesForTask(tx: Transaction, rootTaskId: string): Promise<readonly VolumeRow[]>;
}

export class DrizzleSandboxStore implements SandboxStore {
  // --- Instances ---

  async insertInstance(
    tx: Transaction,
    params: { host: string; pid: number },
  ): Promise<CogmoInstance> {
    return single(
      await tx.insert(cogmoInstances).values({ host: params.host, pid: params.pid }).returning({
        id: cogmoInstances.id,
        host: cogmoInstances.host,
        pid: cogmoInstances.pid,
        stoppedAt: cogmoInstances.stoppedAt,
        createdAt: cogmoInstances.createdAt,
      }),
    );
  }

  async closeInstance(tx: Transaction, id: string): Promise<void> {
    await this.closeInstances(tx, [id]);
  }

  async closeInstances(tx: Transaction, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(cogmoInstances)
      .set({ stoppedAt: new Date() })
      .where(and(inArray(cogmoInstances.id, [...ids]), isNull(cogmoInstances.stoppedAt)));
  }

  async getInstance(tx: Transaction, id: string): Promise<CogmoInstance | undefined> {
    const rows = await tx
      .select({
        id: cogmoInstances.id,
        host: cogmoInstances.host,
        pid: cogmoInstances.pid,
        stoppedAt: cogmoInstances.stoppedAt,
        createdAt: cogmoInstances.createdAt,
      })
      .from(cogmoInstances)
      .where(eq(cogmoInstances.id, id))
      .limit(1);
    return rows[0];
  }

  async listLiveInstances(tx: Transaction): Promise<readonly CogmoInstance[]> {
    return tx
      .select({
        id: cogmoInstances.id,
        host: cogmoInstances.host,
        pid: cogmoInstances.pid,
        stoppedAt: cogmoInstances.stoppedAt,
        createdAt: cogmoInstances.createdAt,
      })
      .from(cogmoInstances)
      .where(isNull(cogmoInstances.stoppedAt))
      .orderBy(asc(cogmoInstances.createdAt));
  }

  // --- Containers ---

  async insertContainer(
    tx: Transaction,
    params: {
      dockerId: string;
      parentId: string | null;
      rootTaskId: string;
      depth: number;
      image: string;
      runtime: ContainerRuntime;
      labels: ContainerLabels;
      resourceLimits: ResourceLimits;
      ttlExpiresAt: Date;
      instanceId: string;
    },
  ): Promise<ContainerRow> {
    const row = single(
      await tx
        .insert(containers)
        .values({
          dockerId: params.dockerId,
          parentId: params.parentId,
          rootTaskId: params.rootTaskId,
          depth: params.depth,
          image: params.image,
          runtime: params.runtime,
          labels: params.labels,
          resourceLimits: params.resourceLimits,
          status: "starting",
          ttlExpiresAt: params.ttlExpiresAt,
          instanceId: params.instanceId,
        })
        .returning(),
    );
    return row;
  }

  async transitionContainerStatus(
    tx: Transaction,
    params: { id: string; at: Date } & ContainerTransition,
  ): Promise<ContainerTransitionResult> {
    // `coalesce` keeps the `exited_at` an `exited` row already carries. The
    // ISO string, not the Date, goes into the fragment: raw `sql` skips the
    // column's driver mapping, and postgres-js rejects a Date bind.
    const set = match(params)
      .with({ to: "running" }, ({ to }) => ({ status: to, startedAt: params.at }))
      .with({ to: "exited" }, ({ to }) => ({ status: to, exitedAt: params.at }))
      .with({ to: "reaped" }, ({ to, reason }) => ({
        status: to,
        reapedReason: reason,
        exitedAt: sql`coalesce(${containers.exitedAt}, ${params.at.toISOString()}::timestamptz)`,
      }))
      .exhaustive();
    const guard = match(params)
      .with({ to: "reaped" }, () => ne(containers.status, "reaped"))
      .with({ to: "running" }, ({ from }) => eq(containers.status, from))
      .with({ to: "exited" }, ({ from }) => eq(containers.status, from))
      .exhaustive();
    const updated = await tx
      .update(containers)
      .set(set)
      .where(and(eq(containers.id, params.id), guard))
      .returning({ id: containers.id });
    if (updated.length > 0) return { kind: "transitioned" };
    const current = await tx
      .select({ status: containers.status })
      .from(containers)
      .where(eq(containers.id, params.id))
      .limit(1);
    const row = current[0];
    if (row === undefined) {
      throw new Error(`transitionContainerStatus: no containers row with id ${params.id}`);
    }
    return { kind: "stale", status: row.status };
  }

  async getContainer(tx: Transaction, id: string): Promise<ContainerRow | undefined> {
    const rows = await tx.select().from(containers).where(eq(containers.id, id)).limit(1);
    return rows[0];
  }

  async getContainerByDockerId(
    tx: Transaction,
    dockerId: string,
  ): Promise<ContainerRow | undefined> {
    const rows = await tx
      .select()
      .from(containers)
      .where(eq(containers.dockerId, dockerId))
      .limit(1);
    return rows[0];
  }

  async listContainersForInstance(
    tx: Transaction,
    instanceId: string,
  ): Promise<readonly ContainerRow[]> {
    return tx
      .select()
      .from(containers)
      .where(eq(containers.instanceId, instanceId))
      .orderBy(asc(containers.createdAt));
  }

  async listContainersForTask(
    tx: Transaction,
    rootTaskId: string,
  ): Promise<readonly ContainerRow[]> {
    // depth DESC: callers iterate to tear down children before parents
    // (a parent reaped first leaves orphaned children that the daemon
    // refuses to remove because they reference the parent's namespace).
    return tx
      .select()
      .from(containers)
      .where(and(eq(containers.rootTaskId, rootTaskId)))
      .orderBy(desc(containers.depth));
  }

  // --- Networks ---

  async insertNetwork(tx: Transaction, params: SandboxObjectInsert): Promise<NetworkRow> {
    const row = single(
      await tx
        .insert(networks)
        .values({
          dockerId: params.dockerId,
          parentId: params.parentId,
          rootTaskId: params.rootTaskId,
          depth: params.depth,
          labels: params.labels,
          status: "created",
          ttlExpiresAt: params.ttlExpiresAt,
          instanceId: params.instanceId,
        })
        .returning(),
    );
    return row;
  }

  async updateNetworkStatus(
    tx: Transaction,
    params: { id: string; status: NetworkStatus },
  ): Promise<void> {
    await tx.update(networks).set({ status: params.status }).where(eq(networks.id, params.id));
  }

  async getNetwork(tx: Transaction, id: string): Promise<NetworkRow | undefined> {
    const rows = await tx.select().from(networks).where(eq(networks.id, id)).limit(1);
    return rows[0];
  }

  async getNetworkByDockerId(tx: Transaction, dockerId: string): Promise<NetworkRow | undefined> {
    const rows = await tx.select().from(networks).where(eq(networks.dockerId, dockerId)).limit(1);
    return rows[0];
  }

  async listNetworksForInstance(
    tx: Transaction,
    instanceId: string,
  ): Promise<readonly NetworkRow[]> {
    // depth DESC, then createdAt DESC: callers (the reaper) iterate the
    // result and reap each row. If a daemon-side parent-child dependency
    // ever shows up among networks (today none does, but `parent_id` +
    // `depth` are in the schema for it), removing the parent first would
    // orphan the children. Ordering matches listContainersForInstance /
    // listNetworksForTask.
    return tx
      .select()
      .from(networks)
      .where(eq(networks.instanceId, instanceId))
      .orderBy(desc(networks.depth), desc(networks.createdAt));
  }

  async listNetworksForTask(tx: Transaction, rootTaskId: string): Promise<readonly NetworkRow[]> {
    return tx
      .select()
      .from(networks)
      .where(eq(networks.rootTaskId, rootTaskId))
      .orderBy(desc(networks.depth));
  }

  // --- Volumes ---

  async insertVolume(tx: Transaction, params: SandboxObjectInsert): Promise<VolumeRow> {
    const row = single(
      await tx
        .insert(volumes)
        .values({
          dockerId: params.dockerId,
          parentId: params.parentId,
          rootTaskId: params.rootTaskId,
          depth: params.depth,
          labels: params.labels,
          status: "created",
          ttlExpiresAt: params.ttlExpiresAt,
          instanceId: params.instanceId,
        })
        .returning(),
    );
    return row;
  }

  async updateVolumeStatus(
    tx: Transaction,
    params: { id: string; status: VolumeStatus },
  ): Promise<void> {
    await tx.update(volumes).set({ status: params.status }).where(eq(volumes.id, params.id));
  }

  async getVolume(tx: Transaction, id: string): Promise<VolumeRow | undefined> {
    const rows = await tx.select().from(volumes).where(eq(volumes.id, id)).limit(1);
    return rows[0];
  }

  async getVolumeByDockerId(tx: Transaction, dockerId: string): Promise<VolumeRow | undefined> {
    const rows = await tx.select().from(volumes).where(eq(volumes.dockerId, dockerId)).limit(1);
    return rows[0];
  }

  async listVolumesForInstance(tx: Transaction, instanceId: string): Promise<readonly VolumeRow[]> {
    // depth DESC, then createdAt DESC — same reasoning as
    // listNetworksForInstance: the reaper reaps the result in order, and
    // a daemon-side parent-child dependency among volumes (none today, but
    // the schema supports it) needs the leaf reaped before the root.
    return tx
      .select()
      .from(volumes)
      .where(eq(volumes.instanceId, instanceId))
      .orderBy(desc(volumes.depth), desc(volumes.createdAt));
  }

  async listVolumesForTask(tx: Transaction, rootTaskId: string): Promise<readonly VolumeRow[]> {
    return tx
      .select()
      .from(volumes)
      .where(eq(volumes.rootTaskId, rootTaskId))
      .orderBy(desc(volumes.depth));
  }
}
