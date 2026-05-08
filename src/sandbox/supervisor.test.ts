/**
 * Supervisor unit tests — focused on the proxy wiring (slice 3.0f). The
 * full Docker-side behavior is covered by `supervisor.integration.test.ts`
 * and `supervisor.sysbox.integration.test.ts`; this file uses stub Docker +
 * stub proxy to verify the supervisor calls the proxy in the right order
 * and bind-mounts the returned socket path.
 */
import type Docker from "dockerode";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { LocalDockerSandboxClient } from "./index.js";
import type { CogmoSocketProxy } from "./proxy/index.js";
import type { TaskScope } from "./proxy/types.js";
import { DrizzleSandboxStore } from "./store/index.js";
import type { ResourceLimits } from "./types.js";

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 0.5,
  memory_bytes: 256 * 1024 * 1024,
  pids: 64,
};

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSandboxStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSandboxStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

interface DockerCreateCallArgs {
  Image: string;
  HostConfig?: {
    Binds?: string[];
    Runtime?: string;
    CgroupParent?: string;
  };
}

/**
 * Minimal dockerode stub — enough to drive createTaskContainer. The shape
 * is far smaller than the real `Docker` type; the cast is centralised here
 * so call sites can pass `docker` without a per-call `as any`.
 */
function fakeDocker(opts: { dockerId: string; failStart?: boolean } = { dockerId: "docker-abc" }): {
  docker: Docker;
  calls: { create: DockerCreateCallArgs[]; start: number; remove: number };
} {
  const calls: { create: DockerCreateCallArgs[]; start: number; remove: number } = {
    create: [],
    start: 0,
    remove: 0,
  };
  const start = vi.fn(async () => {
    calls.start += 1;
    if (opts.failStart) throw new Error("boom");
  });
  const remove = vi.fn(async () => {
    calls.remove += 1;
  });
  const inspect = vi.fn(async () => ({ State: { Status: "running" }, HostConfig: {} }));
  const docker = {
    createContainer: vi.fn(async (spec: DockerCreateCallArgs) => {
      calls.create.push(spec);
      return { id: opts.dockerId, start, remove, inspect };
    }),
    listContainers: vi.fn(async () => []),
    getContainer: () => ({ inspect, kill: vi.fn(), remove }),
    // Default `info` returns just runc; tests that need a different runtime
    // map call `docker.info.mockResolvedValueOnce(...)` to override.
    info: vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } })),
    // The real dockerode `Docker` exposes ~50 methods; this stub covers the
    // few `createTaskContainer` reaches for. `as unknown as Docker` is the
    // single boundary cast — call sites stay typed.
  } as unknown as Docker;
  return { docker, calls };
}

/** Stub proxy that records register/unregister calls. */
function fakeProxy(): {
  proxy: CogmoSocketProxy;
  registers: TaskScope[];
  unregisters: string[];
  socketDirAt: (taskId: string) => string;
} {
  const registers: TaskScope[] = [];
  const unregisters: string[] = [];
  const proxy = {
    registerTask: vi.fn(async (scope: TaskScope) => {
      registers.push(scope);
      return `/run/cogmo/sockets/${scope.taskId}.sock`;
    }),
    unregisterTask: vi.fn(async (taskId: string) => {
      unregisters.push(taskId);
    }),
    close: vi.fn(async () => {}),
  } as unknown as CogmoSocketProxy;
  return {
    proxy,
    registers,
    unregisters,
    socketDirAt: (taskId) => `/run/cogmo/sockets/${taskId}.sock`,
  };
}

