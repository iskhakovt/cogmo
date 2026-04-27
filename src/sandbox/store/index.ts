import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import {
  type ContainerLabels,
  ContainerLabelsSchema,
  type ResourceLimits,
  ResourceLimitsSchema,
} from "../types.js";
import { cogmoInstances, containers, networks, volumes } from "./schema.js";

export type ContainerRuntime = "sysbox-runc" | "runc";
export type ContainerStatus = "starting" | "running" | "exited" | "reaped";
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
  exitCode: number | null;
  ttlExpiresAt: Date;
  startedAt: Date | null;
  exitedAt: Date | null;
  instanceId: string;
  createdAt: Date;
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
  insertInstance(params: { host: string; pid: number }): Promise<CogmoInstance>;

  /** Mark an instance as stopped. Called on graceful shutdown. */
  closeInstance(id: string): Promise<void>;

  /** Load an instance row by id. */
  getInstance(id: string): Promise<CogmoInstance | null>;

  /** List instances that are still considered live (stopped_at IS NULL). */
  listLiveInstances(): Promise<readonly CogmoInstance[]>;

  // --- Containers ---

  /**
   * Insert a new container row. The supervisor calls this after Docker has
   * returned the container id so the row holds the real `docker_id` from the
   * start (no placeholder pattern in slice 1).
   */
  insertContainer(params: {
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
  }): Promise<ContainerRow>;

  /** Update lifecycle fields on a container. Used as Docker reports state changes. */
  updateContainerStatus(params: {
    id: string;
    status: ContainerStatus;
    exitCode?: number | null;
    startedAt?: Date | null;
    exitedAt?: Date | null;
  }): Promise<void>;

  /** Load a container row by Cogmo id. */
  getContainer(id: string): Promise<ContainerRow | null>;

  /** Load a container row by Docker id. */
  getContainerByDockerId(dockerId: string): Promise<ContainerRow | null>;

  /**
   * List every container belonging to an instance, regardless of status.
   * Used by the boot-time crash-recovery pass to reconcile DB rows with
   * the daemon's view.
   */
  listContainersForInstance(instanceId: string): Promise<readonly ContainerRow[]>;

  /** List containers in a root-task scope, ordered by depth DESC so cascade teardown reaps children before parents. */
  listContainersForTask(rootTaskId: string): Promise<readonly ContainerRow[]>;

  // --- Networks ---

  /** Insert a network row, status starts at 'created'. Called by the proxy on `POST /networks/create`. */
  insertNetwork(params: SandboxObjectInsert): Promise<NetworkRow>;

  /** Update a network's status (mainly to mark it 'reaped'). */
  updateNetworkStatus(params: { id: string; status: NetworkStatus }): Promise<void>;

  /** Load a network by Cogmo id. */
  getNetwork(id: string): Promise<NetworkRow | null>;

  /** Load a network by Docker id (the daemon's network id). */
  getNetworkByDockerId(dockerId: string): Promise<NetworkRow | null>;

  /** List every network for an instance. Used by crash recovery. */
  listNetworksForInstance(instanceId: string): Promise<readonly NetworkRow[]>;

  /** List networks in a root-task scope, ordered by depth DESC for cascade teardown. */
  listNetworksForTask(rootTaskId: string): Promise<readonly NetworkRow[]>;

  // --- Volumes ---

  /** Insert a volume row, status starts at 'created'. Called by the proxy on `POST /volumes/create`. */
  insertVolume(params: SandboxObjectInsert): Promise<VolumeRow>;

  /** Update a volume's status (mainly to mark it 'reaped'). */
  updateVolumeStatus(params: { id: string; status: VolumeStatus }): Promise<void>;

  /** Load a volume by Cogmo id. */
  getVolume(id: string): Promise<VolumeRow | null>;

  /** Load a volume by Docker id (the volume name). */
  getVolumeByDockerId(dockerId: string): Promise<VolumeRow | null>;

  /** List every volume for an instance. Used by crash recovery. */
  listVolumesForInstance(instanceId: string): Promise<readonly VolumeRow[]>;

  /** List volumes in a root-task scope, ordered by depth DESC for cascade teardown. */
  listVolumesForTask(rootTaskId: string): Promise<readonly VolumeRow[]>;
}

export class DrizzleSandboxStore implements SandboxStore {
  #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  // --- Instances ---

