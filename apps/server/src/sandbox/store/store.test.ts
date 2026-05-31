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
  store = new DrizzleSandboxStore();
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
  return (await tx((trx) => store.insertInstance(trx, { host: "test-host", pid: 42 }))).id;
}

async function insertTaskContainer(opts: {
  instanceId: string;
  rootTaskId?: string;
  dockerId?: string;
  parentId?: string | null;
  depth?: number;
}): Promise<string> {
  const row = await tx((trx) =>
    store.insertContainer(trx, {
      dockerId: opts.dockerId ?? `docker-${Math.random().toString(36).slice(2)}`,
      parentId: opts.parentId ?? null,
      rootTaskId: opts.rootTaskId ?? TASK_ID,
      depth: opts.depth ?? 0,
      image: "cogmo/devbase:test",
      runtime: "sysbox-runc",
      labels: labels(),
      resourceLimits: RESOURCE_LIMITS,
      ttlExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      instanceId: opts.instanceId,
    }),
  );
  return row.id;
}

describe("DrizzleSandboxStore", () => {
  describe("instances", () => {
    it("inserts an instance with stoppedAt null", async () => {
      const inst = await tx((trx) => store.insertInstance(trx, { host: "host-1", pid: 1234 }));
      expect(inst.host).toBe("host-1");
      expect(inst.pid).toBe(1234);
      expect(inst.stoppedAt).toBeNull();
      expect(inst.createdAt).toBeInstanceOf(Date);
    });

    it("closeInstance sets stoppedAt", async () => {
      const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
      await tx((trx) => store.closeInstance(trx, inst.id));
      const reloaded = await tx((trx) => store.getInstance(trx, inst.id));
      expect(reloaded?.stoppedAt).toBeInstanceOf(Date);
    });

    it("listLiveInstances excludes stopped instances", async () => {
      const a = await tx((trx) => store.insertInstance(trx, { host: "a", pid: 1 }));
      const b = await tx((trx) => store.insertInstance(trx, { host: "b", pid: 2 }));
      await tx((trx) => store.closeInstance(trx, a.id));
      const live = await tx((trx) => store.listLiveInstances(trx));
      expect(live.map((i) => i.id)).toEqual([b.id]);
    });

    it("getInstance returns null for unknown id", async () => {
      expect(
        await tx((trx) => store.getInstance(trx, "019d0000-0000-7000-8000-000000000099")),
      ).toBeUndefined();
    });
  });

  describe("containers", () => {
    it("inserts a container with starting status and parsed JSONB", async () => {
      const instanceId = await seedInstance();
      const row = await tx((trx) =>
        store.insertContainer(trx, {
          dockerId: "abc123",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          image: "cogmo/devbase:test",
          runtime: "sysbox-runc",
          labels: labels(),
          resourceLimits: RESOURCE_LIMITS,
          ttlExpiresAt: new Date("2026-04-26T00:00:00Z"),
          instanceId,
        }),
      );
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
        tx((trx) =>
          store.insertContainer(trx, {
            dockerId: "bad",
            parentId: null,
            rootTaskId: TASK_ID,
            depth: 0,
            image: "img",
            runtime: "runc",
            labels: { "cogmo.depth": 0 } as any,
            resourceLimits: RESOURCE_LIMITS,
            ttlExpiresAt: new Date(),
            instanceId,
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects malformed resourceLimits at the store boundary", async () => {
      const instanceId = await seedInstance();
      await expect(
        tx((trx) =>
          store.insertContainer(trx, {
            dockerId: "bad",
            parentId: null,
            rootTaskId: TASK_ID,
            depth: 0,
            image: "img",
            runtime: "runc",
            labels: labels(),
            resourceLimits: { cpus: -1, memory_bytes: 1, pids: 1 } as any,
            ttlExpiresAt: new Date(),
            instanceId,
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects malformed labels via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const id = await insertTaskContainer({ instanceId });
      await db.execute(sql`UPDATE containers SET labels = '{"junk":true}'::jsonb WHERE id = ${id}`);
      await expect(tx((trx) => store.getContainer(trx, id))).rejects.toThrow();
    });

    it("rejects malformed resourceLimits via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const id = await insertTaskContainer({ instanceId });
      await db.execute(
        sql`UPDATE containers SET resource_limits = '{"junk":true}'::jsonb WHERE id = ${id}`,
      );
      await expect(tx((trx) => store.getContainer(trx, id))).rejects.toThrow();
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
      await tx((trx) => store.updateContainerStatus(trx, { id, status: "running", startedAt }));
      let row = await tx((trx) => store.getContainer(trx, id));
      expect(row?.status).toBe("running");
      expect(row?.startedAt?.toISOString()).toBe(startedAt.toISOString());

      const exitedAt = new Date("2026-04-25T10:05:00Z");
      await tx((trx) =>
        store.updateContainerStatus(trx, { id, status: "exited", exitCode: 0, exitedAt }),
      );
      row = await tx((trx) => store.getContainer(trx, id));
      expect(row?.status).toBe("exited");
      expect(row?.exitCode).toBe(0);
      expect(row?.exitedAt?.toISOString()).toBe(exitedAt.toISOString());
    });

    it("getContainerByDockerId returns the row", async () => {
      const instanceId = await seedInstance();
      await insertTaskContainer({ instanceId, dockerId: "lookup-me" });
      const row = await tx((trx) => store.getContainerByDockerId(trx, "lookup-me"));
      expect(row?.dockerId).toBe("lookup-me");
    });

    it("getContainer returns null for unknown id", async () => {
      expect(
        await tx((trx) => store.getContainer(trx, "019d0000-0000-7000-8000-000000000099")),
      ).toBeUndefined();
    });

    it("listContainersForInstance returns all rows for the instance, ordered by createdAt", async () => {
      const instA = await seedInstance();
      const instB = (await tx((trx) => store.insertInstance(trx, { host: "b", pid: 2 }))).id;
      await insertTaskContainer({ instanceId: instA, dockerId: "a1" });
      await insertTaskContainer({ instanceId: instA, dockerId: "a2" });
      await insertTaskContainer({ instanceId: instB, dockerId: "b1" });

      const rowsA = await tx((trx) => store.listContainersForInstance(trx, instA));
      expect(rowsA.map((r) => r.dockerId)).toEqual(["a1", "a2"]);
      const rowsB = await tx((trx) => store.listContainersForInstance(trx, instB));
      expect(rowsB.map((r) => r.dockerId)).toEqual(["b1"]);
    });

    it("listContainersForTask returns rows in cascade order (depth DESC: children first)", async () => {
      const instanceId = await seedInstance();
      const taskId = "019d0000-0000-7000-8000-000000000010";
      const taskContainer = await tx((trx) =>
        store.insertContainer(trx, {
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
        }),
      );
      await tx((trx) =>
        store.insertContainer(trx, {
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
        }),
      );

      const rows = await tx((trx) => store.listContainersForTask(trx, taskId));
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
      const child = await tx((trx) => store.getContainer(trx, childId));
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
      const row = await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "net-abc",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date("2026-04-26T00:00:00Z"),
          instanceId,
        }),
      );
      expect(row.dockerId).toBe("net-abc");
      expect(row.status).toBe("created");
      expect(row.depth).toBe(0);
      expect(row.labels["cogmo.managed"]).toBe("true");
    });

    it("rejects malformed labels at the store boundary", async () => {
      const instanceId = await seedInstance();
      await expect(
        tx((trx) =>
          store.insertNetwork(trx, {
            dockerId: "net-bad",
            parentId: null,
            rootTaskId: TASK_ID,
            depth: 0,
            labels: { "cogmo.depth": 0 } as any,
            ttlExpiresAt: new Date(),
            instanceId,
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects malformed labels via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const row = await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "net-corrupt",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await db.execute(
        sql`UPDATE networks SET labels = '{"junk":true}'::jsonb WHERE id = ${row.id}`,
      );
      await expect(tx((trx) => store.getNetwork(trx, row.id))).rejects.toThrow();
    });

    it("enforces unique docker_id", async () => {
      const instanceId = await seedInstance();
      await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "dup-net",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await expect(
        tx((trx) =>
          store.insertNetwork(trx, {
            dockerId: "dup-net",
            parentId: null,
            rootTaskId: TASK_ID,
            depth: 0,
            labels: labels(),
            ttlExpiresAt: new Date(),
            instanceId,
          }),
        ),
      ).rejects.toThrow();
    });

    it("updateNetworkStatus marks reaped", async () => {
      const instanceId = await seedInstance();
      const row = await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "net-1",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await tx((trx) => store.updateNetworkStatus(trx, { id: row.id, status: "reaped" }));
      const reloaded = await tx((trx) => store.getNetwork(trx, row.id));
      expect(reloaded?.status).toBe("reaped");
    });

    it("getNetworkByDockerId returns the row", async () => {
      const instanceId = await seedInstance();
      await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "lookup-net",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      const row = await tx((trx) => store.getNetworkByDockerId(trx, "lookup-net"));
      expect(row?.dockerId).toBe("lookup-net");
    });

    it("listNetworksForTask returns rows depth DESC", async () => {
      const instanceId = await seedInstance();
      const taskId = "019d0000-0000-7000-8000-000000000020";
      const parentId = await insertTaskContainer({ instanceId, rootTaskId: taskId });
      await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "n-root",
          parentId: null,
          rootTaskId: taskId,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "n-child",
          parentId,
          rootTaskId: taskId,
          depth: 1,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      const rows = await tx((trx) => store.listNetworksForTask(trx, taskId));
      expect(rows.map((r) => r.dockerId)).toEqual(["n-child", "n-root"]);
    });

    it("listNetworksForInstance scopes by instance", async () => {
      const instA = await seedInstance();
      const instB = (await tx((trx) => store.insertInstance(trx, { host: "b", pid: 2 }))).id;
      await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "n-a",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId: instA,
        }),
      );
      await tx((trx) =>
        store.insertNetwork(trx, {
          dockerId: "n-b",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId: instB,
        }),
      );
      expect(
        (await tx((trx) => store.listNetworksForInstance(trx, instA))).map((r) => r.dockerId),
      ).toEqual(["n-a"]);
      expect(
        (await tx((trx) => store.listNetworksForInstance(trx, instB))).map((r) => r.dockerId),
      ).toEqual(["n-b"]);
    });
  });

  describe("volumes", () => {
    it("inserts a volume with status='created' and parsed JSONB labels", async () => {
      const instanceId = await seedInstance();
      const row = await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "vol-abc",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date("2026-04-26T00:00:00Z"),
          instanceId,
        }),
      );
      expect(row.dockerId).toBe("vol-abc");
      expect(row.status).toBe("created");
      expect(row.labels["cogmo.managed"]).toBe("true");
    });

    it("enforces unique docker_id", async () => {
      const instanceId = await seedInstance();
      await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "dup-vol",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await expect(
        tx((trx) =>
          store.insertVolume(trx, {
            dockerId: "dup-vol",
            parentId: null,
            rootTaskId: TASK_ID,
            depth: 0,
            labels: labels(),
            ttlExpiresAt: new Date(),
            instanceId,
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects malformed labels via raw SQL on read", async () => {
      const instanceId = await seedInstance();
      const row = await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "vol-corrupt",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await db.execute(
        sql`UPDATE volumes SET labels = '{"junk":true}'::jsonb WHERE id = ${row.id}`,
      );
      await expect(tx((trx) => store.getVolume(trx, row.id))).rejects.toThrow();
    });

    it("updateVolumeStatus + lookups round-trip", async () => {
      const instanceId = await seedInstance();
      const row = await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "v-1",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await tx((trx) => store.updateVolumeStatus(trx, { id: row.id, status: "reaped" }));
      expect((await tx((trx) => store.getVolume(trx, row.id)))?.status).toBe("reaped");
      expect((await tx((trx) => store.getVolumeByDockerId(trx, "v-1")))?.id).toBe(row.id);
    });

    it("listVolumesForTask returns rows depth DESC", async () => {
      const instanceId = await seedInstance();
      const taskId = "019d0000-0000-7000-8000-000000000030";
      const parentId = await insertTaskContainer({ instanceId, rootTaskId: taskId });
      await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "v-root",
          parentId: null,
          rootTaskId: taskId,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "v-child",
          parentId,
          rootTaskId: taskId,
          depth: 1,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId,
        }),
      );
      const rows = await tx((trx) => store.listVolumesForTask(trx, taskId));
      expect(rows.map((r) => r.dockerId)).toEqual(["v-child", "v-root"]);
    });

    it("listVolumesForInstance scopes by instance", async () => {
      const instA = await seedInstance();
      const instB = (await tx((trx) => store.insertInstance(trx, { host: "b", pid: 2 }))).id;
      await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "v-a",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId: instA,
        }),
      );
      await tx((trx) =>
        store.insertVolume(trx, {
          dockerId: "v-b",
          parentId: null,
          rootTaskId: TASK_ID,
          depth: 0,
          labels: labels(),
          ttlExpiresAt: new Date(),
          instanceId: instB,
        }),
      );
      expect(
        (await tx((trx) => store.listVolumesForInstance(trx, instA))).map((r) => r.dockerId),
      ).toEqual(["v-a"]);
      expect(
        (await tx((trx) => store.listVolumesForInstance(trx, instB))).map((r) => r.dockerId),
      ).toEqual(["v-b"]);
    });
  });
});
