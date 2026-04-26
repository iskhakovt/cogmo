import type { Readable, Writable } from "node:stream";
import type Docker from "dockerode";
import type { ContainerRow, SandboxStore } from "./store/index.js";
import type { ResourceLimits } from "./types.js";

export type { SandboxRuntime } from "./runtime.js";
export type { ContainerRow, ContainerRuntime, ContainerStatus } from "./store/index.js";
export type { ContainerLabels, ResourceLimits } from "./types.js";

/** Logical specification for a brand-new task container. */
export interface TaskContainerSpec {
  /** Logical task id (denormalized into the `containers.root_task_id` column). */
  rootTaskId: string;
  /** Host path bind-mounted into the container at `/workspace`. */
  worktreePath: string;
  /** Per-task named volume mounted at the user's home (`/home/<image-user>`). */
  homeVolumeName: string;
  /** Image to launch. */
  image: string;
  /** Resource caps applied via Docker `HostConfig`. */
  resourceLimits: ResourceLimits;
  /** When the container should be reaped if not torn down sooner. */
  ttl: { expiresAt: Date };
  /**
   * Per-task escape hatch: drop sysbox isolation and run under plain `runc`.
   * Reserved for workloads that break under sysbox (rare). Slice-1 callers
   * always pass `false`.
   */
  allowPrivilegedRunc: boolean;
}

export interface ExecOptions {
  workingDir?: string;
  user?: string;
  env?: Readonly<Record<string, string>>;
  /** When true, `stdin` is exposed on the returned handle. */
  attachStdin?: boolean;
}

/**
 * One running `docker exec`. Streams are demultiplexed already — `stdout` and
 * `stderr` are separate Readables. Awaiting `wait()` resolves with the exit
 * code once Docker reports the exec finished. If `attachStdin` was set, write
 * to `stdin` to feed the process; close it via `stdin.end()` when done.
 */
export interface ExecHandle {
  stdin?: Writable;
  stdout: Readable;
  stderr: Readable;
  wait(): Promise<{ exitCode: number }>;
}

/**
 * Handle returned by `createTaskContainer`. Holds both the Cogmo DB id and
 * the Docker id, plus an `exec` shortcut that the orchestrator uses to run
 * `claude` (and later `codex`) inside the container.
 */
export interface TaskContainerHandle {
  containerRowId: string;
  dockerId: string;
  exec(cmd: readonly string[], opts?: ExecOptions): Promise<ExecHandle>;
}

export interface InspectResult {
  status: string;
  runtime: string;
}

/**
 * The sandbox capability surface. P1 ships `LocalInProcessSandbox`; future
 * `LocalSidecarSandbox` (P2) and `RemoteSshSandbox` swap in behind the same
 * interface. Methods marked `// later slices` are declared on the interface
 * but throw `NotImplementedError` in slice 1 — see [design/sandbox.md].
 */
export interface Sandbox {
  /** Verify the configured runtime is registered and the daemon is reachable. Throws on misconfig. */
  healthCheck(): Promise<{ ok: true; runtime: string }>;

  /** Boot-time reconciliation: kill containers tagged with a different `cogmo.instance`. */
  reconcileCrashedInstances(currentInstanceId: string): Promise<{ orphansReaped: number }>;

  createTaskContainer(spec: TaskContainerSpec): Promise<TaskContainerHandle>;

  /**
   * Re-derive a `TaskContainerHandle` for an existing container. Pure
   * factory — no Docker call beyond an inspect to verify the container is
   * still there. Used by orchestrators that crossed a `step.run` boundary
   * (which can only return JSON-serializable values, not handles).
   */
  getTaskContainer(dockerId: string): Promise<TaskContainerHandle>;

  /** Tear down every container in a root-task scope (cascade). Idempotent. */
  stopTask(rootTaskId: string): Promise<void>;

  listContainersForTask(rootTaskId: string): Promise<readonly ContainerRow[]>;

  /** Inspect a container by Docker id. Returns runtime + status reported by the daemon. */
  inspectContainer(dockerId: string): Promise<InspectResult>;

  /** Release any non-DB resources (close docker connections, etc.). */
  shutdown(): Promise<void>;
}

export interface SandboxDeps {
  docker: Docker;
  store: SandboxStore;
}

export { dockerRuntimeName } from "./runtime.js";
export { createSandbox, LocalInProcessSandbox } from "./supervisor.js";
