import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import { expectOk } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { DrizzleSandboxStore } from "./store/index.js";
import { storeContainerRows } from "./store-container-rows.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";
const OTHER_TASK_ID = "019d0000-0000-7000-8000-000000000002";

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

async function insert(row: {
  instanceId: string;
  dockerId: string;
  rootTaskId: string;
  parentId: string | null;
}): Promise<string> {
  const inserted = await tx((trx) =>
    store.insertContainer(trx, {
      ...row,
      depth: row.parentId === null ? 0 : 1,
      image: "cogmo/devbase:test",
      runtime: "sysbox-runc",
      labels: { "cogmo.root_task": row.rootTaskId },
      resourceLimits: { cpus: 1, memory_bytes: 1024 ** 3, pids: 128 },
      ttlExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  );
  return inserted.id;
}

describe("storeContainerRows", () => {
  it("lists the task's rows in every state but reaped, with their lineage and status", async () => {
    const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const instanceId = instance.id;
    const base = { instanceId, rootTaskId: TASK_ID };
    const task = await insert({ ...base, dockerId: "task-container", parentId: null });
    const running = await insert({ ...base, dockerId: "running", parentId: task });
    const exited = await insert({ ...base, dockerId: "exited", parentId: task });
    const reaped = await insert({ ...base, dockerId: "reaped", parentId: task });
    const salvage = await insert({ ...base, dockerId: "salvage", parentId: null });
    await insert({ instanceId, rootTaskId: OTHER_TASK_ID, dockerId: "sibling", parentId: null });
    const at = new Date();
    await tx(async (trx) => {
      await store.transitionContainerStatus(trx, {
        id: running,
        at,
        from: "starting",
        to: "running",
      });
      await store.transitionContainerStatus(trx, {
        id: exited,
        at,
        from: "starting",
        to: "exited",
      });
      await store.transitionContainerStatus(trx, {
        id: reaped,
        at,
        to: "reaped",
        reason: "ttl_expired",
      });
    });

    const rows = expectOk(await storeContainerRows({ store, runInTx: tx }).forTask(TASK_ID));

    expect([...rows].sort((a, b) => a.dockerId.localeCompare(b.dockerId))).toEqual([
      { id: exited, dockerId: "exited", parentId: task, depth: 1, status: "exited" },
      { id: running, dockerId: "running", parentId: task, depth: 1, status: "running" },
      { id: salvage, dockerId: "salvage", parentId: null, depth: 0, status: "starting" },
      { id: task, dockerId: "task-container", parentId: null, depth: 0, status: "starting" },
    ]);
  });

  it("lists nothing for a task with no rows", async () => {
    expect(expectOk(await storeContainerRows({ store, runInTx: tx }).forTask(TASK_ID))).toEqual([]);
  });

  it("answers store_failed, with the cause, when the store read rejects", async () => {
    const cause = new Error("connection refused");
    const failing: Transactor = () => Promise.reject(cause);

    const rows = await storeContainerRows({ store, runInTx: failing }).forTask(TASK_ID);

    expect(rows._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });
});
