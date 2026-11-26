/**
 * `storeChildContainers` as a deliberate cross-module test: the adapter
 * over its use cases and the sandbox store on PGlite, unmocked, with only
 * the daemon stubbed, so each port method is checked for the rows it
 * leaves behind.
 */

import { match } from "ts-pattern";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import type { TaskContainerRow } from "./proxy/index.js";
import { DrizzleSandboxStore } from "./store/index.js";
import { storeChildContainers } from "./store-child-containers.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSandboxStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

function stubDocker(): DockerFacade {
  const container = mock<DockerContainer>();
  container.kill.mockResolvedValue(undefined);
  container.remove.mockResolvedValue(undefined);
  const docker = mock<DockerFacade>();
  docker.getContainer.mockReturnValue(container);
  return docker;
}

/** A child row, moved to `status` through the store's own transitions. */
async function child(status: TaskContainerRow["status"]): Promise<TaskContainerRow> {
  const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
  const row = await tx((trx) =>
    store.insertContainer(trx, {
      dockerId: "child-container",
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
  const at = new Date();
  await match(status)
    .with("starting", async () => undefined)
    .with("running", "exited", (to) =>
      tx((trx) => store.transitionContainerStatus(trx, { id: row.id, at, from: "starting", to })),
    )
    .exhaustive();
  return { id: row.id, dockerId: row.dockerId, parentId: row.parentId, status };
}

describe("storeChildContainers", () => {
  it.each(["starting", "running"] as const)(
    "moves a %s child the task removed to exited",
    async (status) => {
      const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
      const row = await child(status);

      const removed = await children.removed(row);

      expect(removed.isOk()).toBe(true);
      expect((await tx((trx) => store.getContainer(trx, row.id)))?.status).toBe("exited");
    },
  );

  it("moves a removed child to exited from running when a start moved it after the ownership read", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const read = await child("starting");
    await tx((trx) =>
      store.transitionContainerStatus(trx, {
        id: read.id,
        at: new Date(),
        from: "starting",
        to: "running",
      }),
    );

    const removed = await children.removed(read);

    expect(removed.isOk()).toBe(true);
    expect((await tx((trx) => store.getContainer(trx, read.id)))?.status).toBe("exited");
  });

  it("writes exited_at and leaves started_at null for a child removed before it started", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const row = await child("starting");

    await children.removed(row);

    const after = await tx((trx) => store.getContainer(trx, row.id));
    expect(after?.exitedAt).toBeInstanceOf(Date);
    expect(after?.startedAt).toBeNull();
  });

  it("leaves a removed child that a reap finished first reaped", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const read = await child("running");
    await tx((trx) =>
      store.transitionContainerStatus(trx, {
        id: read.id,
        at: new Date(),
        to: "reaped",
        reason: "cascade",
      }),
    );

    const removed = await children.removed(read);

    expect(removed.isOk()).toBe(true);
    expect(await tx((trx) => store.getContainer(trx, read.id))).toMatchObject({
      status: "reaped",
      reapedReason: "cascade",
    });
  });

  it("lets a start that finds its row stale while still starting reject, as the bug it is", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const row = await child("starting");
    vi.spyOn(store, "transitionContainerStatus").mockResolvedValueOnce({
      kind: "stale",
      status: "starting",
    });

    await expect(children.started(row)).rejects.toThrow(/stale/);
  });

  it("writes nothing for a removed child whose row is already exited", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const row = await child("exited");
    const transition = vi.spyOn(store, "transitionContainerStatus");

    const removed = await children.removed(row);

    expect(removed.isOk()).toBe(true);
    expect(transition).not.toHaveBeenCalled();
  });

  it("is store_failed, with the cause, when a removal's write throws", async () => {
    const cause = new Error("connection reset");
    const failing: Transactor = () => Promise.reject(cause);
    const children = storeChildContainers({ store, runInTx: failing, docker: stubDocker() });

    const removed = await children.removed({
      id: "019d0000-0000-7000-8000-00000000c001",
      dockerId: "child-container",
      parentId: null,
      status: "running",
    });

    expect(removed._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });

  it("is store_failed, with the cause, when a start's write throws", async () => {
    const cause = new Error("connection reset");
    const failing: Transactor = () => Promise.reject(cause);
    const children = storeChildContainers({ store, runInTx: failing, docker: stubDocker() });

    const started = await children.started({
      id: "019d0000-0000-7000-8000-00000000c001",
      dockerId: "child-container",
      parentId: null,
      status: "starting",
    });

    expect(started._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });

  it("starts a child's row and records a child as values", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const row = await child("starting");

    expect((await children.started(row))._unsafeUnwrap()).toEqual({ kind: "running" });
    const recorded = await children.record({
      dockerId: "second-child",
      parentId: row.id,
      rootTaskId: TASK_ID,
      depth: 1,
      image: "alpine",
      runtime: "runc",
      labels: {},
      resourceLimits: { cpus: 1, memory_bytes: 256 * 1024 * 1024, pids: 64 },
      ttlExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
      instanceId: "019d0000-0000-7000-8000-000000000bad",
    });
    expect(recorded._unsafeUnwrapErr().kind).toBe("record_failed");
  });
});
