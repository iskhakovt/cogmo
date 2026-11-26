import type { Result, ResultAsync } from "neverthrow";
import type { ResourceLimits } from "../types.js";
import type { ProxyRejection } from "./rejection.js";

/**
 * Shared types for the Docker socket proxy. A task's scope is carried by
 * its socket's state while the socket serves (`task-sockets.ts`), and each
 * request reads it from the socket that accepted the connection. The scope
 * drives label injection, the resource caps on `POST /containers/create`
 * and the lineage of the child rows it inserts.
 */
export interface TaskScope {
  /** Cogmo `coding_tasks.id` — denormalized into `cogmo.root_task` label. */
  taskId: string;
  /**
   * The supervisor-created depth-0 container the task's ownership is
   * anchored to; `null` until its row exists, when every check that needs
   * ownership, a create included, is `unavailable`.
   */
  anchor: TaskAnchor | null;
  /** Depth of the parent container (0 for the task container itself). */
  parentDepth: number;
  /** OCI runtime injected onto every `POST /containers/create`. */
  runtime: "sysbox-runc" | "runc";
  /** systemd slice or cgroupfs path written to `HostConfig.CgroupParent`. */
  cgroupParent: string;
  /** Cogmo instance id — written into `cogmo.instance`. */
  instanceId: string;
  /** The task's limits: injected into a child create that sets none, and its cap. */
  resourceLimits: ResourceLimits;
  /** The task's TTL, which a child's row carries. */
  ttlExpiresAt: Date;
}

/** The task's depth-0 container: its row and its docker id, known together. */
export interface TaskAnchor {
  /** The `containers` row id, which a child's row names as its parent. */
  readonly rowId: string;
  /** The daemon's id, written into a child's `cogmo.parent` label. */
  readonly dockerId: string;
}

export interface ProxyOptions {
  /** Path to host Docker socket. Defaults to `/var/run/docker.sock`. */
  hostDockerSocket?: string;
  /** Directory holding per-task sockets. Created at `create()` if missing. */
  socketDir: string;
  /** The store's `containers` rows, which decide what a task owns. */
  containerRows: ContainerRows;
  /** The writes that follow a child's create, start and removal. */
  childContainers: ChildContainers;
}

/** A `containers` row that carries a task's `root_task_id` and is not `reaped`. */
export interface TaskContainerRow {
  /** The row's id, which a child's `parentId` names. */
  readonly id: string;
  readonly dockerId: string;
  /** `null` for a depth-0 row. */
  readonly parentId: string | null;
  /** 0 for a depth-0 container, 1 for a child. */
  readonly depth: number;
  readonly status: "starting" | "running" | "exited";
}

/** The store read failed; the proxy answers `unavailable`. */
export interface StoreFailed {
  kind: "store_failed";
  cause: unknown;
}

/**
 * Read access to the `containers` rows, read on every request that checks
 * ownership. A task owns only its scope's depth-0 row and that row's
 * children among them (`ownership.ts`).
 */
export interface ContainerRows {
  forTask(taskId: string): ResultAsync<ReadonlyArray<TaskContainerRow>, StoreFailed>;
}

/**
 * A child's `containers` row, inserted in `starting` once the daemon has
 * answered 201 to its create (design/sandbox.md → Child containers).
 */
export interface ChildRecord {
  dockerId: string;
  /** The task's depth-0 row. */
  parentId: string;
  rootTaskId: string;
  depth: number;
  /** The image as the task named it. */
  image: string;
  runtime: "sysbox-runc" | "runc";
  /** The Cogmo labels the create policy injected. */
  labels: Readonly<Record<string, string>>;
  /** The limits the create policy injected or capped. */
  resourceLimits: ResourceLimits;
  ttlExpiresAt: Date;
  instanceId: string;
}

/**
 * The child's row was not written: the insert failed, or the create was
 * cut off first, by its deadline or its socket's teardown. Either way its
 * container is removed, or left to the orphan pass; the use case has
 * logged why.
 */