describe("LocalDockerSandboxClient — proxy wiring", () => {
  it("registers the proxy with placeholder, then upserts the parent docker id", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker, calls } = fakeDocker({ dockerId: "docker-task-xyz" });
    const { proxy, registers } = fakeProxy();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    const taskId = "019d0000-0000-7000-8000-000000000aaa";
    const handle = await sandbox.create({
      taskId,
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-1" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(handle.state.dockerId).toBe("docker-task-xyz");

    // Two register calls: pre-create placeholder, post-create upsert.
    expect(registers).toHaveLength(2);
    const reg0 = expectDefined(registers[0], "first register");
    const reg1 = expectDefined(registers[1], "second register");
    expect(reg0.parentDockerId).toBe("");
    expect(reg0.parentContainerRowId).toBe("");
    expect(reg0.runtime).toBe("runc");
    expect(reg1.parentDockerId).toBe("docker-task-xyz");
    expect(reg1.parentContainerRowId).toBeTruthy();

    // Cgroup parent (slice 3.0h): both registers carry the same slice
    // name; the proxy uses it to inject CgroupParent on every child
    // create so siblings land in the same subtree.
    const expectedSlice = "cogmo-task-019d0000000070008000000000000aaa.slice";
    expect(reg0.cgroupParent).toBe(expectedSlice);
    expect(reg1.cgroupParent).toBe(expectedSlice);

    // Container created with the proxy socket bind-mounted at /var/run/docker.sock.
    expect(calls.create).toHaveLength(1);
    const create0 = expectDefined(calls.create[0], "first create call");
    const binds = create0.HostConfig?.Binds ?? [];
    expect(binds).toContain("/tmp/wt:/workspace");
    expect(binds).toContain(
      "/run/cogmo/sockets/019d0000-0000-7000-8000-000000000aaa.sock:/var/run/docker.sock",
    );
    // Task container itself pinned to the slice — Docker creates the
    // slice on demand and aborts here if systemd refuses (e.g. on a
    // non-systemd host).
    expect(create0.HostConfig?.CgroupParent).toBe(expectedSlice);
  });

  it("unregisters the proxy on stopTask", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = fakeDocker({ dockerId: "docker-x" });
    const { proxy, unregisters } = fakeProxy();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-000000000bbb",
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-2" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await sandbox.deleteByTaskId("019d0000-0000-7000-8000-000000000bbb");
    expect(unregisters).toEqual(["019d0000-0000-7000-8000-000000000bbb"]);
  });

  it("rolls back the proxy registration when Docker createContainer fails", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = fakeDocker();
    docker.createContainer = vi.fn(async () => {
      throw new Error("daemon refused");
    });
    const { proxy, registers, unregisters } = fakeProxy();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    await expect(
      sandbox.create({
        taskId: "019d0000-0000-7000-8000-000000000ccc",
        worktree: { hostPath: "/tmp/wt" },
        homeVolume: { volumeName: "vol-3" },
        image: "alpine",
        resourceLimits: RESOURCE_LIMITS,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("daemon refused");

    expect(registers).toHaveLength(1); // only the placeholder
    expect(unregisters).toEqual(["019d0000-0000-7000-8000-000000000ccc"]);
  });

  it("rolls back the proxy registration when container.start fails", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = fakeDocker({ dockerId: "docker-fail-start", failStart: true });
    const { proxy, registers, unregisters } = fakeProxy();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    await expect(
      sandbox.create({
        taskId: "019d0000-0000-7000-8000-000000000ddd",
        worktree: { hostPath: "/tmp/wt" },
        homeVolume: { volumeName: "vol-4" },
        image: "alpine",
        resourceLimits: RESOURCE_LIMITS,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("boom");

    // Both the placeholder + post-create register fired (container was
    // created successfully — only start failed); unregister rolls them
    // back together.
    expect(registers).toHaveLength(2);
    expect(unregisters).toEqual(["019d0000-0000-7000-8000-000000000ddd"]);
  });

  it("works without a proxy (no socket mount, no register calls)", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker, calls } = fakeDocker({ dockerId: "docker-no-proxy" });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      // proxy intentionally omitted
    });

    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-000000000eee",
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-5" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const binds = expectDefined(calls.create[0], "first create call").HostConfig?.Binds ?? [];
    expect(binds).toContain("/tmp/wt:/workspace");
    expect(binds.find((b) => b.includes("/var/run/docker.sock"))).toBeUndefined();
  });

  it("bind-mounts the askpass dir read-only when askpassMount is provided", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker, calls } = fakeDocker({ dockerId: "docker-askpass" });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-000000000fff",
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-ap" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
      askpass: {
        hostDir: "/run/cogmo/askpass/019d0000-0000-7000-8000-000000000fff",
        containerDir: "/.cogmo-askpass",
      },
    });

    const binds = expectDefined(calls.create[0], "first create call").HostConfig?.Binds ?? [];
    expect(binds).toContain(
      "/run/cogmo/askpass/019d0000-0000-7000-8000-000000000fff:/.cogmo-askpass:ro",
    );
  });

  it("stopTask wipes the askpass dir when askpassBaseDir is configured", async () => {
    const { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const baseDir = mkdtempSync(join(tmpdir(), "cogmo-supervisor-askpass-"));
    const taskDir = join(baseDir, "019d0000-0000-7000-8000-000000abcdef");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "pat"), "secret");

    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = fakeDocker({ dockerId: "docker-stopAskpass" });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      askpassBaseDir: baseDir,
    });

    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-000000abcdef",
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-stop-askpass" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(existsSync(taskDir)).toBe(true);

    await sandbox.deleteByTaskId("019d0000-0000-7000-8000-000000abcdef");
    expect(existsSync(taskDir)).toBe(false);

    rmSync(baseDir, { recursive: true, force: true });
  });

  it("stopTask wipes the askpass dir even when the cascade kill throws", async () => {
    // Pins the `try/finally` invariant in `stopTask`: an unexpected Docker
    // error during the cascade kill must NOT prevent askpass cleanup.
    // Without this guarantee a kill-side flake leaks per-task PAT +
    // signing-key material under `${askpassBaseDir}/<taskId>`. Companion to
    // the happy-path test above — together they cover both branches of
    // the finally.
    const { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const baseDir = mkdtempSync(join(tmpdir(), "cogmo-supervisor-askpass-fail-"));
    const taskId = "019d0000-0000-7000-8000-000000feedee";
    const taskDir = join(baseDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "pat"), "secret");

    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    // Custom docker stub: kill rejects with a non-recoverable error
    // (statusCode 500 — not the 304/404 the supervisor swallows). The
    // error must propagate out of the for-loop into the finally without
    // skipping cleanupAskpass.
    const start = vi.fn(async () => {});
    const inspect = vi.fn(async () => ({ State: { Status: "running" }, HostConfig: {} }));
    const kill = vi.fn(async () => {
      const err: Error & { statusCode?: number } = new Error("daemon i/o error");
      err.statusCode = 500;
      throw err;
    });
    const remove = vi.fn(async () => {});
    const docker = {
      createContainer: vi.fn(async () => ({ id: "docker-killfail", start, remove, inspect })),
      listContainers: vi.fn(async () => []),
      getContainer: () => ({ inspect, kill, remove }),
      info: vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } })),
    } as unknown as Docker;
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      askpassBaseDir: baseDir,
    });

    await sandbox.create({
      taskId,
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-killfail" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(existsSync(taskDir)).toBe(true);

    // The thrown kill error escapes stopTask (the finally re-raises after
    // running cleanup), but the askpass dir must already be gone by then.
    await expect(sandbox.deleteByTaskId(taskId)).rejects.toThrow("daemon i/o error");
    expect(kill).toHaveBeenCalled();
    expect(existsSync(taskDir)).toBe(false);

    rmSync(baseDir, { recursive: true, force: true });
  });

  it("stopTask is a no-op for askpass when no baseDir is configured", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = fakeDocker({ dockerId: "docker-noaskpass" });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-0000000fffff",
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-no-askpass" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Just shouldn't throw — there's nothing on disk to clean.
    await sandbox.deleteByTaskId("019d0000-0000-7000-8000-0000000fffff");
  });

  it("threads spec.env into HostConfig.Env on the create call", async () => {
    // Pins the contract for coding-delegation's CLAUDE_CODE_OAUTH_TOKEN
    // injection: the orchestrator hands us env, we lift it onto the
    // container's process env, and nothing leaks onto the home volume or
    // labels. KEY=VALUE encoding follows dockerode's array convention.
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker, calls } = fakeDocker({ dockerId: "docker-env" });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });
    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-000000000e10",
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-env" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-test-123", FOO: "bar" },
    });
    const createSpec = calls.create[0] as DockerCreateCallArgs & { Env?: string[] };
    expect(createSpec.Env).toEqual(["CLAUDE_CODE_OAUTH_TOKEN=sk-test-123", "FOO=bar"]);
  });

  it("omits HostConfig.Env entirely when spec.env is absent", async () => {
    // Without an explicit env, dockerode's container should pick up the
    // image's default env — we must NOT pass an empty array, which would
    // override that.
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker, calls } = fakeDocker({ dockerId: "docker-no-env" });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });
    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-000000000e11",
      worktree: { hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-no-env" },
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const createSpec = calls.create[0] as DockerCreateCallArgs & { Env?: string[] };
    expect(createSpec.Env).toBeUndefined();
  });

  it("shutdown closes the proxy", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = fakeDocker();
    const { proxy } = fakeProxy();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });
    await sandbox.shutdown();
    expect(proxy.close).toHaveBeenCalledTimes(1);
  });
});

