import { PassThrough, type Readable, type Writable } from "node:stream";
import type Docker from "dockerode";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { cleanupAskpass } from "./askpass.js";
import { taskSliceName } from "./cgroup-parent.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import type {
  ExecOptions,
  ExecResult,
  ExecStreamingHandle,
  LocalDockerSessionState,
  SandboxCapabilities,
  SandboxClient,
  SandboxSession,
  SessionSpec,
} from "./index.js";
import { ExecTimeoutError, LocalDockerSessionStateSchema } from "./index.js";
import type { CogmoSocketProxy } from "./proxy/index.js";
import { assertRuntimeAvailable, dockerRuntimeName, type SandboxRuntime } from "./runtime.js";
import type { SandboxStore } from "./store/index.js";
import type { ContainerLabels } from "./types.js";

// Dockerode's `Container.create` accepts `Mounts` typed as `MountSettings[]`.
// We need the type alias to construct the spec without pulling in the full
// `Docker` namespace at the value position.
type DockerodeMountSettings = Docker.MountSettings;

const log = logger.child({ component: "sandbox" });

/** Docker label constants — mirror the lineage tracking in `containers` rows. */
export const LABEL_MANAGED = "cogmo.managed";
export const LABEL_INSTANCE = "cogmo.instance";
export const LABEL_ROOT_TASK = "cogmo.root_task";
export const LABEL_PARENT = "cogmo.parent";
export const LABEL_DEPTH = "cogmo.depth";

/** Buffered-exec output cap per stream. Configurable via env later if needed. */
const EXEC_BUFFER_LIMIT_BYTES = 1024 * 1024;

/** Thrown by `dispose()` to settle the exit promise via the stream `'error'` channel. */
class DisposedError extends Error {
  constructor() {
    super("execStreaming dispose called");
    this.name = "DisposedError";
  }
}

interface CreateOptions {
  docker: DockerFacade;
  store: SandboxStore;
  runInTx: Transactor;
  runtime: SandboxRuntime;
  /** The current Cogmo instance id. Stamped into every container's `cogmo.instance` label. */
  instanceId: string;
  /**
   * Optional socket proxy. When provided, every task container gets its own
   * per-task Unix socket bind-mounted at `/var/run/docker.sock`; child
   * container creation from inside the task (testcontainers, `docker
   * compose`, buildx) flows through the proxy so labels + runtime + cgroup
   * parent are injected automatically.
   */
  proxy?: CogmoSocketProxy;
  /**
   * Optional host root for per-task `GIT_ASKPASS` material. When set,
   * `delete` calls `cleanupAskpass({ baseDir, taskId })` in the
   * `try/finally` — even tasks that never provisioned askpass material
   * get a no-op recursive remove on a non-existent directory.
   */
  askpassBaseDir?: string;
}

const CAPABILITIES: SandboxCapabilities = {
  siblingContainers: "host-proxy",
  hostBindMount: true,
  customImage: true,
  volumes: "docker",
  workingTreeTransport: "bind-mount",
};

const HOME_VOLUME_TARGET = "/home/vscode";

/**
 * Local-Docker backend. Spawns task containers as siblings on the host
 * Docker daemon with `HostConfig.Runtime = "sysbox-runc"` by default.
 * Slice-3 features (proxy, cgroup parent, askpass) wired in optionally;
 * the reaper runs as a separate Inngest cron, not on this client.
 */
export class LocalDockerSandboxClient implements SandboxClient<LocalDockerSessionState> {
  readonly backendId = "local-docker";
  readonly capabilities = CAPABILITIES;

  #docker: DockerFacade;
  #store: SandboxStore;
  #runInTx: Transactor;
  #runtime: SandboxRuntime;
  #instanceId: string;
  #proxy?: CogmoSocketProxy;
  #askpassBaseDir?: string;

  private constructor(opts: CreateOptions) {
    this.#docker = opts.docker;
    this.#store = opts.store;
    this.#runInTx = opts.runInTx;
    this.#runtime = opts.runtime;
    this.#instanceId = opts.instanceId;
    if (opts.proxy) this.#proxy = opts.proxy;
    if (opts.askpassBaseDir) this.#askpassBaseDir = opts.askpassBaseDir;
  }

