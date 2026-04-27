import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pk, ts } from "../../db/helpers.js";

// --- Enums ---

export const containerRuntime = pgEnum("container_runtime", ["sysbox-runc", "runc"]);
export const containerStatus = pgEnum("container_status", [
  "starting",
  "running",
  "exited",
  "reaped",
]);
export const networkStatus = pgEnum("network_status", ["created", "reaped"]);
export const volumeStatus = pgEnum("volume_status", ["created", "reaped"]);

// --- Tables ---

/**
 * One row per Cogmo process lifetime. `created_at` is the boot time;
 * `stopped_at` is set on graceful shutdown. Crash detection joins
 * `containers.instance_id → cogmo_instances.id` — any container whose instance
 * row has a non-null `stopped_at` (or whose pid is no longer alive on the host)
 * is an orphan.
 */
export const cogmoInstances = pgTable("cogmo_instances", {
  id: pk(),
  host: text("host").notNull(),
  pid: integer("pid").notNull(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  createdAt: ts(),
});

/**
 * Every container Cogmo creates or proxies, with full lineage. Labels (JSONB)
 * mirror the Docker labels on the actual container; DB is authoritative.
 *
 * `parent_id` is a real FK; `root_task_id` is denormalized (no FK) so a
 * container can record its task scope without forcing every container to
 * belong to a coding task.
 */
export const containers = pgTable(
  "containers",
  {
    id: pk(),
    dockerId: text("docker_id").notNull().unique(),
    parentId: uuid("parent_id").references((): AnyPgColumn => containers.id),
    rootTaskId: uuid("root_task_id").notNull(),
    depth: integer("depth").notNull(),
    image: text("image").notNull(),
    runtime: containerRuntime("runtime").notNull(),
    labels: jsonb("labels").notNull(), // ContainerLabelsSchema
    resourceLimits: jsonb("resource_limits").notNull(), // ResourceLimitsSchema
    status: containerStatus("status").notNull(),
    exitCode: integer("exit_code"),
    ttlExpiresAt: timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => cogmoInstances.id),
    createdAt: ts(),
  },
  (t) => [
    index("idx_containers_instance_id").on(t.instanceId),
    index("idx_containers_root_task_id").on(t.rootTaskId),
    index("idx_containers_status_ttl").on(t.status, t.ttlExpiresAt),
  ],
);

/**
 * Docker networks Cogmo provisions, or that the proxy observes via
 * `POST /networks/create`. Same lineage shape as `containers`: parent is the
 * container that asked the daemon to create it (null if Cogmo created it
 * directly), `root_task_id` is the cascade scope, `instance_id` ties the row
 * to a Cogmo process for orphan reconcile. Status is binary — networks have
 * no "running" or "exited" notion at the daemon level.
 */
export const networks = pgTable(
  "networks",
  {
    id: pk(),
    dockerId: text("docker_id").notNull().unique(),
    parentId: uuid("parent_id").references(() => containers.id),
    rootTaskId: uuid("root_task_id").notNull(),
    depth: integer("depth").notNull(),
    labels: jsonb("labels").notNull(), // ContainerLabelsSchema
    status: networkStatus("status").notNull(),
    ttlExpiresAt: timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => cogmoInstances.id),
    createdAt: ts(),
  },
  (t) => [
    index("idx_networks_instance_id").on(t.instanceId),
    index("idx_networks_root_task_id").on(t.rootTaskId),
    index("idx_networks_status_ttl").on(t.status, t.ttlExpiresAt),
  ],
);

/**
 * Docker volumes — same shape as `networks`. Volume names are unique per
 * daemon, so `docker_id` here holds the volume name (Docker's identifier).
 */
export const volumes = pgTable(
  "volumes",
  {
    id: pk(),
    dockerId: text("docker_id").notNull().unique(),
    parentId: uuid("parent_id").references(() => containers.id),
    rootTaskId: uuid("root_task_id").notNull(),
    depth: integer("depth").notNull(),
    labels: jsonb("labels").notNull(), // ContainerLabelsSchema
    status: volumeStatus("status").notNull(),
    ttlExpiresAt: timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => cogmoInstances.id),
    createdAt: ts(),
  },
  (t) => [
    index("idx_volumes_instance_id").on(t.instanceId),
    index("idx_volumes_root_task_id").on(t.rootTaskId),
    index("idx_volumes_status_ttl").on(t.status, t.ttlExpiresAt),
  ],
);
