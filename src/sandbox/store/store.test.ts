import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import type { ContainerLabels, ResourceLimits } from "../types.js";
import { DrizzleSandboxStore } from "./index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSandboxStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSandboxStore(tx);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 2,
  memory_bytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
};

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

function labels(extra: Partial<ContainerLabels> = {}): ContainerLabels {
  return {
    "cogmo.managed": "true",
    "cogmo.instance": "instance-placeholder",
    "cogmo.root_task": TASK_ID,
    "cogmo.parent": "",
    "cogmo.depth": "0",
    ...extra,
  };
}

async function seedInstance(): Promise<string> {
  return (await store.insertInstance({ host: "test-host", pid: 42 })).id;
}

async function insertTaskContainer(opts: {
  instanceId: string;
  rootTaskId?: string;
  dockerId?: string;
  parentId?: string | null;
  depth?: number;
}): Promise<string> {
  const row = await store.insertContainer({
    dockerId: opts.dockerId ?? `docker-${Math.random().toString(36).slice(2)}`,
    parentId: opts.parentId ?? null,
    rootTaskId: opts.rootTaskId ?? TASK_ID,
    depth: opts.depth ?? 0,
    image: "cogmo/devbase:slice1",
    runtime: "sysbox-runc",
    labels: labels(),
    resourceLimits: RESOURCE_LIMITS,
    ttlExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    instanceId: opts.instanceId,
  });
  return row.id;
}