  static async create(opts: CreateOptions): Promise<LocalDockerSandboxClient> {
    await assertRuntimeAvailable(opts.docker, opts.runtime);
    return new LocalDockerSandboxClient(opts);
  }

  async healthCheck(): Promise<{ ok: true; runtime: string }> {
    await assertRuntimeAvailable(this.#docker, this.#runtime);
    return { ok: true, runtime: dockerRuntimeName(this.#runtime) };
  }

  /**
   * Inspect the image; pull if not present locally. The first lookup costs
   * one daemon round-trip; subsequent calls hit the same fast path.
   * Concurrent callers on the same image race harmlessly — the daemon
   * deduplicates pulls.
   */
  async ensureImagePresent(image: string): Promise<void> {
    try {
      await this.#docker.getImage(image).inspect();
      return;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw err;
    }
    log.info({ image }, "image not present locally — pulling");
    const stream = await this.#docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.#docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
    });
    log.info({ image }, "image pull complete");
  }

  async reconcileCrashedInstances(currentInstanceId: string): Promise<{ orphansReaped: number }> {
    if (currentInstanceId !== this.#instanceId) {
      throw new Error(
        `reconcileCrashedInstances called with mismatching instance id: ${currentInstanceId} vs ${this.#instanceId}`,
      );
    }
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
    let reaped = 0;
    for (const c of containers) {
      const stamped = c.Labels?.[LABEL_INSTANCE];
      if (stamped && stamped === currentInstanceId) continue;
      log.warn({ dockerId: c.Id, stampedInstance: stamped }, "reaping orphan container");
      await this.#killAndRemove(c.Id);
      const row = await this.#runInTx((tx) => this.#store.getContainerByDockerId(tx, c.Id));
      if (row) {
        await this.#runInTx((tx) =>
          this.#store.updateContainerStatus(tx, {
            id: row.id,
            status: "reaped",
            exitedAt: new Date(),
          }),
        );
      }
      reaped += 1;
    }
    return { orphansReaped: reaped };
  }

  async create(spec: SessionSpec): Promise<SandboxSession<LocalDockerSessionState>> {
    const runtime: "sysbox-runc" | "runc" = spec.allowPrivilegedRunc
      ? "runc"
      : (dockerRuntimeName(this.#runtime) as "sysbox-runc" | "runc");
    const labels: ContainerLabels = {
      [LABEL_MANAGED]: "true",
      [LABEL_INSTANCE]: this.#instanceId,
      [LABEL_ROOT_TASK]: spec.taskId,
      [LABEL_PARENT]: "",
      [LABEL_DEPTH]: "0",
    };

    // Every container in the task tree gets pinned under a shared systemd
    // slice. Docker creates the slice on demand; the proxy injects the
    // same slice name on every child create so siblings land in the same
    // subtree. Per-leaf limits (NanoCpus / Memory / PidsLimit) cap the
    // task container directly; aggregate-budget enforcement at the slice
    // level is deferred.
    const cgroupParent = taskSliceName(spec.taskId);

    // Pre-allocate the proxy socket so the task container can mount it at
    // `/var/run/docker.sock` from the moment it starts. Parent docker id
    // isn't known yet — register with a placeholder, then upsert below
    // after `createContainer` returns.
    const proxySocketPath = this.#proxy
      ? await this.#proxy.registerTask({
          taskId: spec.taskId,
          parentContainerRowId: "",
          parentDockerId: "",
          parentDepth: 0,
          runtime,
          cgroupParent,
          instanceId: this.#instanceId,
        })
      : null;

    const binds: string[] = [];
    if (spec.worktree) {
      if (spec.worktree.type !== "host-path") {
        // Local-Docker advertises `workingTreeTransport: "bind-mount"`;
        // an orchestrator passing `git-remote` here is a wiring bug.
        throw new Error(
          `LocalDockerSandbox: WorktreeSpec.type "${spec.worktree.type}" is not supported (capabilities advertise "bind-mount")`,
        );
      }
      binds.push(`${spec.worktree.hostPath}:/workspace`);
    }
    if (proxySocketPath) {
      binds.push(`${proxySocketPath}:/var/run/docker.sock`);
    }
    if (spec.askpass) {
      // Read-only — the in-container helper only `cat`s the secret file.
      binds.push(`${spec.askpass.hostDir}:${spec.askpass.containerDir}:ro`);
    }

    // Home volume mounted at /home/vscode — coding-delegation contract:
    // task images run as user `vscode` (devbase inherits this from
    // mcr.microsoft.com/devcontainers/base:ubuntu-24.04). Skills tier-2
    // omits the home volume entirely. When custom devcontainer support
    // grows, the mount target needs to become image-declared.
    const mounts: DockerodeMountSettings[] = spec.homeVolume
      ? [{ Type: "volume", Source: spec.homeVolume.volumeName, Target: HOME_VOLUME_TARGET }]
      : [];

    // Process-level env (e.g. `CLAUDE_CODE_OAUTH_TOKEN` for the Claude Code
    // backend). Lives on the container's process env only — never written to
    // the home volume, never persisted on the container row.
    //
    // INVARIANT: only `spec.env` lands here. Do NOT forward host `process.env`
    // entries into the container — `ANTHROPIC_API_KEY` outranks
    // `CLAUDE_CODE_OAUTH_TOKEN` in Claude Code's auth precedence (see
    // design/coding-delegation.md → Subscription Auth → "Why not
    // ANTHROPIC_API_KEY"), so a forward-everything change would silently
    // bill the user's Console account instead of their Max/Pro subscription.
    const envList = spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined;

    let container: DockerContainer;
    try {
      container = await this.#docker.createContainer({
        Image: spec.image,
        // Hold the container open so we can `exec` claude/codex/python
        // into it on demand. The CLI runs as a transient exec rather
        // than as PID 1.
        Entrypoint: ["/bin/sleep"],
        Cmd: ["infinity"],
        Tty: false,
        OpenStdin: false,
        // WorkingDir defaults to /workspace when a worktree is bound;
        // falls back to the image's own default when omitted.
        ...(spec.worktree && { WorkingDir: "/workspace" }),
        ...(envList && { Env: envList }),
        Labels: labels,
        HostConfig: {
          Runtime: runtime,
          CgroupParent: cgroupParent,
          Binds: binds,
          Mounts: mounts,
          NanoCpus: Math.round(spec.resourceLimits.cpus * 1_000_000_000),
          Memory: spec.resourceLimits.memory_bytes,
          PidsLimit: spec.resourceLimits.pids,
          AutoRemove: false,
        },
      });
    } catch (err) {
      if (this.#proxy) {
        await this.#proxy.unregisterTask(spec.taskId).catch(() => {});
      }
      throw err;
    }

    const containerRow = await this.#runInTx((tx) =>
      this.#store.insertContainer(tx, {
        dockerId: container.id,
        parentId: null,
        rootTaskId: spec.taskId,
        depth: 0,
        image: spec.image,
        runtime,
        labels,
        resourceLimits: spec.resourceLimits,
        ttlExpiresAt: spec.expiresAt,
        instanceId: this.#instanceId,
      }),
    );

    if (this.#proxy) {
      await this.#proxy.registerTask({
        taskId: spec.taskId,
        parentContainerRowId: containerRow.id,
        parentDockerId: container.id,
        parentDepth: 0,
        runtime,
        cgroupParent,
        instanceId: this.#instanceId,
      });
    }

    try {
      await container.start();
      await this.#runInTx((tx) =>
        this.#store.updateContainerStatus(tx, {
          id: containerRow.id,
          status: "running",
          startedAt: new Date(),
        }),
      );
    } catch (err) {
      log.error({ err, dockerId: container.id }, "container start failed, removing");
      await this.#runInTx((tx) =>
        this.#store.updateContainerStatus(tx, {
          id: containerRow.id,
          status: "exited",
          exitedAt: new Date(),
        }),
      ).catch(() => {
        /* best effort */
      });
      await container.remove({ force: true }).catch(() => {
        /* best effort */
      });
      if (this.#proxy) {
        await this.#proxy.unregisterTask(spec.taskId).catch(() => {});
      }
      throw err;
    }

    return this.#wrapSession({
      type: "local-docker",
      taskId: spec.taskId,
      containerRowId: containerRow.id,
      dockerId: container.id,
    });
  }

  async resume(state: LocalDockerSessionState): Promise<SandboxSession<LocalDockerSessionState>> {
    // Verifies the container is still present on the daemon — bare
    // construction would silently produce a session whose exec calls
    // would 404.
    await this.#docker.getContainer(state.dockerId).inspect();
    const row = await this.#runInTx((tx) => this.#store.getContainerByDockerId(tx, state.dockerId));
    if (!row) {
      throw new Error(`resume: no DB row for docker id ${state.dockerId}`);
    }
    return this.#wrapSession(state);
  }

  async tryResumeByTaskId(taskId: string): Promise<SandboxSession<LocalDockerSessionState> | null> {
    const rows = await this.#runInTx((tx) => this.#store.listContainersForTask(tx, taskId));
    if (rows.length === 0) return null;
    // Filter to depth=0 — the contract is "root session", not "any
    // descendant". Children (testcontainers, docker compose siblings)
    // share `rootTaskId` for cascade-reap purposes; a task that
    // spawned them must not resume into one of them.
    // `listContainersForTask` returns DESC depth so iterate filtered.
    for (const row of rows) {
      if (row.depth !== 0) continue;
      // Skip rows the supervisor already marked terminal — the
      // container won't be coming back. `starting` stays in scope
      // because rows are inserted in that state before Docker reports
      // running; a fast follow-up could find it mid-bring-up.
      if (row.status !== "running" && row.status !== "starting") continue;
      try {
        const inspected = await this.#docker.getContainer(row.dockerId).inspect();
        if (inspected.State.Status !== "running") continue;
        return this.#wrapSession({
          type: "local-docker",
          taskId,
          containerRowId: row.id,
          dockerId: row.dockerId,
        });
      } catch (err) {
        // 404 = container gone (reaper got it); skip to the next
        // candidate or fall through to "no live session".
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode !== 404) throw err;
      }
    }
    return null;
  }

  async delete(session: SandboxSession<LocalDockerSessionState>): Promise<void> {
    await this.deleteByTaskId(session.state.taskId);
  }

  async deleteByTaskId(taskId: string): Promise<void> {
    const rows = await this.#runInTx((tx) => this.#store.listContainersForTask(tx, taskId));
    // Cascade order: deepest first, so a parent isn't reaped while a
    // child still depends on it.
    const ordered = [...rows].sort((a, b) => b.depth - a.depth);
    try {
      for (const row of ordered) {
        if (row.status === "reaped") continue;
        await this.#killAndRemove(row.dockerId);
        await this.#runInTx((tx) =>
          this.#store.updateContainerStatus(tx, {
            id: row.id,
            status: "reaped",
            exitedAt: new Date(),
          }),
        );
      }
    } finally {
      // Tear down the per-task proxy socket regardless of whether the
      // cascade reap succeeded — leaving the socket file around (and the
      // listener bound) leaks resources across crashes. Idempotent: safe
      // when no proxy is configured or when the task was never
      // registered.
      if (this.#proxy) {
        await this.#proxy.unregisterTask(taskId).catch((err: unknown) => {
          log.warn({ err, taskId }, "proxy unregisterTask failed during delete");
        });
      }
      // Wipe per-task askpass material. Idempotent — a missing directory
      // is a no-op. Failure is logged inside `cleanupAskpass`; we never
      // throw out of the finally.
      if (this.#askpassBaseDir) {
        cleanupAskpass({ baseDir: this.#askpassBaseDir, rootTaskId: taskId });
      }
    }
  }

  serializeState(state: LocalDockerSessionState): Record<string, unknown> {
    return LocalDockerSessionStateSchema.parse(state);
  }

  deserializeState(payload: Record<string, unknown>): LocalDockerSessionState {
    return LocalDockerSessionStateSchema.parse(payload);
  }

  async shutdown(): Promise<void> {
    // dockerode holds no persistent connections. The proxy holds Unix
    // socket listeners — close so the socket files unlink and orphan
    // sockets don't pile up across Cogmo restarts.
    if (this.#proxy) {
      await this.#proxy.close().catch((err: unknown) => {
        log.warn({ err }, "proxy close failed during shutdown");
      });
    }
  }

  #wrapSession(state: LocalDockerSessionState): SandboxSession<LocalDockerSessionState> {
    const docker = this.#docker;
    return {
      state,
      exec: (cmd, opts) => execBuffered(docker, state.dockerId, cmd, opts),
      execStreaming: (cmd, opts) => execStreaming(docker, state.dockerId, cmd, opts),
    };
  }

  async #killAndRemove(dockerId: string): Promise<void> {
    const c = this.#docker.getContainer(dockerId);
    try {
      await c.kill({ signal: "SIGTERM" });
    } catch (err) {
      const e = err as { statusCode?: number };
      // 304 = already stopped, 404 = already gone — both fine
      if (e.statusCode !== 304 && e.statusCode !== 404) throw err;
    }
    try {
      await c.remove({ force: true });
    } catch (err) {
      const e = err as { statusCode?: number };
      if (e.statusCode !== 404) throw err;
    }
  }
}

