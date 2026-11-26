import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { listOwnedContainers } from "./list-owned-containers.js";
import { DrizzleSandboxStore } from "./store/index.js";

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
  depth: number;
}): Promise<string> {
  const inserted = await tx((trx) =>
    store.insertContainer(trx, {
      ...row,
      parentId: null,
      image: "cogmo/devbase:test",
      runtime: "sysbox-runc",
      labels: { "cogmo.root_task": row.rootTaskId },
      resourceLimits: { cpus: 1, memory_bytes: 1024 ** 3, pids: 128 },
      ttlExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  );
  return inserted.id;
}

describe("listOwnedContainers", () => {
  it("lists the task's rows in every state but reaped", async () => {
    const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const instanceId = instance.id;
    await insert({ instanceId, dockerId: "task-container", rootTaskId: TASK_ID, depth: 0 });
    const running = await insert({
      instanceId,
      dockerId: "running",
      rootTaskId: TASK_ID,
      depth: 1,
    });
    const exited = await insert({ instanceId, dockerId: "exited", rootTaskId: TASK_ID, depth: 1 });
    const reaped = await insert({ instanceId, dockerId: "reaped", rootTaskId: TASK_ID, depth: 1 });
    await insert({ instanceId, dockerId: "sibling", rootTaskId: OTHER_TASK_ID, depth: 0 });
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

    const owned = await listOwnedContainers({ store, runInTx: tx }, TASK_ID);

    expect([...owned].sort((a, b) => a.dockerId.localeCompare(b.dockerId))).toEqual([
      { dockerId: "exited", depth: 1 },
      { dockerId: "running", depth: 1 },
      { dockerId: "task-container", depth: 0 },
    ]);
  });

  it("lists nothing for a task with no rows", async () => {
    expect(await listOwnedContainers({ store, runInTx: tx }, TASK_ID)).toEqual([]);
  });
});