describe("DrizzleSandboxStore", () => {
  describe("instances", () => {
    it("inserts an instance with stoppedAt null", async () => {
      const inst = await store.insertInstance({ host: "host-1", pid: 1234 });
      expect(inst.host).toBe("host-1");
      expect(inst.pid).toBe(1234);
      expect(inst.stoppedAt).toBeNull();
      expect(inst.createdAt).toBeInstanceOf(Date);
    });

    it("closeInstance sets stoppedAt", async () => {
      const inst = await store.insertInstance({ host: "h", pid: 1 });
      await store.closeInstance(inst.id);
      const reloaded = await store.getInstance(inst.id);
      expect(reloaded?.stoppedAt).toBeInstanceOf(Date);
    });

    it("listLiveInstances excludes stopped instances", async () => {
      const a = await store.insertInstance({ host: "a", pid: 1 });
      const b = await store.insertInstance({ host: "b", pid: 2 });
      await store.closeInstance(a.id);
      const live = await store.listLiveInstances();
      expect(live.map((i) => i.id)).toEqual([b.id]);
    });

    it("getInstance returns null for unknown id", async () => {
      expect(await store.getInstance("019d0000-0000-7000-8000-000000000099")).toBeUndefined();
    });
  });

  describe("containers", () => {
    it("inserts a container with starting status and parsed JSONB", async () => {
      const instanceId = await seedInstance();
      const row = await store.insertContainer({
        dockerId: "abc123",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        image: "cogmo/devbase:slice1",
        runtime: "sysbox-runc",
        labels: labels(),
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date("2026-04-26T00:00:00Z"),
        instanceId,
      });
      expect(row.dockerId).toBe("abc123");
      expect(row.status).toBe("starting");
      expect(row.depth).toBe(0);
      expect(row.runtime).toBe("sysbox-runc");
      expect(row.labels["cogmo.managed"]).toBe("true");
      expect(row.resourceLimits.cpus).toBe(2);
      expect(row.startedAt).toBeNull();
      expect(row.exitedAt).toBeNull();
      expect(row.exitCode).toBeNull();
    });

    it("rejects malformed labels at the store boundary", async () => {
      const instanceId = await seedInstance();
      await expect(
        store.insertContainer({
          dockerId: "bad",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          image: "img",
          runtime: "runc",
          // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
          labels: { "cogmo.depth": 0 } as any,
          resourceLimits: RESOURCE_LIMITS,
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      ).rejects.toThrow();
    });

    it("rejects malformed resourceLimits at the store boundary", async () => {
      const instanceId = await seedInstance();
      await expect(
        store.insertContainer({
          dockerId: "bad",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          image: "img",
          runtime: "runc",
          labels: labels(),
          // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
          resourceLimits: { cpus: -1, memory_bytes: 1, pids: 1 } as any,
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      ).rejects.toThrow();
    });

    it("rejects malformed labels via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const id = await insertTaskContainer({ instanceId });
      await db.execute(sql`UPDATE containers SET labels = '{"junk":true}'::jsonb WHERE id = ${id}`);
      await expect(store.getContainer(id)).rejects.toThrow();
    });

    it("rejects malformed resourceLimits via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const id = await insertTaskContainer({ instanceId });
      await db.execute(
        sql`UPDATE containers SET resource_limits = '{"junk":true}'::jsonb WHERE id = ${id}`,
      );
      await expect(store.getContainer(id)).rejects.toThrow();
    });

    it("enforces unique docker_id", async () => {
      const instanceId = await seedInstance();
      await insertTaskContainer({ instanceId, dockerId: "dup" });
      await expect(insertTaskContainer({ instanceId, dockerId: "dup" })).rejects.toThrow();
    });

    it("updateContainerStatus updates lifecycle fields", async () => {
      const instanceId = await seedInstance();
      const id = await insertTaskContainer({ instanceId });
      const startedAt = new Date("2026-04-25T10:00:00Z");
      await store.updateContainerStatus({ id, status: "running", startedAt });
      let row = await store.getContainer(id);
      expect(row?.status).toBe("running");
      expect(row?.startedAt?.toISOString()).toBe(startedAt.toISOString());

      const exitedAt = new Date("2026-04-25T10:05:00Z");
      await store.updateContainerStatus({ id, status: "exited", exitCode: 0, exitedAt });
      row = await store.getContainer(id);
      expect(row?.status).toBe("exited");
      expect(row?.exitCode).toBe(0);
      expect(row?.exitedAt?.toISOString()).toBe(exitedAt.toISOString());
    });

    it("getContainerByDockerId returns the row", async () => {
      const instanceId = await seedInstance();
      await insertTaskContainer({ instanceId, dockerId: "lookup-me" });
      const row = await store.getContainerByDockerId("lookup-me");
      expect(row?.dockerId).toBe("lookup-me");
    });

    it("getContainer returns null for unknown id", async () => {
      expect(await store.getContainer("019d0000-0000-7000-8000-000000000099")).toBeUndefined();
    });

    it("listContainersForInstance returns all rows for the instance, ordered by createdAt", async () => {
      const instA = await seedInstance();
      const instB = (await store.insertInstance({ host: "b", pid: 2 })).id;
      await insertTaskContainer({ instanceId: instA, dockerId: "a1" });
      await insertTaskContainer({ instanceId: instA, dockerId: "a2" });
      await insertTaskContainer({ instanceId: instB, dockerId: "b1" });

      const rowsA = await store.listContainersForInstance(instA);
      expect(rowsA.map((r) => r.dockerId)).toEqual(["a1", "a2"]);
      const rowsB = await store.listContainersForInstance(instB);
      expect(rowsB.map((r) => r.dockerId)).toEqual(["b1"]);
    });

    it("listContainersForTask returns rows in cascade order (depth DESC: children first)", async () => {
      const instanceId = await seedInstance();
      const taskId = "019d0000-0000-7000-8000-000000000010";
      const taskContainer = await store.insertContainer({
        dockerId: "task",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        image: "img",
        runtime: "runc",
        labels: labels({ "cogmo.root_task": taskId }),
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await store.insertContainer({
        dockerId: "child",
        parentId: taskContainer.id,
        rootTaskId: taskId,
        depth: 1,
        image: "img",
        runtime: "runc",
        labels: labels({ "cogmo.root_task": taskId, "cogmo.depth": "1" }),
        resourceLimits: RESOURCE_LIMITS,
        ttlExpiresAt: new Date(),
        instanceId,
      });

      const rows = await store.listContainersForTask(taskId);
      expect(rows.map((r) => r.dockerId)).toEqual(["child", "task"]);
      expect(rows.map((r) => r.depth)).toEqual([1, 0]);
    });

    it("supports the parent_id self-reference", async () => {
      const instanceId = await seedInstance();
      const parentId = await insertTaskContainer({ instanceId, dockerId: "parent" });
      const childId = await insertTaskContainer({
        instanceId,
        dockerId: "child",
        parentId,
        depth: 1,
      });
      const child = await store.getContainer(childId);
      expect(child?.parentId).toBe(parentId);
    });

    it("rejects an instanceId that does not exist (FK constraint)", async () => {
      await expect(
        insertTaskContainer({ instanceId: "019d0000-0000-7000-8000-0000000000ff" }),
      ).rejects.toThrow();
    });
  });

  describe("networks", () => {
    it("inserts a network with status='created' and parsed JSONB labels", async () => {
      const instanceId = await seedInstance();
      const row = await store.insertNetwork({
        dockerId: "net-abc",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date("2026-04-26T00:00:00Z"),
        instanceId,
      });
      expect(row.dockerId).toBe("net-abc");
      expect(row.status).toBe("created");
      expect(row.depth).toBe(0);
      expect(row.labels["cogmo.managed"]).toBe("true");
    });

    it("rejects malformed labels at the store boundary", async () => {
      const instanceId = await seedInstance();
      await expect(
        store.insertNetwork({
          dockerId: "net-bad",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
          labels: { "cogmo.depth": 0 } as any,
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      ).rejects.toThrow();
    });

    it("rejects malformed labels via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const row = await store.insertNetwork({
        dockerId: "net-corrupt",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await db.execute(
        sql`UPDATE networks SET labels = '{"junk":true}'::jsonb WHERE id = ${row.id}`,
      );
      await expect(store.getNetwork(row.id)).rejects.toThrow();
    });

    it("enforces unique docker_id", async () => {
      const instanceId = await seedInstance();
      await store.insertNetwork({
        dockerId: "dup-net",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await expect(
        store.insertNetwork({
          dockerId: "dup-net",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      ).rejects.toThrow();
    });

    it("updateNetworkStatus marks reaped", async () => {
      const instanceId = await seedInstance();
      const row = await store.insertNetwork({
        dockerId: "net-1",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await store.updateNetworkStatus({ id: row.id, status: "reaped" });
      const reloaded = await store.getNetwork(row.id);
      expect(reloaded?.status).toBe("reaped");
    });

    it("getNetworkByDockerId returns the row", async () => {
      const instanceId = await seedInstance();
      await store.insertNetwork({
        dockerId: "lookup-net",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      const row = await store.getNetworkByDockerId("lookup-net");
      expect(row?.dockerId).toBe("lookup-net");
    });

    it("listNetworksForTask returns rows depth DESC", async () => {
      const instanceId = await seedInstance();
      const taskId = "019d0000-0000-7000-8000-000000000020";
      const parentId = await insertTaskContainer({ instanceId, rootTaskId: taskId });
      await store.insertNetwork({
        dockerId: "n-root",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await store.insertNetwork({
        dockerId: "n-child",
        parentId,
        rootTaskId: taskId,
        depth: 1,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      const rows = await store.listNetworksForTask(taskId);
      expect(rows.map((r) => r.dockerId)).toEqual(["n-child", "n-root"]);
    });

    it("listNetworksForInstance scopes by instance", async () => {
      const instA = await seedInstance();
      const instB = (await store.insertInstance({ host: "b", pid: 2 })).id;
      await store.insertNetwork({
        dockerId: "n-a",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId: instA,
      });
      await store.insertNetwork({
        dockerId: "n-b",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId: instB,
      });
      expect((await store.listNetworksForInstance(instA)).map((r) => r.dockerId)).toEqual(["n-a"]);
      expect((await store.listNetworksForInstance(instB)).map((r) => r.dockerId)).toEqual(["n-b"]);
    });
  });

  describe("volumes", () => {
    it("inserts a volume with status='created' and parsed JSONB labels", async () => {
      const instanceId = await seedInstance();
      const row = await store.insertVolume({
        dockerId: "vol-abc",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date("2026-04-26T00:00:00Z"),
        instanceId,
      });
      expect(row.dockerId).toBe("vol-abc");
      expect(row.status).toBe("created");
      expect(row.labels["cogmo.managed"]).toBe("true");
    });

    it("enforces unique docker_id", async () => {
      const instanceId = await seedInstance();
      await store.insertVolume({
        dockerId: "dup-vol",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await expect(
        store.insertVolume({
          dockerId: "dup-vol",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      ).rejects.toThrow();
    });

    it("rejects malformed labels via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const row = await store.insertVolume({
        dockerId: "vol-corrupt",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await db.execute(
        sql`UPDATE volumes SET labels = '{"junk":true}'::jsonb WHERE id = ${row.id}`,
      );
      await expect(store.getVolume(row.id)).rejects.toThrow();
    });

    it("updateVolumeStatus + lookups round-trip", async () => {
      const instanceId = await seedInstance();
      const row = await store.insertVolume({
        dockerId: "v-1",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await store.updateVolumeStatus({ id: row.id, status: "reaped" });
      expect((await store.getVolume(row.id))?.status).toBe("reaped");
      expect((await store.getVolumeByDockerId("v-1"))?.id).toBe(row.id);
    });

    it("listVolumesForTask returns rows depth DESC", async () => {
      const instanceId = await seedInstance();
      const taskId = "019d0000-0000-7000-8000-000000000030";
      const parentId = await insertTaskContainer({ instanceId, rootTaskId: taskId });
      await store.insertVolume({
        dockerId: "v-root",
        parentId: null,
        rootTaskId: taskId,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      await store.insertVolume({
        dockerId: "v-child",
        parentId,
        rootTaskId: taskId,
        depth: 1,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId,
      });
      const rows = await store.listVolumesForTask(taskId);
      expect(rows.map((r) => r.dockerId)).toEqual(["v-child", "v-root"]);
    });

    it("listVolumesForInstance scopes by instance", async () => {
      const instA = await seedInstance();
      const instB = (await store.insertInstance({ host: "b", pid: 2 })).id;
      await store.insertVolume({
        dockerId: "v-a",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId: instA,
      });
      await store.insertVolume({
        dockerId: "v-b",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(),
        instanceId: instB,
      });
      expect((await store.listVolumesForInstance(instA)).map((r) => r.dockerId)).toEqual(["v-a"]);
      expect((await store.listVolumesForInstance(instB)).map((r) => r.dockerId)).toEqual(["v-b"]);
    });
  });
});