/**
 * Run a command and buffer the output. Caps stdout / stderr at
 * `EXEC_BUFFER_LIMIT_BYTES` per stream; consumers expecting more use
 * `execStreaming` instead.
 */
async function execBuffered(
  docker: DockerFacade,
  dockerId: string,
  cmd: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const start = Date.now();
  const handle = await execStreaming(docker, dockerId, cmd, opts);
  const stdoutBuf = new BoundedBuffer(EXEC_BUFFER_LIMIT_BYTES);
  const stderrBuf = new BoundedBuffer(EXEC_BUFFER_LIMIT_BYTES);
  handle.stdout.on("data", (chunk: Buffer) => stdoutBuf.push(chunk));
  handle.stderr.on("data", (chunk: Buffer) => stderrBuf.push(chunk));
  const { exitCode } = await handle.wait();
  const truncated = stdoutBuf.truncated || stderrBuf.truncated;
  return {
    stdout: stdoutBuf.toString(),
    stderr: stderrBuf.toString(),
    exitCode,
    wallTimeSeconds: (Date.now() - start) / 1000,
    truncated,
  };
}

/**
 * Byte-cap buffer for buffered exec output. The cap is applied at the
 * byte level, so a chunk that ends mid-character is truncated at the
 * byte boundary — `toString("utf8")` then renders the trailing partial
 * sequence as a U+FFFD replacement character. The output is already
 * marked `truncated` by that point and the user-visible signal is the
 * marker, not the exact tail bytes; cleaning the boundary would mean
 * walking back the cut to the previous valid UTF-8 lead byte. Not
 * worth the complexity for a debug-shape buffer.
 */
