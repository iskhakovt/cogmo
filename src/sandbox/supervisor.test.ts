/**
 * Supervisor unit tests — focused on the proxy wiring (slice 3.0f). The
 * full Docker-side behavior is covered by `supervisor.integration.test.ts`
 * and `supervisor.sysbox.integration.test.ts`; this file uses stub Docker +
 * stub proxy to verify the supervisor calls the proxy in the right order
 * and bind-mounts the returned socket path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { DockerContainer, DockerFacade, DockerImage, DockerModem } from "./docker-facade.js";
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
    NanoCpus?: number;
    Memory?: number;
    PidsLimit?: number;
    // StorageOpt is Docker's per-container disk quota knob (only honored by
    // some storage drivers). Tracked here so the "disk_bytes silently ignored
    // on local-docker" test can assert the supervisor never sets it.
    StorageOpt?: Record<string, string>;
  };
}

/**
 * Stateful dockerode stub — drives `createTaskContainer` AND records the
 * `createContainer` arg list so tests can assert on the spec the supervisor
 * built. Uses `mock<DockerFacade>()` + `mock<DockerContainer>()` so each
 * method on the surface is auto-mocked; the few we care about get explicit
 * `mockImplementation`s for call-tracking and stateful behaviour.
 */
function fakeDocker(opts: { dockerId: string; failStart?: boolean } = { dockerId: "docker-abc" }): {
  docker: ReturnType<typeof mock<DockerFacade>>;
  calls: { create: DockerCreateCallArgs[]; start: number; remove: number };
} {
  const calls: { create: DockerCreateCallArgs[]; start: number; remove: number } = {
    create: [],
    start: 0,
    remove: 0,
  };
  const container = mock<DockerContainer>();
  // mock<>() leaves `readonly id` as an auto-mock; pin it to the requested
  // docker id so assertions on `state.dockerId` work without further setup.
  Object.defineProperty(container, "id", { value: opts.dockerId, configurable: true });
  container.start.mockImplementation(async () => {
    calls.start += 1;
    if (opts.failStart) throw new Error("boom");
  });
  container.remove.mockImplementation(async () => {
    calls.remove += 1;
  });
  container.inspect.mockResolvedValue({ State: { Status: "running" }, HostConfig: {} });

  const docker = mock<DockerFacade>();
  docker.info.mockResolvedValue({ Runtimes: { runc: { path: "runc" } } });
  docker.listContainers.mockResolvedValue([]);
  docker.createContainer.mockImplementation(async (spec): Promise<DockerContainer> => {
    calls.create.push(spec as DockerCreateCallArgs);
    return container;
  });
  docker.getContainer.mockReturnValue(container);
  return { docker, calls };
}

/**
 * `mock<DockerFacade>()` with the always-needed defaults populated.
 * Returns the typed mock proxy plus the auto-mocked `DockerContainer` that
 * `getContainer` resolves to — most tests just need to point a specific
 * `inspect` resolution at it. Per-test overrides happen via the standard
 * `.mockResolvedValue` / `.mockReturnValue` API.
 */
