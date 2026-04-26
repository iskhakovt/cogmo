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
