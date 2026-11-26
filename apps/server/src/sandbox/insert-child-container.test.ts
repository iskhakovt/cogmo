import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import { insertChildContainer } from "./insert-child-container.js";
import type { ChildRecord } from "./proxy/index.js";
import { DrizzleSandboxStore } from "./store/index.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";
const TTL = new Date("2026-12-01T00:00:00.000Z");
const LIMITS = { cpus: 0.5, memory_bytes: 256 * 1024 * 1024, pids: 64 };

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

function stubDocker(): {
  docker: DockerFacade;
  container: ReturnType<typeof mock<DockerContainer>>;
} {
  const container = mock<DockerContainer>();
  container.kill.mockResolvedValue(undefined);
  container.remove.mockResolvedValue(undefined);
  const docker = mock<DockerFacade>();
  docker.getContainer.mockReturnValue(container);
  return { docker, container };
}

/** A cut-off that never aborts. */
const NO_CUT_OFF = new AbortController().signal;

/** No instance row has this id, so an insert naming it fails on its foreign key. */
const UNKNOWN_INSTANCE = "019d0000-0000-7000-8000-000000000bad";

/** A child of a fresh depth-0 row, under a fresh instance row. */
async function childOf(): Promise<ChildRecord> {
  const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
  const parent = await tx((trx) =>
    store.insertContainer(trx, {
      dockerId: "task-container",
      parentId: null,
      rootTaskId: TASK_ID,
      depth: 0,
      image: "devbase",
      runtime: "runc",
      labels: {},
      resourceLimits: LIMITS,
      ttlExpiresAt: TTL,
      instanceId: instance.id,
    }),
  );
  return {
    dockerId: "child-container",
    parentId: parent.id,
    rootTaskId: TASK_ID,
    depth: 1,
    image: "postgres:18-alpine",
    runtime: "runc",
    labels: { "cogmo.managed": "true", "cogmo.depth": "1" },
    resourceLimits: { cpus: 0.25, memory_bytes: 128 * 1024 * 1024, pids: 32 },
    ttlExpiresAt: TTL,
    instanceId: instance.id,
  };
}

