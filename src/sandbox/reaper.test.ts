import type Docker from "dockerode";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { runReap } from "./reaper.js";
import { DrizzleSandboxStore } from "./store/index.js";
import type { ContainerLabels, ResourceLimits } from "./types.js";

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 0.5,
  memory_bytes: 256 * 1024 * 1024,
  pids: 64,
};

let db: Database;
let close: () => Promise<void>;
let store: DrizzleSandboxStore;
let instanceId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleSandboxStore(db);
});

beforeEach(async () => {
  const inst = await store.insertInstance({ host: "h", pid: 1 });
  instanceId = inst.id;
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

function labels(extra: Partial<ContainerLabels> = {}): ContainerLabels {
  return {
    "cogmo.managed": "true",
    "cogmo.instance": instanceId,
    "cogmo.root_task": TASK_ID,
    "cogmo.parent": "",
    "cogmo.depth": "0",
    ...extra,
  };
}

interface DockerSideContainer {
  Id: string;
  Labels?: Record<string, string>;
}

/**
 * Stub Docker enough to drive the reaper. Tracks killed/removed ids per
 * resource so tests can assert order + count.
 */
function fakeDocker(opts: { containers?: DockerSideContainer[]; failKill?: Set<string> } = {}): {
  docker: Docker;
  killCalls: string[];
  removeCalls: string[];
  networkRemoveCalls: string[];
  volumeRemoveCalls: string[];
} {
  const killCalls: string[] = [];
  const removeCalls: string[] = [];
  const networkRemoveCalls: string[] = [];
  const volumeRemoveCalls: string[] = [];
  const containers = opts.containers ?? [];
  const docker = {
    listContainers: vi.fn(async () => containers),
    getContainer: (id: string) => ({
      kill: vi.fn(async () => {
        if (opts.failKill?.has(id)) {
          throw Object.assign(new Error("nope"), { statusCode: 304 });
        }
        killCalls.push(id);
      }),
      remove: vi.fn(async () => {
        removeCalls.push(id);
      }),
    }),
    getNetwork: (id: string) => ({
      remove: vi.fn(async () => {
        networkRemoveCalls.push(id);
      }),
    }),
    getVolume: (id: string) => ({
      remove: vi.fn(async () => {
        volumeRemoveCalls.push(id);
      }),
    }),
  };
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal docker stub
    docker: docker as any,
    killCalls,
    removeCalls,
    networkRemoveCalls,
    volumeRemoveCalls,
  };
}

const NOW = () => new Date("2026-04-27T12:00:00Z");

async function insertContainer(opts: {
  dockerId: string;
  /** TTL offset relative to the fake `NOW` — negative = expired. */
  ttlMs: number;
  status?: "starting" | "running" | "exited" | "reaped";
  depth?: number;
  rootTaskId?: string;
  instanceId?: string;
  parentId?: string | null;
}): Promise<string> {
  const row = await store.insertContainer({
    dockerId: opts.dockerId,
    parentId: opts.parentId ?? null,
    rootTaskId: opts.rootTaskId ?? TASK_ID,
    depth: opts.depth ?? 0,
    image: "img",
    runtime: "runc",
    labels: labels(),
    resourceLimits: RESOURCE_LIMITS,
    ttlExpiresAt: new Date(NOW().getTime() + opts.ttlMs),
    instanceId: opts.instanceId ?? instanceId,
  });
  if (opts.status && opts.status !== "starting") {
    await store.updateContainerStatus({ id: row.id, status: opts.status });
  }
  return row.id;
}

describe("runReap — TTL pass", () => {
  it("reaps containers whose TTL has expired and were running", async () => {
    const dockerSide: DockerSideContainer[] = [{ Id: "c1", Labels: labels() }];
    const { docker, killCalls, removeCalls } = fakeDocker({ containers: dockerSide });
    const cogmoId = await insertContainer({
      dockerId: "c1",
      ttlMs: -1000, // expired 1s ago (relative to real now; test uses fake now anyway)
      status: "running",
    });

    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect(killCalls).toEqual(["c1"]);
    expect(removeCalls).toEqual(["c1"]);
    const reloaded = await store.getContainer(cogmoId);
    expect(reloaded?.status).toBe("reaped");
  });

  it("does not reap containers with future TTL", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-fresh", Labels: labels() }],
    });
    await insertContainer({ dockerId: "c-fresh", ttlMs: 60_000, status: "running" });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("kills children before parents (depth DESC)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [
        { Id: "parent", Labels: labels() },
        { Id: "child", Labels: labels() },
      ],
    });
    const parentId = await insertContainer({
      dockerId: "parent",
      ttlMs: -1000,
      status: "running",
      depth: 0,
    });
    await insertContainer({
      dockerId: "child",
      ttlMs: -1000,
      status: "running",
      depth: 1,
      parentId,
    });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(2);
    expect(killCalls).toEqual(["child", "parent"]);
  });

  it("skips already-reaped rows on re-tick (idempotent)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-old", Labels: labels() }],
    });
    await insertContainer({
      dockerId: "c-old",
      ttlMs: -10_000,
      status: "reaped",
    });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });
});

