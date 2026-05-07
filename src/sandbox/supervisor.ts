import { PassThrough, type Readable, type Writable } from "node:stream";
import type Docker from "dockerode";
import { logger } from "../logger.js";
import { cleanupAskpass } from "./askpass.js";
import { taskSliceName } from "./cgroup-parent.js";
import type {
  ExecHandle,
  ExecOptions,
  InspectResult,
  Sandbox,
  TaskContainerHandle,
  TaskContainerSpec,
} from "./index.js";
import type { CogmoSocketProxy } from "./proxy/index.js";
import { assertRuntimeAvailable, dockerRuntimeName, type SandboxRuntime } from "./runtime.js";
import type { ContainerRow, SandboxStore } from "./store/index.js";
import type { ContainerLabels } from "./types.js";

const log = logger.child({ component: "sandbox" });

/** Docker label constants — mirror the lineage tracking in `containers` rows. */
export const LABEL_MANAGED = "cogmo.managed";
export const LABEL_INSTANCE = "cogmo.instance";
export const LABEL_ROOT_TASK = "cogmo.root_task";
export const LABEL_PARENT = "cogmo.parent";
export const LABEL_DEPTH = "cogmo.depth";

interface CreateOptions {
  docker: Docker;
  store: SandboxStore;
  runtime: SandboxRuntime;
  /** The current Cogmo instance id. Stamped into every container's `cogmo.instance` label. */
  instanceId: string;
  /**
   * Optional socket proxy. When provided, every task container gets its own
   * per-task Unix socket bind-mounted at `/var/run/docker.sock`; child
   * container creation from inside the task (testcontainers, `docker
   * compose`, buildx) flows through the proxy so labels + runtime + cgroup
   * parent are injected automatically. When omitted, no socket is mounted
   * and child container creation from inside the task fails (intentional —
   * slice 1's plan-only path doesn't spawn children).
   */
  proxy?: CogmoSocketProxy;
  /**
   * Optional host root for per-task `GIT_ASKPASS` material. When set,
   * `stopTask` calls `cleanupAskpass({ baseDir, rootTaskId })` in the
   * `try/finally` — even tasks that never provisioned askpass material
   * (e.g. plan-only tasks) get a no-op recursive remove on a non-existent
   * directory, which is harmless. Provisioning itself happens in the
   * orchestrator before `createTaskContainer`.
   */
  askpassBaseDir?: string;
}

/**
 * P1 sandbox: proxy and reaper deferred to slices 3+. This impl only wires
 * `createTaskContainer` (sibling-against-host-daemon, sysbox by default,
 * labelled, bind-mounted) and `stopTask` (cascade kill+remove). Crash
 * recovery is opt-in (call `reconcileCrashedInstances(currentInstanceId)`
 * at boot — kills containers labelled with a different `cogmo.instance`).
 */
export class LocalInProcessSandbox implements Sandbox {
  #docker: Docker;
  #store: SandboxStore;
  #runtime: SandboxRuntime;
  #instanceId: string;
  #proxy?: CogmoSocketProxy;
  #askpassBaseDir?: string;

  private constructor(opts: CreateOptions) {
    this.#docker = opts.docker;
    this.#store = opts.store;
    this.#runtime = opts.runtime;
    this.#instanceId = opts.instanceId;
    if (opts.proxy) this.#proxy = opts.proxy;
    if (opts.askpassBaseDir) this.#askpassBaseDir = opts.askpassBaseDir;
  }