class BoundedBuffer {
  #chunks: Buffer[] = [];
  #size = 0;
  #limit: number;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.#size >= this.#limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.#limit - this.#size;
    if (chunk.length <= remaining) {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
      return;
    }
    this.#chunks.push(chunk.subarray(0, remaining));
    this.#size = this.#limit;
    this.truncated = true;
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

async function execStreaming(
  docker: DockerFacade,
  dockerId: string,
  cmd: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecStreamingHandle> {
  const container = docker.getContainer(dockerId);
  const env = opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined;
  const exec = await container.exec({
    Cmd: [...cmd],
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: opts.attachStdin === true,
    Tty: false,
    WorkingDir: opts.workingDir,
    User: opts.user,
    Env: env,
  });
  const stream = await exec.start({
    hijack: true,
    stdin: opts.attachStdin === true,
  });

  // Per-call timeout state — same shape as the Daytona backend. The
  // total timer caps wall-clock from now; the idle timer resets on
  // every demuxed chunk (we tap stdout/stderr below). Whichever fires
  // first stores its sentinel in `timedOut` and forces the hijacked
  // socket closed via `DisposedError` — the stream's `'error'` handler
  // then sees `timedOut` set and rejects `exitPromise` with the
  // timeout error rather than the underlying `DisposedError`. See
  // design/sandbox.md → Wall-clock and idle timeouts.
  let timedOut: ExecTimeoutError | null = null;
  let totalTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  const clearTimers = (): void => {
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const fireTimeout = (kind: "total" | "idle", limit: number): void => {
    if (timedOut) return;
    timedOut = new ExecTimeoutError(kind, limit);
    // Closing the hijacked stream is the same teardown `dispose()` runs.
    // The stream's `'error'` handler picks up `timedOut` and rejects
    // with the timeout sentinel.
    stream.destroy(new DisposedError());
  };
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.idleTimeoutMs !== undefined && !timedOut) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        fireTimeout("idle", opts.idleTimeoutMs ?? 0);
      }, opts.idleTimeoutMs);
    }
  };

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Tap chunks before demux so the watchdog counts both channels.
  // PassThroughs sink the bytes; the listener is observation-only.
  stdout.on("data", resetIdle);
  stderr.on("data", resetIdle);
  docker.modem.demuxStream(stream, stdout, stderr);

  if (opts.timeoutMs !== undefined) {
    totalTimer = setTimeout(() => {
      totalTimer = null;
      fireTimeout("total", opts.timeoutMs ?? 0);
    }, opts.timeoutMs);
  }
  resetIdle();

  // Capture the exit eagerly — listeners attached after `'end'` already
  // fired wouldn't trigger, which deadlocks any caller that reads stdout
  // before calling wait().
  const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    stream.on("end", async () => {
      clearTimers();
      stdout.end();
      stderr.end();
      if (timedOut) {
        // Timer-fire raced the natural exit — the cap is the
        // operative outcome from the caller's perspective.
        reject(timedOut);
        return;
      }
      try {
        const info = await exec.inspect();
        resolve({ exitCode: info.ExitCode ?? 0 });
      } catch (err) {
        reject(err as Error);
      }
    });
    stream.on("error", (err: Error) => {
      clearTimers();
      if (timedOut) {
        // Timer fired and we tore down the socket; surface the
        // timeout, not the resulting `DisposedError`.
        stdout.end();
        stderr.end();
        reject(timedOut);
        return;
      }
      if (err instanceof DisposedError) {
        // Intentional teardown via `dispose()` — close downstream
        // streams peacefully so consumers see EOF, not an error. The
        // upstream socket is already gone by the time we get here.
        stdout.end();
        stderr.end();
      } else {
        // Real upstream error — forward so consumers reading the
        // demuxed PassThroughs see the same failure.
        stdout.destroy(err);
        stderr.destroy(err);
      }
      reject(err);
    });
  });
  // Suppress Node's unhandled-rejection process crash if the caller
  // never awaits wait() (e.g. exec started but caller bailed before
  // processing events). The error stays observable through wait() and
  // through the destroyed stdout/stderr streams.
  exitPromise.catch(() => {});

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    clearTimers();
    // Closing the hijacked stream causes the daemon to reap the exec
    // process. Docker's exec API doesn't expose a direct kill, but
    // socket close is the documented teardown path. Pass an error so
    // the stream's `'error'` handler fires and `exitPromise` settles —
    // a bare `destroy()` would emit only `'close'`, leaving the promise
    // pending and `dispose()` awaiting forever.
    stream.destroy(new DisposedError());
    // Wait for the exit channel to settle (success or error) — keeps
    // disposers idempotent and prevents callers seeing pending Promises.
    await exitPromise.catch(() => {
      /* errors during dispose are expected — caller already gave up */
    });
  };

  const handle: ExecStreamingHandle = {
    stdout: stdout as Readable,
    stderr: stderr as Readable,
    wait: () => exitPromise,
    dispose,
  };
  // dockerode's hijacked exec stream is bidirectional and structurally a
  // Writable, but @types/dockerode types it as a generic Duplex.
  if (opts.attachStdin === true) handle.stdin = stream as unknown as Writable;
  return handle;
}

/**
 * Factory shorthand. Same shape as the other module factories
 * (`startTelegramAdapter`, `createSecretsStore`, etc.).
 */
export const createSandboxClient: typeof LocalDockerSandboxClient.create =
  LocalDockerSandboxClient.create;