export type ChildRecordFailed = { kind: "record_failed" } | { kind: "cut_off" };

/**
 * Whether a child's start stands. `started` covers a row moved to
 * `running`, one already `running` (a child stopped and started again), and
 * one already `exited` because the child is gone (a `--rm` child that ran,
 * exited and removed itself before the row write). `reaped` is a row a reap
 * finished meanwhile, whose container has been killed and removed.
 */
export type ChildStartOutcome = { kind: "started" } | { kind: "reaped" };

/**
 * Why a child's container is gone without Cogmo removing it: the daemon
 * removed it at the task's request, or no longer has it.
 */
export type ChildExitCause = "removed_by_task" | "missing_from_daemon";

/**
 * The store writes that follow the daemon's answers to a task's child
 * requests (design/sandbox.md → Container state machine). Built at boot over
 * the sandbox store and the daemon; the proxy never reaches either itself.
 */
export interface ChildContainers {
  /**
   * Insert the child's row unless `cutOff` aborts first: the create's
   * deadline, or its socket's teardown. A failed insert, or one cut off,
   * removes the container, with its anonymous volumes.
   */
  record(child: ChildRecord, cutOff: AbortSignal): ResultAsync<void, ChildRecordFailed>;
  /** `starting → running` once the daemon has started or restarted the child. */
  started(child: TaskContainerRow): ResultAsync<ChildStartOutcome, StoreFailed>;
  /**
   * `→ exited` once a task's `DELETE` of the child is answered: removed at
   * its request, or already gone from the daemon.
   */
  removed(child: TaskContainerRow, cause: ChildExitCause): ResultAsync<void, StoreFailed>;
  /**
   * The live children the daemon still has. One it no longer has (a
   * `docker run --rm` child removes itself, with no `DELETE` through the
   * proxy) moves to `exited`, as the reaper's stale pass would move it. One
   * whose inspect fails, times out, or is cut off by `signal`, the task
   * socket's, counts as live.
   */
  reconcile(
    children: ReadonlyArray<TaskContainerRow>,
    signal: AbortSignal,
  ): ResultAsync<ReadonlyArray<TaskContainerRow>, StoreFailed>;
}

/** What the create policy reads from an image inspect. */
export interface ImageFacts {
  /** The image's content-addressed id, forwarded in place of the name asked for. */
  id: string;
  /** `Config.Env`: image `ENV` merges into the container's OCI env. */
  env: ReadonlyArray<string>;
}

/** The daemon's own platform, from `GET /version`. */
export interface HostPlatform {
  readonly os: string;
  readonly arch: string;
}

/**
 * How a daemon lookup fails: `not_found` for an image the daemon does not
 * have, `malformed` for a reference the daemon refuses to parse,
 * `unavailable` for a lookup that failed.
 */
export type LookupFailure = Extract<
  ProxyRejection,
  { kind: "not_found" | "malformed" | "unavailable" }
>;

/** The daemon reads the create policy needs. A failure is a value. */
export interface DaemonLookups {
  inspectImage(ref: string): Promise<Result<ImageFacts, LookupFailure>>;
  hostPlatform(): Promise<Result<HostPlatform, LookupFailure>>;
  /**
   * The address a published port binds to: the `bridge` network's IPv4
   * gateway on a rootful daemon, loopback on a rootless one.
   */
  publishAddress(): Promise<Result<string, LookupFailure>>;
}

/** How a ref lookup fails: `not_found` for a ref the daemon cannot resolve, `unavailable` otherwise. */
export type ResolveFailure = Extract<ProxyRejection, { kind: "not_found" | "unavailable" }>;

/** The daemon lookups that resolve a ref in a path or body to the object's full id. */
export interface RefLookups {
  /** `GET /containers/{ref}/json`: a full id, a unique id prefix or a name. */
  resolveContainer(ref: string): Promise<Result<string, ResolveFailure>>;
  /** `GET /networks/{ref}`: a full id, a name or a unique id prefix. */
  resolveNetwork(ref: string): Promise<Result<string, ResolveFailure>>;
}
