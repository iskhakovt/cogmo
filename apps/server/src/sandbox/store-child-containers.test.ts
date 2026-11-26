/**
 * `storeChildContainers`'s own mapping: each port method over its use case,
 * a result passed through, and a store failure as the value the port names.
 * The rows each use case leaves are their own suites' (`mark-child-*`,
 * `insert-child-container`, `reconcile-child-containers`). It runs against
 * the sandbox store on PGlite, with the daemon stubbed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import type { ChildRecord, TaskContainerRow } from "./proxy/index.js";
import { DrizzleSandboxStore } from "./store/index.js";
import { storeChildContainers } from "./store-child-containers.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";
const LIMITS = { cpus: 1, memory_bytes: 256 * 1024 * 1024, pids: 64 };
const TTL = new Date("2026-12-01T00:00:00.000Z");

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

function stubDocker(): DockerFacade {
  const container = mock<DockerContainer>();
  container.kill.mockResolvedValue(undefined);
  container.remove.mockResolvedValue(undefined);
  container.inspect.mockResolvedValue({ State: { Status: "running" } });
  const docker = mock<DockerFacade>();
  docker.getContainer.mockReturnValue(container);
  return docker;
}

/** A store whose every transaction fails, as a lost connection would. */
const cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
const failing: Transactor = () => Promise.reject(cause);

const ROW: TaskContainerRow = {
  id: "019d0000-0000-7000-8000-00000000c001",
  dockerId: "child-container",
  parentId: "019d0000-0000-7000-8000-00000000bbbb",
  depth: 1,
  status: "starting",
};

async function startingChild(): Promise<{ row: TaskContainerRow; child: ChildRecord }> {
  const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
  const child: ChildRecord = {
    dockerId: "child-container",
    parentId: "019d0000-0000-7000-8000-00000000bbbb",
    rootTaskId: TASK_ID,
    depth: 1,
    image: "alpine",
    runtime: "runc",
    labels: {},
    resourceLimits: LIMITS,
    ttlExpiresAt: TTL,
    instanceId: instance.id,
  };
  const inserted = await tx((trx) => store.insertContainer(trx, { ...child, parentId: null }));
  // A further child of the same task, under the row just inserted.
  return {
    row: { ...ROW, id: inserted.id, parentId: null },
    child: { ...child, parentId: inserted.id },
  };
}

describe("storeChildContainers", () => {
  it("records a child as a value, and an insert the store fails as record_failed", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const { child } = await startingChild();

    const deadline = new AbortController().signal;
    expect((await children.record({ ...child, dockerId: "second-child" }, deadline)).isOk()).toBe(
      true,
    );
    const refused = await children.record(
      { ...child, dockerId: "third-child", instanceId: "019d0000-0000-7000-8000-000000000bad" },
      deadline,
    );
    expect(refused._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
  });

  it("passes a start's outcome through", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const { row } = await startingChild();

    expect((await children.started(row))._unsafeUnwrap()).toEqual({ kind: "started" });
  });

  it("passes a removal and a reconcile through", async () => {
    const children = storeChildContainers({ store, runInTx: tx, docker: stubDocker() });
    const { row } = await startingChild();

    expect((await children.reconcile([row]))._unsafeUnwrap()).toEqual([row]);
    expect((await children.removed(row)).isOk()).toBe(true);
    expect((await tx((trx) => store.getContainer(trx, row.id)))?.status).toBe("exited");
  });

  it.each([
    ["a start", (children: ReturnType<typeof storeChildContainers>) => children.started(ROW)],
    ["a removal", (children: ReturnType<typeof storeChildContainers>) => children.removed(ROW)],
  ])("is store_failed, with the cause, when %s's write throws", async (_label, call) => {
    const children = storeChildContainers({ store, runInTx: failing, docker: stubDocker() });

    expect((await call(children))._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });
});