  async insertInstance(params: { host: string; pid: number }): Promise<CogmoInstance> {
    return this.#db.transaction(async (tx) => {
      return single(
        await tx.insert(cogmoInstances).values({ host: params.host, pid: params.pid }).returning({
          id: cogmoInstances.id,
          host: cogmoInstances.host,
          pid: cogmoInstances.pid,
          stoppedAt: cogmoInstances.stoppedAt,
          createdAt: cogmoInstances.createdAt,
        }),
      );
    });
  }

  async closeInstance(id: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(cogmoInstances)
        .set({ stoppedAt: new Date() })
        .where(eq(cogmoInstances.id, id));
    });
  }

  async getInstance(id: string): Promise<CogmoInstance | null> {
    return this.#db.transaction(async (tx) => {
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
      return rows[0] ?? null;
    });
  }

  async listLiveInstances(): Promise<readonly CogmoInstance[]> {
    return this.#db.transaction(async (tx) => {
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
    });
  }

  // --- Containers ---

  async insertContainer(params: {
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
  }): Promise<ContainerRow> {
    const labels = ContainerLabelsSchema.parse(params.labels);
    const resourceLimits = ResourceLimitsSchema.parse(params.resourceLimits);
    return this.#db.transaction(async (tx) => {
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
            labels,
            resourceLimits,
            status: "starting",
            ttlExpiresAt: params.ttlExpiresAt,
            instanceId: params.instanceId,
          })
          .returning(),
      );
      return parseContainerRow(row);
    });
  }

  async updateContainerStatus(params: {
    id: string;
    status: ContainerStatus;
    exitCode?: number | null;
    startedAt?: Date | null;
    exitedAt?: Date | null;
  }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const set: {
        status: ContainerStatus;
        exitCode?: number | null;
        startedAt?: Date | null;
        exitedAt?: Date | null;
      } = { status: params.status };
      if (params.exitCode !== undefined) set.exitCode = params.exitCode;
      if (params.startedAt !== undefined) set.startedAt = params.startedAt;
      if (params.exitedAt !== undefined) set.exitedAt = params.exitedAt;
      await tx.update(containers).set(set).where(eq(containers.id, params.id));
    });
  }

  async getContainer(id: string): Promise<ContainerRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(containers).where(eq(containers.id, id)).limit(1);
      return rows[0] ? parseContainerRow(rows[0]) : null;
    });
  }

  async getContainerByDockerId(dockerId: string): Promise<ContainerRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(containers)
        .where(eq(containers.dockerId, dockerId))
        .limit(1);
      return rows[0] ? parseContainerRow(rows[0]) : null;
    });
  }

  async listContainersForInstance(instanceId: string): Promise<readonly ContainerRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(containers)
        .where(eq(containers.instanceId, instanceId))
        .orderBy(asc(containers.createdAt));
      return rows.map(parseContainerRow);
    });
  }

  async listContainersForTask(rootTaskId: string): Promise<readonly ContainerRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(containers)
        // depth DESC: callers iterate to tear down children before parents
        // (a parent reaped first leaves orphaned children that the daemon
        // refuses to remove because they reference the parent's namespace).
        .where(and(eq(containers.rootTaskId, rootTaskId)))
        .orderBy(desc(containers.depth));
      return rows.map(parseContainerRow);
    });
  }

  // --- Networks ---

  async insertNetwork(params: SandboxObjectInsert): Promise<NetworkRow> {
    const labels = ContainerLabelsSchema.parse(params.labels);
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(networks)
          .values({
            dockerId: params.dockerId,
            parentId: params.parentId,
            rootTaskId: params.rootTaskId,
            depth: params.depth,
            labels,
            status: "created",
            ttlExpiresAt: params.ttlExpiresAt,
            instanceId: params.instanceId,
          })
          .returning(),
      );
      return parseNetworkRow(row);
    });
  }

  async updateNetworkStatus(params: { id: string; status: NetworkStatus }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(networks).set({ status: params.status }).where(eq(networks.id, params.id));
    });
  }

  async getNetwork(id: string): Promise<NetworkRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(networks).where(eq(networks.id, id)).limit(1);
      return rows[0] ? parseNetworkRow(rows[0]) : null;
    });
  }

  async getNetworkByDockerId(dockerId: string): Promise<NetworkRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(networks).where(eq(networks.dockerId, dockerId)).limit(1);
      return rows[0] ? parseNetworkRow(rows[0]) : null;
    });
  }

  async listNetworksForInstance(instanceId: string): Promise<readonly NetworkRow[]> {
    return this.#db.transaction(async (tx) => {
      // depth DESC, then createdAt DESC: callers (the reaper) iterate
      // the result and reap each row. If a daemon-side parent-child
      // dependency ever shows up among networks (today none does, but
      // `parent_id` + `depth` are in the schema for it), removing the
      // parent first would orphan the children. Ordering matches
      // listContainersForInstance / listNetworksForTask.
      const rows = await tx
        .select()
        .from(networks)
        .where(eq(networks.instanceId, instanceId))
        .orderBy(desc(networks.depth), desc(networks.createdAt));
      return rows.map(parseNetworkRow);
    });
  }

  async listNetworksForTask(rootTaskId: string): Promise<readonly NetworkRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(networks)
        .where(eq(networks.rootTaskId, rootTaskId))
        .orderBy(desc(networks.depth));
      return rows.map(parseNetworkRow);
    });
  }

  // --- Volumes ---

  async insertVolume(params: SandboxObjectInsert): Promise<VolumeRow> {
    const labels = ContainerLabelsSchema.parse(params.labels);
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(volumes)
          .values({
            dockerId: params.dockerId,
            parentId: params.parentId,
            rootTaskId: params.rootTaskId,
            depth: params.depth,
            labels,
            status: "created",
            ttlExpiresAt: params.ttlExpiresAt,
            instanceId: params.instanceId,
          })
          .returning(),
      );
      return parseVolumeRow(row);
    });
  }

  async updateVolumeStatus(params: { id: string; status: VolumeStatus }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(volumes).set({ status: params.status }).where(eq(volumes.id, params.id));
    });
  }

  async getVolume(id: string): Promise<VolumeRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(volumes).where(eq(volumes.id, id)).limit(1);
      return rows[0] ? parseVolumeRow(rows[0]) : null;
    });
  }

  async getVolumeByDockerId(dockerId: string): Promise<VolumeRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(volumes).where(eq(volumes.dockerId, dockerId)).limit(1);
      return rows[0] ? parseVolumeRow(rows[0]) : null;
    });
  }

  async listVolumesForInstance(instanceId: string): Promise<readonly VolumeRow[]> {
    return this.#db.transaction(async (tx) => {
      // depth DESC, then createdAt DESC — same reasoning as
      // listNetworksForInstance: the reaper reaps the result in order,
      // and a daemon-side parent-child dependency among volumes (none
      // today, but the schema supports it) needs the leaf reaped
      // before the root.
      const rows = await tx
        .select()
        .from(volumes)
        .where(eq(volumes.instanceId, instanceId))
        .orderBy(desc(volumes.depth), desc(volumes.createdAt));
      return rows.map(parseVolumeRow);
    });
  }

  async listVolumesForTask(rootTaskId: string): Promise<readonly VolumeRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(volumes)
        .where(eq(volumes.rootTaskId, rootTaskId))
        .orderBy(desc(volumes.depth));
      return rows.map(parseVolumeRow);
    });
  }
}