function mockDockerFacade(): {
  docker: ReturnType<typeof mock<DockerFacade>>;
  container: ReturnType<typeof mock<DockerContainer>>;
} {
  const docker = mock<DockerFacade>();
  docker.info.mockResolvedValue({ Runtimes: { runc: { path: "runc" } } });
  docker.listContainers.mockResolvedValue([]);
  // `mock<T>()` doesn't deep-mock nested object properties — `modem` shows
  // up as `undefined` until we explicitly construct it. Assign the inner
  // mock so callers can `vi.mocked(docker.modem.followProgress)`.
  docker.modem = mock<DockerModem>();
  const container = mock<DockerContainer>();
  container.inspect.mockResolvedValue({ State: { Status: "running" }, HostConfig: {} });
  docker.getContainer.mockReturnValue(container);
  return { docker, container };
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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

  it("ignores ResourceLimits.disk_bytes — runc HostConfig has no native disk quota", async () => {
    // disk_bytes is a Daytona-only knob (mapped onto the platform's `disk`
    // field); on local-docker the supervisor must drop it. Docker's
    // closest equivalent (`StorageOpt`) is only honored by a couple of
    // storage drivers and is deliberately left alone. Regression guard
    // so a future "let's also wire local disk caps" change has to revisit
    // this test rather than silently ship a partial implementation.
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker, calls } = fakeDocker({ dockerId: "docker-disk" });
    const { proxy } = fakeProxy();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });
    await sandbox.create({
      taskId: "019d0000-0000-7000-8000-0000000000d1",
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
      homeVolume: { volumeName: "vol-disk" },
      image: "alpine",
      resourceLimits: {
        cpus: 1,
        memory_bytes: 256 * 1024 * 1024,
        pids: 64,
        // 5 GiB — large enough that an accidental passthrough would be
        // obvious (and well above Daytona's defaults).
        disk_bytes: 5 * 1024 * 1024 * 1024,
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const create0 = expectDefined(calls.create[0], "first create call");
    // The other three caps still flow through, proving the supervisor
    // received the spec and didn't error on the extra field.
    expect(create0.HostConfig?.NanoCpus).toBe(1_000_000_000);
    expect(create0.HostConfig?.Memory).toBe(256 * 1024 * 1024);
    expect(create0.HostConfig?.PidsLimit).toBe(64);
    // …but no disk-quota field landed in HostConfig.
    expect(create0.HostConfig?.StorageOpt).toBeUndefined();
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
    docker.createContainer.mockRejectedValue(new Error("daemon refused"));
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
        worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
        worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
    } as unknown as DockerFacade;
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
      worktree: { type: "host-path", hostPath: "/tmp/wt" },
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
    } as unknown as DockerFacade;
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

/**
 * Crash-recovery contract — when the orchestrator retries a step via Inngest,
 * the supervisor must rehydrate the prior sandbox session against the live
 * Docker daemon, not blindly trust serialized state. Two entry points serve
 * this:
 *
 *   - `resume(state)` — caller already has a serialized state blob (e.g. from
 *     a step's previous return value).
 *   - `tryResumeByTaskId(taskId)` — caller only knows the rootTaskId and asks
 *     the supervisor to find the right row.
 *
 * Both inspect the container against Docker; a 404 means the reaper got it,
 * the row's status was lying, or someone deleted it out-of-band — none of
 * which should crash the orchestrator. See `design/crash-recovery.md`.
 */
describe("LocalDockerSandboxClient — resume + tryResumeByTaskId (crash recovery)", () => {
  it("resume: inspect succeeds + DB row present → returns a wrapped session", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    // Seed a container row that resume() will look up.
    const taskId = "019d0000-0000-7000-8000-000000000b01";
    const row = await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "docker-resume-1",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        instanceId: inst.id,
      }),
    );

    const { docker, container } = mockDockerFacade();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    const session = await sandbox.resume({
      type: "local-docker",
      taskId,
      containerRowId: row.id,
      dockerId: "docker-resume-1",
    });

    expect(session.state.dockerId).toBe("docker-resume-1");
    expect(container.inspect).toHaveBeenCalledOnce();
  });

  it("resume: throws when no DB row exists for the docker id (orphan state blob)", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));

    const { docker } = mockDockerFacade();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await expect(
      sandbox.resume({
        type: "local-docker",
        taskId: "019d0000-0000-7000-8000-000000000b02",
        containerRowId: "019d0000-0000-7000-8000-000000000b03",
        dockerId: "docker-orphan",
      }),
    ).rejects.toThrow(/no DB row/);
  });

  it("resume: propagates docker.inspect errors (caller decides retry vs delete)", async () => {
    // A 404 here means "Docker no longer has this container" — the
    // resume contract is "verify the container is still present"; if
    // it isn't, the caller's exception handler decides whether to
    // start fresh or surface the error.
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker, container } = mockDockerFacade();
    container.inspect.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await expect(
      sandbox.resume({
        type: "local-docker",
        taskId: "019d0000-0000-7000-8000-000000000b04",
        containerRowId: "019d0000-0000-7000-8000-000000000b05",
        dockerId: "docker-gone",
      }),
    ).rejects.toThrow(/no such container/);
  });

  it("tryResumeByTaskId: no rows for taskId → null", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = mockDockerFacade();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    const session = await sandbox.tryResumeByTaskId("019d0000-0000-7000-8000-000000000c01");
    expect(session).toBeNull();
  });

  it("tryResumeByTaskId: depth>0 children are skipped — only depth=0 root sessions resume", async () => {
    // A task that spawned sibling docker-in-docker containers must not
    // resume into one of them; the contract is "root session", not
    // "any descendant".
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const taskId = "019d0000-0000-7000-8000-000000000c02";
    const parent = await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "docker-parent",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        instanceId: inst.id,
      }),
    );
    // Child at depth=1.
    await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "docker-child",
        parentId: parent.id,
        rootTaskId: taskId,
        depth: 1,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        instanceId: inst.id,
      }),
    );

    const { docker } = mockDockerFacade();
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    const session = await sandbox.tryResumeByTaskId(taskId);
    expect(session?.state.dockerId).toBe("docker-parent");
  });

  it("tryResumeByTaskId: docker.inspect returns 404 → skips that row, continues", async () => {
    // Two depth=0 candidates: the first is gone from Docker (404), the
    // second is live. Resume must walk past the dead row.
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const taskId = "019d0000-0000-7000-8000-000000000c03";
    await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "docker-dead",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        instanceId: inst.id,
      }),
    );
    await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "docker-alive",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        instanceId: inst.id,
      }),
    );

    const deadContainer = mock<DockerContainer>();
    deadContainer.inspect.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );
    const aliveContainer = mock<DockerContainer>();
    aliveContainer.inspect.mockResolvedValue({
      State: { Status: "running" },
      HostConfig: {},
    });
    const { docker } = mockDockerFacade();
    docker.getContainer.mockImplementation((id: string) =>
      id === "docker-dead" ? deadContainer : aliveContainer,
    );
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    const session = await sandbox.tryResumeByTaskId(taskId);
    expect(session?.state.dockerId).toBe("docker-alive");
    expect(deadContainer.inspect).toHaveBeenCalledOnce();
    expect(aliveContainer.inspect).toHaveBeenCalledOnce();
  });

  it("tryResumeByTaskId: docker.inspect non-404 errors propagate (don't silently skip)", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const taskId = "019d0000-0000-7000-8000-000000000c04";
    await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "docker-flaky",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        instanceId: inst.id,
      }),
    );

    const { docker, container } = mockDockerFacade();
    container.inspect.mockRejectedValue(
      Object.assign(new Error("daemon unreachable"), { statusCode: 503 }),
    );
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await expect(sandbox.tryResumeByTaskId(taskId)).rejects.toThrow(/daemon unreachable/);
  });

  it("tryResumeByTaskId: a row whose State.Status is not 'running' is skipped", async () => {
    // Container exists on the daemon but isn't actually running (paused,
    // exited, etc.) — supervisor must not return a stale session.
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const taskId = "019d0000-0000-7000-8000-000000000c05";
    await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "docker-paused",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        instanceId: inst.id,
      }),
    );

    const { docker, container } = mockDockerFacade();
    container.inspect.mockResolvedValue({ State: { Status: "paused" }, HostConfig: {} });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    const session = await sandbox.tryResumeByTaskId(taskId);
    expect(session).toBeNull();
  });
});

