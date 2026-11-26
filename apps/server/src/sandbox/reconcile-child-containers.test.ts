import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { expectOk } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import type { TaskContainerRow } from "./proxy/index.js";
import { reconcileChildContainers } from "./reconcile-child-containers.js";
import { DrizzleSandboxStore } from "./store/index.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSandboxStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

/**
 * A daemon whose inspect of each id answers as `answers` says: an HTTP
 * error status, or the container's state; any other id is running.
 */
function daemonAnswering(answers: Readonly<Record<string, number | "exited">>): DockerFacade {
  const docker = mock<DockerFacade>();
  docker.getContainer.mockImplementation((id) => {
    const container = mock<DockerContainer>();
    const status = answers[id];
    if (typeof status === "number") {
      container.inspect.mockRejectedValue(
        Object.assign(new Error(`daemon ${status}`), { statusCode: status }),
      );
    } else {
      container.inspect.mockResolvedValue({ State: { Status: status ?? "running" } });
    }
    return container;
  });
  return docker;
}

async function child(dockerId: string): Promise<TaskContainerRow> {
  const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
  const row = await tx((trx) =>
    store.insertContainer(trx, {
      dockerId,
      parentId: null,
      rootTaskId: TASK_ID,
      depth: 1,
      image: "alpine",
      runtime: "runc",
      labels: {},
      resourceLimits: { cpus: 1, memory_bytes: 256 * 1024 * 1024, pids: 64 },
      ttlExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
      instanceId: instance.id,
    }),
  );
  return { id: row.id, dockerId, parentId: row.parentId, depth: 1, status: "starting" };
}

describe("reconcileChildContainers", () => {
  it("keeps the children the daemon has and moves the ones it answers 404 for to exited", async () => {
    const present = await child("present");
    const removed = await child("auto-removed");
    const docker = daemonAnswering({ "auto-removed": 404 });

    const live = expectOk(
      await reconcileChildContainers({ store, runInTx: tx, docker }, [present, removed]),
    );

    expect(live).toEqual([present]);
    expect((await tx((trx) => store.getContainer(trx, removed.id)))?.status).toBe("exited");
    expect((await tx((trx) => store.getContainer(trx, present.id)))?.status).toBe("starting");
  });

  it("moves a child the daemon lost to exited, freeing its place, though a start moved its row after the read", async () => {
    const read = await child("auto-removed");
    await tx((trx) =>
      store.transitionContainerStatus(trx, {
        id: read.id,
        at: new Date(),
        from: "starting",
        to: "running",
      }),
    );
    const docker = daemonAnswering({ "auto-removed": 404 });

    const live = expectOk(await reconcileChildContainers({ store, runInTx: tx, docker }, [read]));

    expect(live).toEqual([]);
    expect((await tx((trx) => store.getContainer(trx, read.id)))?.status).toBe("exited");
  });

  it("keeps a child that exited but was not removed, and its place", async () => {
    const stopped = await child("stopped");
    const docker = daemonAnswering({ stopped: "exited" });

    const live = expectOk(
      await reconcileChildContainers({ store, runInTx: tx, docker }, [stopped]),
    );

    expect(live).toEqual([stopped]);
    expect((await tx((trx) => store.getContainer(trx, stopped.id)))?.status).toBe("starting");
  });

  it("counts a child whose inspect fails otherwise as live, writing nothing", async () => {
    const unsure = await child("unsure");
    const docker = daemonAnswering({ unsure: 500 });

    const live = expectOk(await reconcileChildContainers({ store, runInTx: tx, docker }, [unsure]));

    expect(live).toEqual([unsure]);
    expect((await tx((trx) => store.getContainer(trx, unsure.id)))?.status).toBe("starting");
  });

  it("is store_failed when the exited write throws", async () => {
    const removed = await child("auto-removed");
    const cause = new Error("connection reset");
    const failing: Transactor = () => Promise.reject(cause);

    const live = await reconcileChildContainers(
      { store, runInTx: failing, docker: daemonAnswering({ "auto-removed": 404 }) },
      [removed],
    );

    expect(live._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });
});