/**
 * Validate JSONB columns at the store boundary (CLAUDE.md rule: every JSONB
 * column has a Zod schema enforced on read and write). Drizzle's row type
 * marks `labels` / `resource_limits` as `unknown`; we narrow here.
 */
function parseContainerRow(row: typeof containers.$inferSelect): ContainerRow {
  return {
    id: row.id,
    dockerId: row.dockerId,
    parentId: row.parentId,
    rootTaskId: row.rootTaskId,
    depth: row.depth,
    image: row.image,
    runtime: row.runtime,
    labels: ContainerLabelsSchema.parse(row.labels),
    resourceLimits: ResourceLimitsSchema.parse(row.resourceLimits),
    status: row.status,
    exitCode: row.exitCode,
    ttlExpiresAt: row.ttlExpiresAt,
    startedAt: row.startedAt,
    exitedAt: row.exitedAt,
    instanceId: row.instanceId,
    createdAt: row.createdAt,
  };
}

function parseNetworkRow(row: typeof networks.$inferSelect): NetworkRow {
  return {
    id: row.id,
    dockerId: row.dockerId,
    parentId: row.parentId,
    rootTaskId: row.rootTaskId,
    depth: row.depth,
    labels: ContainerLabelsSchema.parse(row.labels),
    status: row.status,
    ttlExpiresAt: row.ttlExpiresAt,
    instanceId: row.instanceId,
    createdAt: row.createdAt,
  };
}

function parseVolumeRow(row: typeof volumes.$inferSelect): VolumeRow {
  return {
    id: row.id,
    dockerId: row.dockerId,
    parentId: row.parentId,
    rootTaskId: row.rootTaskId,
    depth: row.depth,
    labels: ContainerLabelsSchema.parse(row.labels),
    status: row.status,
    ttlExpiresAt: row.ttlExpiresAt,
    instanceId: row.instanceId,
    createdAt: row.createdAt,
  };
}