describe("runReap — orphan pass", () => {
  it("reaps a container labelled with a dead instance id", async () => {
    const deadInstance = await store.insertInstance({ host: "h", pid: 99 });
    await store.closeInstance(deadInstance.id);
    const { docker, killCalls, removeCalls } = fakeDocker({
      containers: [
        {
          Id: "c-orphan",
          Labels: { ...labels(), "cogmo.instance": deadInstance.id },
        },
      ],
    });
    // No DB row for c-orphan — purely Docker-side discovery.
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-orphan"]);
    expect(removeCalls).toEqual(["c-orphan"]);
  });

  it("reaps a container with no cogmo.instance label", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [
        {
          Id: "c-bare",
          Labels: { "cogmo.managed": "true" }, // missing cogmo.instance
        },
      ],
    });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-bare"]);
  });

  it("reaps a Docker container that has no DB row (orphan create)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-no-db", Labels: labels() }],
    });
    // No insertContainer for c-no-db.
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-no-db"]);
  });

  it("does NOT reap a healthy container (live instance + DB row present)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-good", Labels: labels() }],
    });
    await insertContainer({ dockerId: "c-good", ttlMs: 60_000, status: "running" });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("marks the DB row reaped when an orphan with a stale-instance row is killed", async () => {
    const deadInstance = await store.insertInstance({ host: "h", pid: 99 });
    await store.closeInstance(deadInstance.id);
    const cogmoId = await insertContainer({
      dockerId: "c-stale-row",
      ttlMs: 60_000,
      status: "running",
      instanceId: deadInstance.id,
    });
    const { docker } = fakeDocker({
      containers: [
        {
          Id: "c-stale-row",
          Labels: { ...labels(), "cogmo.instance": deadInstance.id },
        },
      ],
    });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect((await store.getContainer(cogmoId))?.status).toBe("reaped");
  });
});

describe("runReap — stale DB pass", () => {
  it("marks a row exited when it's not in Docker's listing anymore", async () => {
    const cogmoId = await insertContainer({
      dockerId: "c-vanished",
      ttlMs: 60_000,
      status: "running",
    });
    const { docker } = fakeDocker({ containers: [] });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.staleMarked).toBe(1);
    expect((await store.getContainer(cogmoId))?.status).toBe("exited");
  });

  it("does not double-count rows the TTL pass just reaped", async () => {
    await insertContainer({ dockerId: "c-double", ttlMs: -1000, status: "running" });
    const { docker } = fakeDocker({
      containers: [{ Id: "c-double", Labels: labels() }],
    });
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect(result.staleMarked).toBe(0);
  });
});

describe("runReap — networks + volumes", () => {
  it("reaps expired networks", async () => {
    const net = await store.insertNetwork({
      dockerId: "net-old",
      parentId: null,
      rootTaskId: TASK_ID,
      depth: 0,
      labels: labels(),
      ttlExpiresAt: new Date(NOW().getTime() - 1000),
      instanceId,
    });
    const { docker, networkRemoveCalls } = fakeDocker();
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.networksReaped).toBe(1);
    expect(networkRemoveCalls).toEqual(["net-old"]);
    expect((await store.getNetwork(net.id))?.status).toBe("reaped");
  });

  it("reaps expired volumes", async () => {
    const vol = await store.insertVolume({
      dockerId: "vol-old",
      parentId: null,
      rootTaskId: TASK_ID,
      depth: 0,
      labels: labels(),
      ttlExpiresAt: new Date(NOW().getTime() - 1000),
      instanceId,
    });
    const { docker, volumeRemoveCalls } = fakeDocker();
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.volumesReaped).toBe(1);
    expect(volumeRemoveCalls).toEqual(["vol-old"]);
    expect((await store.getVolume(vol.id))?.status).toBe("reaped");
  });

  it("skips already-reaped networks/volumes (idempotent)", async () => {
    const net = await store.insertNetwork({
      dockerId: "net-already-gone",
      parentId: null,
      rootTaskId: TASK_ID,
      depth: 0,
      labels: labels(),
      ttlExpiresAt: new Date(NOW().getTime() - 60_000),
      instanceId,
    });
    await store.updateNetworkStatus({ id: net.id, status: "reaped" });
    const { docker, networkRemoveCalls } = fakeDocker();
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.networksReaped).toBe(0);
    expect(networkRemoveCalls).toEqual([]);
  });

  it("does not reap networks with future TTL", async () => {
    await store.insertNetwork({
      dockerId: "net-fresh",
      parentId: null,
      rootTaskId: TASK_ID,
      depth: 0,
      labels: labels(),
      ttlExpiresAt: new Date(NOW().getTime() + 60_000),
      instanceId,
    });
    const { docker } = fakeDocker();
    const result = await runReap({ docker, store, instanceId, now: NOW });
    expect(result.networksReaped).toBe(0);
  });
});

describe("runReap — resilience", () => {
  it("survives a docker.listContainers failure (orphan pass logs and continues)", async () => {
    await insertContainer({ dockerId: "c-x", ttlMs: -1000, status: "running" });
    const docker = {
      listContainers: vi.fn(async () => {
        throw new Error("daemon down");
      }),
      getContainer: () => ({
        kill: vi.fn(),
        remove: vi.fn(),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: stub
      getNetwork: () => ({ remove: vi.fn() }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      getVolume: () => ({ remove: vi.fn() }) as any,
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal docker stub
    const result = await runReap({ docker: docker as any, store, instanceId, now: NOW });
    // TTL pass still ran (it doesn't depend on listContainers).
    expect(result.ttlReaped).toBe(1);
    // Orphan pass got 0 (listContainers threw, dockerContainers is empty).
    expect(result.orphansReaped).toBe(0);
  });
});