describe("LocalDockerSandboxClient — execStreaming.dispose()", () => {
  /**
   * Regression test for the dispose-hang bug: a bare `stream.destroy()`
   * emits only `'close'`, neither `'end'` nor `'error'`. The exit
   * promise listens on the latter two; if dispose closes the stream
   * without an error, the promise never settles and `dispose()` waits
   * forever. Fix: pass an error so the `'error'` handler fires.
   */
  it("resolves promptly when called on a stream that won't end naturally", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));

    // Hijacked stream that never emits 'end' or 'error' on its own —
    // mimics a long-running exec that's still attached to the daemon.
    const { PassThrough } = await import("node:stream");
    const hijack = new PassThrough();
    const execObj = {
      start: vi.fn(async () => hijack),
      inspect: vi.fn(async () => ({ ExitCode: 137 })),
    };
    const containerObj = {
      exec: vi.fn(async () => execObj),
      inspect: vi.fn(async () => ({ State: { Status: "running" }, HostConfig: {} })),
      kill: vi.fn(),
      remove: vi.fn(),
    };
    const docker = {
      info: vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } })),
      createContainer: vi.fn(async () => ({
        id: "docker-dispose",
        start: vi.fn(),
        remove: vi.fn(),
        inspect: vi.fn(async () => ({ State: { Status: "running" }, HostConfig: {} })),
      })),
      getContainer: vi.fn(() => containerObj),
      listContainers: vi.fn(async () => []),
      // demuxStream is normally dockerode's frame parser — bypass it
      // since we're not feeding real Docker frames.
      modem: { demuxStream: vi.fn() },
    } as unknown as Docker;
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    const session = await sandbox.create({
      taskId: "019d0000-0000-7000-8000-00000000d150",
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const handle = await session.execStreaming(["sleep", "infinity"]);

    // Race dispose against a short timeout. Pre-fix this race was lost
    // (dispose hung); post-fix it resolves in milliseconds.
    const TIMEOUT_MS = 500;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
    });
    const winner = await Promise.race([handle.dispose().then(() => "done" as const), timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    expect(winner).toBe("done");
  });
});
