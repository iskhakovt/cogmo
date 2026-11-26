import type { Result } from "neverthrow";
import type { ResourceLimits } from "../types.js";
import type { ProxyRejection } from "./rejection.js";

/**
 * Shared types for the Docker socket proxy. The proxy maintains a Map<task
 * socket path → TaskScope> in memory; on connection, the scope is looked up
 * by which socket received it. The scope drives label injection and the
 * resource caps on `POST /containers/create`.
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
  /** The task's limits: injected into a child create that sets none, and its cap. */
  resourceLimits: ResourceLimits;
}

export interface ProxyOptions {
  /** Path to host Docker socket. Defaults to `/var/run/docker.sock`. */
  hostDockerSocket?: string;
  /** Directory holding per-task sockets. Created at `create()` if missing. */
  socketDir: string;
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