describe("LocalDockerSandboxClient — ensureImagePresent (first-boot image pull)", () => {
  it("inspect succeeds → no pull, returns silently", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = mockDockerFacade();
    const image = mock<DockerImage>();
    image.inspect.mockResolvedValue({ Id: "sha256:abc" });
    docker.getImage.mockReturnValue(image);
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await sandbox.ensureImagePresent("alpine:3.20");

    expect(image.inspect).toHaveBeenCalledOnce();
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it("inspect 404 → pulls + waits for followProgress to complete", async () => {
    const { PassThrough } = await import("node:stream");
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = mockDockerFacade();
    const image = mock<DockerImage>();
    image.inspect.mockRejectedValue(Object.assign(new Error("no such image"), { statusCode: 404 }));
    docker.getImage.mockReturnValue(image);
    // Real `PassThrough` is a `NodeJS.ReadableStream` — supervisor passes
    // it opaquely to modem.followProgress and awaits the completion callback.
    docker.pull.mockResolvedValue(new PassThrough());
    vi.mocked(docker.modem.followProgress).mockImplementation((_stream, cb) => {
      cb(null); // success
    });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await sandbox.ensureImagePresent("alpine:3.20");

    expect(docker.pull).toHaveBeenCalledWith("alpine:3.20");
    expect(docker.modem.followProgress).toHaveBeenCalledOnce();
  });

  it("inspect non-404 error → propagates (caller decides retry vs surface)", async () => {
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = mockDockerFacade();
    const image = mock<DockerImage>();
    image.inspect.mockRejectedValue(Object.assign(new Error("ECONNREFUSED"), { statusCode: 500 }));
    docker.getImage.mockReturnValue(image);
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await expect(sandbox.ensureImagePresent("alpine")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("followProgress callback error → ensureImagePresent rejects", async () => {
    // A pull that starts but fails mid-stream (network blip, disk full)
    // must surface as a rejected promise; the supervisor mustn't return
    // success while the image is half-pulled.
    const { PassThrough } = await import("node:stream");
    const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const { docker } = mockDockerFacade();
    const image = mock<DockerImage>();
    image.inspect.mockRejectedValue(Object.assign(new Error("no such image"), { statusCode: 404 }));
    docker.getImage.mockReturnValue(image);
    docker.pull.mockResolvedValue(new PassThrough());
    vi.mocked(docker.modem.followProgress).mockImplementation((_stream, cb) => {
      cb(new Error("pull aborted: disk full"));
    });
    const sandbox = await LocalDockerSandboxClient.create({
      docker,
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: inst.id,
    });

    await expect(sandbox.ensureImagePresent("alpine")).rejects.toThrow(/disk full/);
  });
});