  static async create(opts: CreateOptions): Promise<LocalInProcessSandbox> {
    await assertRuntimeAvailable(opts.docker, opts.runtime);
    return new LocalInProcessSandbox(opts);
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
      // Treat "not found" as the only condition we recover from. Anything
      // else (daemon unreachable, permission denied) should propagate so the
      // caller fails fast instead of waiting on a pull that won't succeed.
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
      const row = await this.#store.getContainerByDockerId(c.Id);
      if (row) {
        await this.#store.updateContainerStatus({
          id: row.id,
          status: "reaped",
          exitedAt: new Date(),
        });
      }
      reaped += 1;
    }
    return { orphansReaped: reaped };
  }

  async createTaskContainer(spec: TaskContainerSpec): Promise<TaskContainerHandle> {
    const runtime: "sysbox-runc" | "runc" = spec.allowPrivilegedRunc
      ? "runc"
      : (dockerRuntimeName(this.#runtime) as "sysbox-runc" | "runc");
    const labels: ContainerLabels = {
      [LABEL_MANAGED]: "true",
      [LABEL_INSTANCE]: this.#instanceId,
      [LABEL_ROOT_TASK]: spec.rootTaskId,
      [LABEL_PARENT]: "",
      [LABEL_DEPTH]: "0",
    };

    // Slice 3.0h: every container in the task tree gets pinned under a
    // shared systemd slice. Docker creates the slice on demand when the
    // first container references it; the proxy injects the same slice
    // name on every child create so siblings land in the same subtree.
    // Per-leaf limits (NanoCpus / Memory / PidsLimit) cap the task
    // container directly; aggregate-budget enforcement at the slice
    // level is deferred — see `cgroup-parent.ts` for rationale.
    const cgroupParent = taskSliceName(spec.rootTaskId);

    // Pre-allocate the proxy socket so the task container can mount it at
    // `/var/run/docker.sock` from the moment it starts. Parent docker id
    // isn't known yet — register with a placeholder, then upsert below
    // after `createContainer` returns. Bare scope is enough for any
    // pre-start child create requests (there shouldn't be any, but the
    // proxy is up regardless).
    const proxySocketPath = this.#proxy
      ? await this.#proxy.registerTask({
          taskId: spec.rootTaskId,
          parentContainerRowId: "",
          parentDockerId: "",
          parentDepth: 0,
          runtime,
          cgroupParent,
          instanceId: this.#instanceId,
        })
      : null;

    const binds: string[] = [];
    if (spec.worktreePath) {
      binds.push(`${spec.worktreePath}:/workspace`);
    }
    if (proxySocketPath) {
      binds.push(`${proxySocketPath}:/var/run/docker.sock`);
    }
    if (spec.askpassMount) {
      // Read-only — the in-container helper only `cat`s the secret file;
      // no process inside the container has any reason to write here, and
      // the supervisor regenerates the directory on retry rather than
      // expecting in-container edits to persist.
      binds.push(`${spec.askpassMount.hostDir}:${spec.askpassMount.containerDir}:ro`);
    }

    // Home volume mounted at /home/vscode — coding-delegation contract: task
    // images run as user `vscode` (devbase inherits this from
    // mcr.microsoft.com/devcontainers/base:ubuntu-24.04). Skills tier-2 omits
    // the home volume entirely because the `recycle` isolation contract
    // forbids any state surviving the task. When slice 4 grows custom
    // devcontainer support, the mount target needs to become image-declared.
    const mounts: Docker.MountSettings[] = spec.homeVolumeName
      ? [{ Type: "volume", Source: spec.homeVolumeName, Target: "/home/vscode" }]
      : [];

    let container: Docker.Container;
    try {
      container = await this.#docker.createContainer({
        Image: spec.image,
        // Hold the container open so we can `exec` claude/codex/python into
        // it on demand. The CLI runs as a transient exec rather than as PID 1.
        Entrypoint: ["/bin/sleep"],
        Cmd: ["infinity"],
        Tty: false,
        OpenStdin: false,
        // WorkingDir defaults to /workspace when a worktree is bound; falls
        // back to the image's own default when omitted (skills tier-2 lands
        // here — the runner's stdin/stdout protocol doesn't depend on cwd).
        ...(spec.worktreePath && { WorkingDir: "/workspace" }),
        Labels: labels,
        HostConfig: {
          Runtime: runtime,
          CgroupParent: cgroupParent,
          Binds: binds,
          Mounts: mounts,
          // Resource caps. NanoCpus uses billionths of a CPU.
          NanoCpus: Math.round(spec.resourceLimits.cpus * 1_000_000_000),
          Memory: spec.resourceLimits.memory_bytes,
          PidsLimit: spec.resourceLimits.pids,
          AutoRemove: false,
        },
      });
    } catch (err) {
      // Roll the proxy socket back so a failed retry doesn't see a dangling
      // registration. unregisterTask is idempotent.
      if (this.#proxy) {
        await this.#proxy.unregisterTask(spec.rootTaskId).catch(() => {});
      }
      throw err;
    }

    const containerRow = await this.#store.insertContainer({
      dockerId: container.id,
      parentId: null,
      rootTaskId: spec.rootTaskId,
      depth: 0,
      image: spec.image,
      runtime,
      labels,
      resourceLimits: spec.resourceLimits,
      ttlExpiresAt: spec.ttl.expiresAt,
      instanceId: this.#instanceId,
    });

    // Now that the parent docker id is known, upsert the proxy scope so
    // child container creates from inside the task get the right
    // `cogmo.parent` label injected.
    if (this.#proxy) {
      await this.#proxy.registerTask({
        taskId: spec.rootTaskId,
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
      await this.#store.updateContainerStatus({
        id: containerRow.id,
        status: "running",
        startedAt: new Date(),
      });
    } catch (err) {
      // Roll back DB state if start fails — the row is gone but the unstarted
      // container should be removed too so we don't leak.
      log.error({ err, dockerId: container.id }, "container start failed, removing");
      await this.#store
        .updateContainerStatus({ id: containerRow.id, status: "exited", exitedAt: new Date() })
        .catch(() => {
          /* best effort */
        });
      await container.remove({ force: true }).catch(() => {
        /* best effort */
      });
      if (this.#proxy) {
        await this.#proxy.unregisterTask(spec.rootTaskId).catch(() => {});
      }
      throw err;
    }

    return {
      containerRowId: containerRow.id,
      dockerId: container.id,
      exec: (cmd, opts) => this.#exec(container.id, cmd, opts),
    };
  }

  async getTaskContainer(dockerId: string): Promise<TaskContainerHandle> {
    // Verifies the container is still present on the daemon — bare construction
    // would silently produce a handle whose exec calls would 404.
    await this.#docker.getContainer(dockerId).inspect();
    const row = await this.#store.getContainerByDockerId(dockerId);
    if (!row) throw new Error(`getTaskContainer: no DB row for docker id ${dockerId}`);
    return {
      containerRowId: row.id,
      dockerId,
      exec: (cmd, opts) => this.#exec(dockerId, cmd, opts),
    };
  }

  async stopTask(rootTaskId: string): Promise<void> {
    const rows = await this.#store.listContainersForTask(rootTaskId);
    // Cascade order: deepest first, so a parent isn't reaped while a child still depends on it.
    const ordered = [...rows].sort((a, b) => b.depth - a.depth);
    try {
      for (const row of ordered) {
        if (row.status === "reaped") continue;
        await this.#killAndRemove(row.dockerId);
        await this.#store.updateContainerStatus({
          id: row.id,
          status: "reaped",
          exitedAt: new Date(),
        });
      }
    } finally {
      // Tear down the per-task proxy socket regardless of whether the
      // cascade reap succeeded — leaving the socket file around (and the
      // listener bound) leaks resources across crashes. Idempotent: safe
      // when no proxy is configured or when the task was never registered.
      if (this.#proxy) {
        await this.#proxy.unregisterTask(rootTaskId).catch((err: unknown) => {
          log.warn({ err, taskId: rootTaskId }, "proxy unregisterTask failed during stopTask");
        });
      }
      // Wipe per-task askpass material. Idempotent — a missing directory
      // (no provisioning happened, or already cleaned up by a previous
      // stopTask call on retry) is a no-op. Failure is logged inside
      // `cleanupAskpass`; we never throw out of the finally.
      if (this.#askpassBaseDir) {
        cleanupAskpass({ baseDir: this.#askpassBaseDir, rootTaskId });
      }
    }
  }

  async listContainersForTask(rootTaskId: string): Promise<readonly ContainerRow[]> {
    return this.#store.listContainersForTask(rootTaskId);
  }

  async inspectContainer(dockerId: string): Promise<InspectResult> {
    const inspected = await this.#docker.getContainer(dockerId).inspect();
    return {
      status: inspected.State.Status,
      runtime: inspected.HostConfig.Runtime ?? "runc",
    };
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

  async #exec(
    dockerId: string,
    cmd: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecHandle> {
    const container = this.#docker.getContainer(dockerId);
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

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.#docker.modem.demuxStream(stream, stdout, stderr);

    // Capture the exit eagerly — listeners attached after `'end'` already
    // fired wouldn't trigger, which deadlocks any caller that reads stdout
    // before calling wait().
    const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
      stream.on("end", async () => {
        stdout.end();
        stderr.end();
        try {
          const info = await exec.inspect();
          resolve({ exitCode: info.ExitCode ?? 0 });
        } catch (err) {
          reject(err as Error);
        }
      });
      stream.on("error", (err: Error) => {
        stdout.destroy(err);
        stderr.destroy(err);
        reject(err);
      });
    });
    // Suppress Node's unhandled-rejection process crash if the caller never
    // awaits wait() (e.g. exec started but caller bailed before processing
    // events). The error stays observable through wait() and through the
    // destroyed stdout/stderr streams.
    exitPromise.catch(() => {});

    const handle: ExecHandle = {
      stdout: stdout as Readable,
      stderr: stderr as Readable,
      wait: () => exitPromise,
    };
    // dockerode's hijacked exec stream is bidirectional and structurally a
    // Writable, but @types/dockerode types it as a generic Duplex.
    if (opts.attachStdin === true) handle.stdin = stream as unknown as Writable;
    return handle;
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
 * Factory shorthand. Same shape as the other module factories
 * (`startTelegramAdapter`, `createSecretsStore`, etc.).
 */
export const createSandbox: typeof LocalInProcessSandbox.create = LocalInProcessSandbox.create;
