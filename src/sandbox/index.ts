import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { DockerFacade } from "./docker-facade.js";
import type { SandboxStore } from "./store/index.js";
import type { ResourceLimits } from "./types.js";

export type { SandboxRuntime } from "./runtime.js";
export type { ContainerRow, ContainerRuntime, ContainerStatus } from "./store/index.js";
export type { ContainerLabels, ResourceLimits } from "./types.js";

/**
 * Working-tree material to materialize at session start. Discriminated
 * by transport — consumers pick the variant based on
 * `SandboxClient.capabilities.workingTreeTransport`. `host-path` carries
 * a host filesystem path the backend bind-mounts at `/workspace`;
 * `git-remote` carries a clone URL + branch + auth the backend clones
 * inside the sandbox.
 */
export type WorktreeSpec = HostPathWorktreeSpec | GitRemoteWorktreeSpec;

export interface HostPathWorktreeSpec {
  type: "host-path";
  /** Host path bind-mounted at `/workspace`. */
  hostPath: string;
}

export interface GitRemoteWorktreeSpec {
  type: "git-remote";
  /** HTTPS clone URL — the GitHub remote the bot account's PAT can authenticate against. */
  url: string;
  /** Source branch to clone. Typically the orchestrator's just-pushed `cogmo/run/<task-id>`. */
  branch: string;
  /** HTTPS basic-auth credentials. Username is `x-access-token` for GitHub PATs. */
  auth: { username: string; password: string };
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
  /**
   * Process-level env injected at container create time. Used today by
   * coding-delegation to pass `CLAUDE_CODE_OAUTH_TOKEN` (sourced from the
   * encrypted secrets table) into the Claude Code subprocess — see
   * design/coding-delegation.md → Subscription Auth. Values land in the
   * container's process env only; nothing is written to the home volume.
   */
  env?: Readonly<Record<string, string>>;
}

export interface ExecOptions {
  workingDir?: string;
  user?: string;
  env?: Readonly<Record<string, string>>;
  /** When true, `stdin` is exposed on the returned streaming handle. */
  attachStdin?: boolean;
  /**
   * Total wall-clock cap. If `wait()` hasn't settled by `timeoutMs` after the
   * exec started, the backend runs the same teardown `dispose()` would (close
   * hijacked socket / `deleteSession`) and rejects `wait()` with
   * `ExecTimeoutError`. Omitted = no cap. See design/sandbox.md →
   * Wall-clock and idle timeouts.
   */
  timeoutMs?: number;
  /**
   * No-byte-flow watchdog. Resets on every stdout/stderr chunk; if it fires
   * before the next chunk or natural exit, same cleanup + `ExecTimeoutError`
   * path as `timeoutMs`. Catches "WS holds open but sends nothing" — the
   * failure mode `timeoutMs` alone misses when the underlying transport
   * doesn't propagate close on a remote stall. Omitted = no idle cap.
   */
  idleTimeoutMs?: number;
}

/**
 * Thrown by `wait()` when `ExecOptions.timeoutMs` or
 * `ExecOptions.idleTimeoutMs` fires. Distinct sentinel from `DisposedError`
 * so consumers branching on exit outcome can separate "we hit the cap" from
 * "we explicitly cancelled."
 *
 * `kind` carries which cap fired; `timeoutMs` is the configured limit.
 * Backends are expected to throw this exact shape — Local-Docker and Daytona
 * import from here rather than defining their own.
 */
