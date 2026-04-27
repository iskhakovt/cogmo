/**
 * Supervisor unit tests — focused on the proxy wiring (slice 3.0f). The
 * full Docker-side behavior is covered by `supervisor.integration.test.ts`
 * and `supervisor.sysbox.integration.test.ts`; this file uses stub Docker +
 * stub proxy to verify the supervisor calls the proxy in the right order
 * and bind-mounts the returned socket path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { LocalInProcessSandbox } from "./index.js";
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
let close: () => Promise<void>;
let store: DrizzleSandboxStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleSandboxStore(db);
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
  };
}

/** Minimal dockerode stub — enough to drive createTaskContainer. */
function fakeDocker(opts: { dockerId: string; failStart?: boolean } = { dockerId: "docker-abc" }) {
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
  };
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

describe("LocalInProcessSandbox — proxy wiring", () => {
  it("registers the proxy with placeholder, then upserts the parent docker id", async () => {
    const inst = await store.insertInstance({ host: "h", pid: 1 });
    const { docker, calls } = fakeDocker({ dockerId: "docker-task-xyz" });
    const { proxy, registers } = fakeProxy();
    // Skip assertRuntimeAvailable: the runtime probe lists runtimes via
    // docker.info which our stub doesn't implement. Bypass by stubbing the
    // sandbox factory's pre-check via a runc runtime + a dock that returns
    // the runtime in `info`.
    docker.info = vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } }));
    const sandbox = await LocalInProcessSandbox.create({
      // biome-ignore lint/suspicious/noExplicitAny: minimal dockerode stub
      docker: docker as any,
      store,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    const handle = await sandbox.createTaskContainer({
      rootTaskId: "019d0000-0000-7000-8000-000000000aaa",
      worktreePath: "/tmp/wt",
      homeVolumeName: "vol-1",
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      ttl: { expiresAt: new Date(Date.now() + 60_000) },
      allowPrivilegedRunc: false,
    });
    expect(handle.dockerId).toBe("docker-task-xyz");

    // Two register calls: pre-create placeholder, post-create upsert.
    expect(registers).toHaveLength(2);
    expect(registers[0].parentDockerId).toBe("");
    expect(registers[0].parentContainerRowId).toBe("");
    expect(registers[0].runtime).toBe("runc");
    expect(registers[1].parentDockerId).toBe("docker-task-xyz");
    expect(registers[1].parentContainerRowId).toBeTruthy();

    // Container created with the proxy socket bind-mounted at /var/run/docker.sock.
    expect(calls.create).toHaveLength(1);
    const binds = calls.create[0].HostConfig?.Binds ?? [];
    expect(binds).toContain("/tmp/wt:/workspace");
    expect(binds).toContain(
      "/run/cogmo/sockets/019d0000-0000-7000-8000-000000000aaa.sock:/var/run/docker.sock",
    );
  });

  it("unregisters the proxy on stopTask", async () => {
    const inst = await store.insertInstance({ host: "h", pid: 1 });
    const { docker } = fakeDocker({ dockerId: "docker-x" });
    docker.info = vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } }));
    const { proxy, unregisters } = fakeProxy();
    const sandbox = await LocalInProcessSandbox.create({
      // biome-ignore lint/suspicious/noExplicitAny: minimal dockerode stub
      docker: docker as any,
      store,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    await sandbox.createTaskContainer({
      rootTaskId: "019d0000-0000-7000-8000-000000000bbb",
      worktreePath: "/tmp/wt",
      homeVolumeName: "vol-2",
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      ttl: { expiresAt: new Date(Date.now() + 60_000) },
      allowPrivilegedRunc: false,
    });
    await sandbox.stopTask("019d0000-0000-7000-8000-000000000bbb");
    expect(unregisters).toEqual(["019d0000-0000-7000-8000-000000000bbb"]);
  });

  it("rolls back the proxy registration when Docker createContainer fails", async () => {
    const inst = await store.insertInstance({ host: "h", pid: 1 });
    const { docker } = fakeDocker();
    docker.info = vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } }));
    docker.createContainer = vi.fn(async () => {
      throw new Error("daemon refused");
    });
    const { proxy, registers, unregisters } = fakeProxy();
    const sandbox = await LocalInProcessSandbox.create({
      // biome-ignore lint/suspicious/noExplicitAny: minimal dockerode stub
      docker: docker as any,
      store,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    await expect(
      sandbox.createTaskContainer({
        rootTaskId: "019d0000-0000-7000-8000-000000000ccc",
        worktreePath: "/tmp/wt",
        homeVolumeName: "vol-3",
        image: "alpine",
        resourceLimits: RESOURCE_LIMITS,
        ttl: { expiresAt: new Date(Date.now() + 60_000) },
        allowPrivilegedRunc: false,
      }),
    ).rejects.toThrow("daemon refused");

    expect(registers).toHaveLength(1); // only the placeholder
    expect(unregisters).toEqual(["019d0000-0000-7000-8000-000000000ccc"]);
  });

  it("rolls back the proxy registration when container.start fails", async () => {
    const inst = await store.insertInstance({ host: "h", pid: 1 });
    const { docker } = fakeDocker({ dockerId: "docker-fail-start", failStart: true });
    docker.info = vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } }));
    const { proxy, registers, unregisters } = fakeProxy();
    const sandbox = await LocalInProcessSandbox.create({
      // biome-ignore lint/suspicious/noExplicitAny: minimal dockerode stub
      docker: docker as any,
      store,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });

    await expect(
      sandbox.createTaskContainer({
        rootTaskId: "019d0000-0000-7000-8000-000000000ddd",
        worktreePath: "/tmp/wt",
        homeVolumeName: "vol-4",
        image: "alpine",
        resourceLimits: RESOURCE_LIMITS,
        ttl: { expiresAt: new Date(Date.now() + 60_000) },
        allowPrivilegedRunc: false,
      }),
    ).rejects.toThrow("boom");

    // Both the placeholder + post-create register fired (container was
    // created successfully — only start failed); unregister rolls them
    // back together.
    expect(registers).toHaveLength(2);
    expect(unregisters).toEqual(["019d0000-0000-7000-8000-000000000ddd"]);
  });

  it("works without a proxy (no socket mount, no register calls)", async () => {
    const inst = await store.insertInstance({ host: "h", pid: 1 });
    const { docker, calls } = fakeDocker({ dockerId: "docker-no-proxy" });
    docker.info = vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } }));
    const sandbox = await LocalInProcessSandbox.create({
      // biome-ignore lint/suspicious/noExplicitAny: minimal dockerode stub
      docker: docker as any,
      store,
      runtime: "runc",
      instanceId: inst.id,
      // proxy intentionally omitted
    });

    await sandbox.createTaskContainer({
      rootTaskId: "019d0000-0000-7000-8000-000000000eee",
      worktreePath: "/tmp/wt",
      homeVolumeName: "vol-5",
      image: "alpine",
      resourceLimits: RESOURCE_LIMITS,
      ttl: { expiresAt: new Date(Date.now() + 60_000) },
      allowPrivilegedRunc: false,
    });

    const binds = calls.create[0].HostConfig?.Binds ?? [];
    expect(binds).toContain("/tmp/wt:/workspace");
    expect(binds.find((b) => b.includes("/var/run/docker.sock"))).toBeUndefined();
  });

  it("shutdown closes the proxy", async () => {
    const inst = await store.insertInstance({ host: "h", pid: 1 });
    const { docker } = fakeDocker();
    docker.info = vi.fn(async () => ({ Runtimes: { runc: { path: "runc" } } }));
    const { proxy } = fakeProxy();
    const sandbox = await LocalInProcessSandbox.create({
      // biome-ignore lint/suspicious/noExplicitAny: minimal dockerode stub
      docker: docker as any,
      store,
      runtime: "runc",
      instanceId: inst.id,
      proxy,
    });
    await sandbox.shutdown();
    expect(proxy.close).toHaveBeenCalledTimes(1);
  });
});
