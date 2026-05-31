/**
 * Shared types for the Docker socket proxy. The proxy maintains a Map<task
 * socket path → TaskScope> in memory; on connection, the scope is looked up
 * by which socket received it. The scope drives label injection on
 * `POST /containers/create` and ownership checks on destructive endpoints.
 */
export interface TaskScope {
  /** Cogmo `coding_tasks.id` — denormalized into `cogmo.root_task` label. */
  taskId: string;
  /** Cogmo `coding_tasks.id` for the supervisor-created depth-0 container. */
  parentContainerRowId: string;
  /** Docker id of the depth-0 task container — written into `cogmo.parent`. */
  parentDockerId: string;
  /** Depth of the parent container (0 for the task container itself). */
  parentDepth: number;
  /** OCI runtime injected onto every `POST /containers/create`. */
  runtime: "sysbox-runc" | "runc";
  /** systemd slice or cgroupfs path written to `HostConfig.CgroupParent`. */
  cgroupParent: string;
  /** Cogmo instance id — written into `cogmo.instance`. */
  instanceId: string;
}

export interface ProxyOptions {
  /** Path to host Docker socket. Defaults to `/var/run/docker.sock`. */
  hostDockerSocket?: string;
  /** Directory holding per-task sockets. Created at `create()` if missing. */
  socketDir: string;
}
