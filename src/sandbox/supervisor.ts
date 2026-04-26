import { PassThrough, type Readable, type Writable } from "node:stream";
import type Docker from "dockerode";
import { logger } from "../logger.js";
import type {
  ExecHandle,
  ExecOptions,
  InspectResult,
  Sandbox,
  TaskContainerHandle,
  TaskContainerSpec,
} from "./index.js";
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

  private constructor(opts: CreateOptions) {
    this.#docker = opts.docker;
    this.#store = opts.store;
    this.#runtime = opts.runtime;
    this.#instanceId = opts.instanceId;
  }

  static async create(opts: CreateOptions): Promise<LocalInProcessSandbox> {
    await assertRuntimeAvailable(opts.docker, opts.runtime);
    return new LocalInProcessSandbox(opts);
  }

  async healthCheck(): Promise<{ ok: true; runtime: string }> {
    await assertRuntimeAvailable(this.#docker, this.#runtime);
    return { ok: true, runtime: dockerRuntimeName(this.#runtime) };
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
    const runtime = spec.allowPrivilegedRunc ? "runc" : dockerRuntimeName(this.#runtime);
    const labels: ContainerLabels = {
      [LABEL_MANAGED]: "true",
      [LABEL_INSTANCE]: this.#instanceId,
      [LABEL_ROOT_TASK]: spec.rootTaskId,
      [LABEL_PARENT]: "",
      [LABEL_DEPTH]: "0",
    };

    const container = await this.#docker.createContainer({
      Image: spec.image,
      // Hold the container open so we can `exec` claude/codex into it on demand.
      // The CLI runs as a transient exec rather than as PID 1.
      Entrypoint: ["/bin/sleep"],
      Cmd: ["infinity"],
      Tty: false,
      OpenStdin: false,
      WorkingDir: "/workspace",
      Labels: labels,
      HostConfig: {
        Runtime: runtime,
        Binds: [`${spec.worktreePath}:/workspace`],
        Mounts: [
          {
            Type: "volume",
            Source: spec.homeVolumeName,
            Target: "/home/vscode",
          },
        ],
        // Resource caps. NanoCpus uses billionths of a CPU.
        NanoCpus: Math.round(spec.resourceLimits.cpus * 1_000_000_000),
        Memory: spec.resourceLimits.memory_bytes,
        PidsLimit: spec.resourceLimits.pids,
        AutoRemove: false,
      },
    });

    const containerRow = await this.#store.insertContainer({
      dockerId: container.id,
      parentId: null,
      rootTaskId: spec.rootTaskId,
      depth: 0,
      image: spec.image,
      runtime: runtime as "sysbox-runc" | "runc",
      labels,
      resourceLimits: spec.resourceLimits,
      ttlExpiresAt: spec.ttl.expiresAt,
      instanceId: this.#instanceId,
    });

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
    for (const row of ordered) {
      if (row.status === "reaped") continue;
      await this.#killAndRemove(row.dockerId);
      await this.#store.updateContainerStatus({
        id: row.id,
        status: "reaped",
        exitedAt: new Date(),
      });
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
    // dockerode holds no persistent connections — nothing to close. Method
    // exists for symmetry with future remote impls that hold sockets.
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

    const handle: ExecHandle = {
      stdout: stdout as Readable,
      stderr: stderr as Readable,
      wait: () => exitPromise,
    };
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
