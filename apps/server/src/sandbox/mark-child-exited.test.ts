import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { markChildExited } from "./mark-child-exited.js";
import type { TaskContainerRow } from "./proxy/index.js";
import {
  type ContainerTransitionResult,
  DrizzleSandboxStore,
  type SandboxStore,
} from "./store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const AT = new Date("2026-11-26T12:00:00Z");

function childIn(status: TaskContainerRow["status"]): TaskContainerRow {
  return { id: "row-1", dockerId: "c1", parentId: "parent-row", depth: 1, status };
}

describe("markChildExited", () => {
  it("moves a child from the status it was read in", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus.mockResolvedValue({ kind: "transitioned" });

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("running"), cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "row-1",
      from: "running",
      to: "exited",
      at: AT,
    });
  });

  it("runs once more from running when a start moved the row after it was read", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus
      .mockResolvedValueOnce({ kind: "stale", status: "running" })
      .mockResolvedValueOnce({ kind: "transitioned" });

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("starting"), cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect(store.transitionContainerStatus).toHaveBeenCalledTimes(2);
    expect(store.transitionContainerStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ from: "running", to: "exited" }),
    );
  });

  it.each(["exited", "reaped"] as const)(
    "writes nothing more for a row another path moved to %s",
    async (status) => {
      const store = mock<SandboxStore>();
      store.transitionContainerStatus.mockResolvedValue({ kind: "stale", status });

      const exited = await markChildExited(
        { store, runInTx: fakeRunInTx },
        { child: childIn("starting"), cause: "missing_from_daemon", at: AT },
      );

      expect(exited.isOk()).toBe(true);
      expect(store.transitionContainerStatus).toHaveBeenCalledTimes(1);
    },
  );

  it("writes nothing for a child read as exited", async () => {
    const store = mock<SandboxStore>();

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("exited"), cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });

  it("is store_failed, with the cause, when the write throws", async () => {
    const store = mock<SandboxStore>();
    const cause = new Error("connection reset");
    store.transitionContainerStatus.mockRejectedValue(cause);

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("running"), cause: "removed_by_task", at: AT },
    );

    expect(exited._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });

  it("rejects, as the bug it is, a transition outcome the store never returns", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus.mockResolvedValue({
      kind: "unexpected",
    } as unknown as ContainerTransitionResult);

    await expect(
      markChildExited(
        { store, runInTx: fakeRunInTx },
        { child: childIn("running"), cause: "removed_by_task", at: AT },
      ),
    ).rejects.toThrow();
  });
});

describe("markChildExited on the store", () => {
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

  /** A child row in `starting`, as its ownership check read it. */
  async function startingChild(): Promise<TaskContainerRow> {
    const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
    const row = await tx((trx) =>
      store.insertContainer(trx, {
        dockerId: "child-container",
        parentId: null,
        rootTaskId: "019d0000-0000-7000-8000-000000000001",
        depth: 1,
        image: "alpine",
        runtime: "runc",
        labels: {},
        resourceLimits: { cpus: 1, memory_bytes: 256 * 1024 * 1024, pids: 64 },
        ttlExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
        instanceId: instance.id,
      }),
    );
    return { id: row.id, dockerId: row.dockerId, parentId: null, depth: 1, status: "starting" };
  }

  it("writes exited_at and leaves started_at null for a child removed before it started", async () => {
    const child = await startingChild();

    await markChildExited({ store, runInTx: tx }, { child, cause: "removed_by_task", at: AT });

    expect(await tx((trx) => store.getContainer(trx, child.id))).toMatchObject({
      status: "exited",
      exitedAt: AT,
      startedAt: null,
    });
  });

  it("lands on exited when a start moved the row to running after the read", async () => {
    const child = await startingChild();
    await tx((trx) =>
      store.transitionContainerStatus(trx, {
        id: child.id,
        at: AT,
        from: "starting",
        to: "running",
      }),
    );

    const exited = await markChildExited(
      { store, runInTx: tx },
      { child, cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect((await tx((trx) => store.getContainer(trx, child.id)))?.status).toBe("exited");
  });

  it("leaves a row a reap finished first reaped", async () => {
    const child = await startingChild();
    await tx((trx) =>
      store.transitionContainerStatus(trx, {
        id: child.id,
        at: AT,
        to: "reaped",
        reason: "cascade",
      }),
    );

    const exited = await markChildExited(
      { store, runInTx: tx },
      { child, cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect(await tx((trx) => store.getContainer(trx, child.id))).toMatchObject({
      status: "reaped",
      reapedReason: "cascade",
    });
  });
});
