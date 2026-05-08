import type { Readable, Writable } from "node:stream";
import type Docker from "dockerode";
import { z } from "zod";
import type { SandboxStore } from "./store/index.js";
import type { ResourceLimits } from "./types.js";

export type { SandboxRuntime } from "./runtime.js";
export type { ContainerRow, ContainerRuntime, ContainerStatus } from "./store/index.js";
export type { ContainerLabels, ResourceLimits } from "./types.js";

/** Working-tree material to materialize at session start. */
export interface WorktreeSpec {
  /** Local-Docker: host path bind-mounted at `/workspace`. */
  hostPath: string;
}

/** Persistent per-task scratch volume mounted at the image's home dir. */
export interface HomeVolumeSpec {
  /** Local-Docker: named Docker volume; created on demand. */
  volumeName: string;
}

/** Per-task askpass secrets directory. Backend bind-mounts read-only. */
export interface AskpassSpec {
  hostDir: string;
  containerDir: string;
}

/** Logical specification for a brand-new sandbox session. */
export interface SessionSpec {
  /** Logical task id — propagates to backend lineage tracking and labels. */
  taskId: string;
  /** Container image. The backend assumes `ensureImagePresent` has succeeded. */
  image: string;
  resourceLimits: ResourceLimits;
  /** When the session should be reaped if not torn down sooner. */
  expiresAt: Date;
  /**
   * Working tree to materialize. Optional — coding-delegation supplies it,
   * skills tier-2 omits it because skill workers don't run in a checkout.
   */
  worktree?: WorktreeSpec;
  /**
   * Persistent per-task scratch. Optional — coding-delegation uses it to
   * persist the Claude Code CLI's session state across exec calls; skills
   * tier-2 omits it because the `recycle` isolation contract forbids state
   * surviving the task.
   */
  homeVolume?: HomeVolumeSpec;
  askpass?: AskpassSpec;
  /**
   * Per-task escape hatch: drop sysbox isolation and run under plain `runc`.
   * Reserved for workloads that break under sysbox (rare). Local-Docker
   * honors the flag; backends without sysbox ignore it.
   */
  allowPrivilegedRunc?: boolean;
}

export interface ExecOptions {
  workingDir?: string;
  user?: string;
  env?: Readonly<Record<string, string>>;
  /** When true, `stdin` is exposed on the returned streaming handle. */
  attachStdin?: boolean;
}

/**
 * Buffered exec result. `stdout` / `stderr` are read fully into memory —
 * intended for short, bounded commands. Backends cap buffered output at
 * `SANDBOX_EXEC_BUFFER_LIMIT` (default 1 MiB per stream); when a command
 * exceeds the cap, `truncated` is set and the stream contents are clipped
 * to the cap. Consumers expecting larger output use `execStreaming`.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  wallTimeSeconds: number;
  truncated: boolean;
}

/**
 * Streaming exec handle. `stdout` / `stderr` are demultiplexed Readables
 * (no inline framing). `wait()` resolves with the exit code once the
 * backend reports the process finished. `dispose()` kills a runaway exec
 * — SIGTERM, then SIGKILL after a short grace — and is idempotent. The
 * caller is responsible for either consuming `stdout`/`stderr` to EOF or
 * calling `dispose()`; otherwise the backend may hold the connection
 * open.
 */
export interface ExecStreamingHandle {
  stdin?: Writable;
  stdout: Readable;
  stderr: Readable;
  wait(): Promise<{ exitCode: number }>;
  dispose(): Promise<void>;
}

/**
 * Backend-advertised capability flags. Consumers branch on these to pick
 * the right transport / policy without backend awareness.
 */
export interface SandboxCapabilities {
  siblingContainers: "host-proxy" | "sandbox-internal" | "unsupported";
  hostBindMount: boolean;
  customImage: boolean;
  volumes: "docker" | "managed" | "none";
  workingTreeTransport: "bind-mount" | "git-remote";
}

/**
 * Discriminator for serialized session state. Each backend gets its own
 * literal; the variant is the entry point Zod uses to dispatch parsing.
 * Phase 2 ships only the local-docker variant — Daytona joins in Phase 3.
 */