export class ExecTimeoutError extends Error {
  readonly kind: "total" | "idle";
  readonly timeoutMs: number;
  constructor(kind: "total" | "idle", timeoutMs: number) {
    super(
      kind === "total"
        ? `exec exceeded wall-clock timeout ${timeoutMs}ms`
        : `exec exceeded idle timeout ${timeoutMs}ms with no stdout/stderr activity`,
    );
    this.name = "ExecTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
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
 * backend reports the process finished.
 *
 * `dispose()` aborts the exec by tearing down the backend's transport
 * (Docker exec API has no direct kill — closing the hijacked socket
 * lets the daemon reap the process). It does NOT send signals; backends
 * that grow signal support (e.g. a future Daytona impl with a kill
 * endpoint) may upgrade the implementation but not the contract.
 * Idempotent. After `dispose()` the streams emit EOF (no error on
 * `stdout`/`stderr`) and `wait()` rejects with `DisposedError` —
 * callers that race dispose against natural exit must check for that.
 *
 * The caller is responsible for either consuming `stdout`/`stderr` to
 * EOF or calling `dispose()`; otherwise the backend may hold the
 * connection open.
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
 */
export const LocalDockerSessionStateSchema = z.object({
  type: z.literal("local-docker"),
  taskId: z.string().min(1),
  containerRowId: z.string().min(1),
  dockerId: z.string().min(1),
});
export type LocalDockerSessionState = z.infer<typeof LocalDockerSessionStateSchema>;

export const DaytonaSessionStateSchema = z.object({
  type: z.literal("daytona"),
  taskId: z.string().min(1),
  /** Daytona's primary key for the sandbox. Stable across stop/start cycles. */
  sandboxId: z.string().min(1),
});
export type DaytonaSessionState = z.infer<typeof DaytonaSessionStateSchema>;

/** All backends' state variants — discriminated union by `type`. */
export const SandboxSessionStateSchema = z.discriminatedUnion("type", [
  LocalDockerSessionStateSchema,
  DaytonaSessionStateSchema,
]);
export type SandboxSessionState = z.infer<typeof SandboxSessionStateSchema>;

/**
 * Narrow a session state to its local-docker variant. Backend-aware
 * orchestrator paths (e.g. `setTaskContainerId`, which writes a FK into
 * the local-docker `containers` table) gate on this so they no-op on
 * managed backends without persisting a non-existent FK target.
 */
export function isLocalDockerSessionState(
  state: SandboxSessionState,
): state is LocalDockerSessionState {
  return state.type === "local-docker";
}

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
   * Verify `image` is reachable. Idempotent. `resourceLimits` bakes
   * into the Daytona snapshot at warm time — the snapshot-path
   * `create()` has no per-session override. Ignored by Local-Docker;
   * omit to accept the provider's default.
   */
  ensureImagePresent(image: string, resourceLimits?: ResourceLimits): Promise<void>;

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
   * Discover the live root session (the depth-0 container the
   * orchestrator originally created) for `taskId`, or null when none
   * is currently alive. Backend-native lookup: Local-Docker queries
   * the `containers` table for `depth=0` and inspects the daemon;
   * managed backends query their provider-side API. Used in the
   * orchestrator's get-or-create-session path after an idle TTL where
   * a prior session may or may not still exist. Child containers
   * spawned by the task (testcontainers etc.) are deliberately
   * ignored — the orchestrator wants the root, not whatever the task
   * spawned underneath it.
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

  /**
   * Encode `state` as a JSONB-shaped object that round-trips through
   * Postgres + Inngest's step.run boundary. Output must satisfy
   * `Record<string, unknown>` because Inngest serialises return values
   * via `JSON.stringify` and the result lands in JSONB columns
   * (see `coding_tasks.sandbox_session_state`-style fields).
   */
  serializeState(state: TState): Record<string, unknown>;
  /** Inverse of `serializeState`. Validates payload shape; throws on mismatch. */
  deserializeState(payload: Record<string, unknown>): TState;

  /** Release backend-level resources (close docker connections, listeners). */
  shutdown(): Promise<void>;
}

export interface SandboxDeps {
  docker: DockerFacade;
  store: SandboxStore;
}

export type { ProxyOptions, TaskScope } from "./proxy/index.js";
export { CogmoSocketProxy } from "./proxy/index.js";
export { dockerRuntimeName } from "./runtime.js";
export { createSandboxClient, LocalDockerSandboxClient } from "./supervisor.js";