describe("insertChildContainer", () => {
  it("inserts the child's row in starting with its lineage", async () => {
    const { docker, container } = stubDocker();
    const child = await childOf();

    const inserted = await insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF);

    expect(inserted.isOk()).toBe(true);
    const row = await tx((trx) => store.getContainerByDockerId(trx, "child-container"));
    expect(row).toMatchObject({ ...child, status: "starting", startedAt: null, exitedAt: null });
    expect(container.remove).not.toHaveBeenCalled();
  });

  it("removes the container with its anonymous volumes when the insert fails", async () => {
    const { docker, container } = stubDocker();
    const child = { ...(await childOf()), instanceId: UNKNOWN_INSTANCE };

    const inserted = await insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF);

    expect(inserted.isErr() && inserted.error.kind).toBe("record_failed");
    expect(docker.getContainer).toHaveBeenCalledWith("child-container");
    expect(container.remove).toHaveBeenCalledWith({ force: true, v: true });
    expect(await tx((trx) => store.getContainerByDockerId(trx, "child-container"))).toBeUndefined();
  });

  it("rethrows a failure that is not the store's, such as a column's schema refusing the row", async () => {
    const { docker, container } = stubDocker();
    const child = { ...(await childOf()), resourceLimits: { cpus: -1, memory_bytes: 1, pids: 1 } };

    await expect(
      insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF),
    ).rejects.toThrow(/cpus/);
    expect(container.remove).not.toHaveBeenCalled();
  });

  it("rethrows a Node programmer error that carries a code but is not the store's", async () => {
    const { docker, container } = stubDocker();
    const child = await childOf();
    const misuse: Transactor = () =>
      Promise.reject(
        Object.assign(new TypeError("The argument must be of type string"), {
          code: "ERR_INVALID_ARG_TYPE",
        }),
      );

    await expect(
      insertChildContainer({ store, runInTx: misuse, docker }, child, NO_CUT_OFF),
    ).rejects.toThrow("must be of type string");
    expect(container.remove).not.toHaveBeenCalled();
  });

  it("is record_failed when the removal is refused too", async () => {
    const { docker, container } = stubDocker();
    container.remove.mockRejectedValue(Object.assign(new Error("daemon i/o"), { statusCode: 500 }));
    const child = { ...(await childOf()), instanceId: UNKNOWN_INSTANCE };

    const inserted = await insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF);

    expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  describe("an insert that commits and loses its acknowledgement", () => {
    /** Commits the work, then fails as a connection lost before the commit's reply would. */
    const lossy: Transactor = async (cb) => {
      await tx(cb);
      throw Object.assign(new Error("connection reset after commit"), { code: "ECONNRESET" });
    };

    it("removes the container, leaving a starting row over nothing for the stale pass", async () => {
      const { docker, container } = stubDocker();
      const child = await childOf();

      const inserted = await insertChildContainer(
        { store, runInTx: lossy, docker },
        child,
        NO_CUT_OFF,
      );

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
      expect(container.remove).toHaveBeenCalledWith({ force: true, v: true });
      const row = await tx((trx) => store.getContainerByDockerId(trx, "child-container"));
      expect(row?.status).toBe("starting");
    });

    it("leaves the row and its container when the removal is refused", async () => {
      const { docker, container } = stubDocker();
      container.remove.mockRejectedValue(
        Object.assign(new Error("daemon i/o"), { statusCode: 500 }),
      );
      const child = await childOf();

      const inserted = await insertChildContainer(
        { store, runInTx: lossy, docker },
        child,
        NO_CUT_OFF,
      );

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
      const row = await tx((trx) => store.getContainerByDockerId(trx, "child-container"));
      expect(row?.status).toBe("starting");
    });
  });

  describe("a cut-off", () => {
    it("is cut_off and removes the container when the cut-off aborts before the insert", async () => {
      const { docker, container } = stubDocker();
      const child = await childOf();
      const cutOff = new AbortController();
      const held = Promise.withResolvers<void>();
      const slow: Transactor = async (cb) => {
        await held.promise;
        return tx(cb);
      };

      const inserting = insertChildContainer(
        { store, runInTx: slow, docker },
        child,
        cutOff.signal,
      );
      cutOff.abort(new Error("the create's deadline passed"));
      const inserted = await inserting;

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "cut_off" });
      await vi.waitFor(() =>
        expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }),
      );
      // The insert commits late, leaving a starting row over a removed container.
      held.resolve();
      await vi.waitFor(async () =>
        expect(
          (await tx((trx) => store.getContainerByDockerId(trx, "child-container")))?.status,
        ).toBe("starting"),
      );
    });

    it("answers before the container's removal finishes", async () => {
      const { docker, container } = stubDocker();
      const kill = Promise.withResolvers<void>();
      container.kill.mockReturnValue(kill.promise);
      const child = await childOf();
      const cutOff = new AbortController();
      cutOff.abort(new Error("the socket was torn down"));
      const never: Transactor = () => new Promise(() => {});

      const inserted = await insertChildContainer(
        { store, runInTx: never, docker },
        child,
        cutOff.signal,
      );

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "cut_off" });
      expect(container.kill).toHaveBeenCalled();
      expect(container.remove).not.toHaveBeenCalled();
      kill.resolve();
      await vi.waitFor(() =>
        expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }),
      );
    });

    it("is cut_off at once for a cut-off already aborted", async () => {
      const { docker } = stubDocker();
      const child = await childOf();
      const cutOff = new AbortController();
      cutOff.abort(new Error("the create's deadline passed"));
      const never: Transactor = () => new Promise(() => {});

      const inserted = await insertChildContainer(
        { store, runInTx: never, docker },
        child,
        cutOff.signal,
      );

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "cut_off" });
    });
  });
});