export const LocalDockerSessionStateSchema = z.object({
  type: z.literal("local-docker"),
  taskId: z.string().min(1),
  containerRowId: z.string().min(1),
  dockerId: z.string().min(1),
});
export type LocalDockerSessionState = z.infer<typeof LocalDockerSessionStateSchema>;

/** All backends' state variants — discriminated union by `type`. */
export const SandboxSessionStateSchema = z.discriminatedUnion("type", [
  LocalDockerSessionStateSchema,
]);
export type SandboxSessionState = z.infer<typeof SandboxSessionStateSchema>;

/**
 * One running task environment. Owns the underlying container/sandbox
 * lifetime; teardown goes through `SandboxClient.delete(session)` rather
 * than a method on the session itself (see [design/sandbox.md] →
 * Backend Architecture).
 */
export interface SandboxSession<TState extends SandboxSessionState = SandboxSessionState> {
  /** Serializable state — JSONB-storable, round-trips via `serializeState` / `deserializeState`. */
  readonly state: TState;

  /** Buffered exec — short commands. See `ExecResult` for size-cap behaviour. */
  exec(cmd: readonly string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Streaming exec — long-running commands or interactive stdin. */
  execStreaming(cmd: readonly string[], opts?: ExecOptions): Promise<ExecStreamingHandle>;
}

/**
 * Backend factory + lifecycle. One instance per Cogmo process; mints
 * `SandboxSession`s for each task. The `TState` parameter narrows session
 * state to the backend's variant — `LocalDockerSandboxClient` is
 * `SandboxClient<LocalDockerSessionState>`.
 */
export interface SandboxClient<TState extends SandboxSessionState = SandboxSessionState> {
  readonly backendId: string;
  readonly capabilities: SandboxCapabilities;

  /** Verify the backend is reachable and configured correctly. Throws on misconfig. */
  healthCheck(): Promise<{ ok: true; runtime: string }>;

  /** Boot-time reconciliation: kill any sessions tagged with a different `cogmo.instance`. */
  reconcileCrashedInstances(currentInstanceId: string): Promise<{ orphansReaped: number }>;

  /**
   * Verify `image` is reachable from the backend (locally cached on
   * Local-Docker, registry-reachable on Daytona). Idempotent and cheap
   * when satisfied.
   */
  ensureImagePresent(image: string): Promise<void>;

  /** Mint a new session per `spec`. */
  create(spec: SessionSpec): Promise<SandboxSession<TState>>;

  /**
   * Re-attach to an existing session via its serialized state. Pure
   * factory — verifies the underlying sandbox is still reachable, throws
   * if it's gone. Used by orchestrators that crossed an Inngest
   * `step.run` boundary (which can only return JSON-serializable values,
   * not handles).
   */
  resume(state: TState): Promise<SandboxSession<TState>>;

  /**
   * Discover the most-recently-created live session for `taskId`, or
   * null when none is currently alive. Backend-native lookup: Local-
   * Docker queries the `containers` table and inspects the daemon;
   * managed backends query their provider-side API. Useful in the
   * orchestrator's get-or-create-session path after an idle TTL where a
   * prior session may or may not still exist.
   */
  tryResumeByTaskId(taskId: string): Promise<SandboxSession<TState> | null>;

  /** Tear down the session and its underlying sandbox (cascade). Idempotent. */
  delete(session: SandboxSession<TState>): Promise<void>;

  /**
   * Tear down every session whose state was created with the given
   * `taskId`, regardless of whether the orchestrator still holds a
   * handle. Used at task-failure paths and the reaper. Idempotent.
   */
  deleteByTaskId(taskId: string): Promise<void>;

  serializeState(state: TState): Record<string, unknown>;
  deserializeState(payload: Record<string, unknown>): TState;

  /** Release backend-level resources (close docker connections, listeners). */
  shutdown(): Promise<void>;
}

export interface SandboxDeps {
  docker: Docker;
  store: SandboxStore;
}

export type { ProxyOptions, TaskScope } from "./proxy/index.js";
export { CogmoSocketProxy } from "./proxy/index.js";
export { dockerRuntimeName } from "./runtime.js";
export { createSandboxClient, LocalDockerSandboxClient } from "./supervisor.js";
