import { getEventListeners } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { expectDefined, resolvesWithin } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import { insertChildContainer } from "./insert-child-container.js";
import type { ChildRecord } from "./proxy/index.js";
import { DrizzleSandboxStore } from "./store/index.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logger.js", () => ({ logger: { child: () => log } }));

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

/**
 * Insert `child` with its cut-off firing while the insert waits at its
 * first `runInTx` call, then let the insert go on: a row that commits after
 * the cut-off.
 */
async function insertCutOffMidway(
  deps: { runInTx: Transactor; docker: DockerFacade },
  child: ChildRecord,
): Promise<Awaited<ReturnType<typeof insertChildContainer>>> {
  const held = Promise.withResolvers<void>();
  let first = true;
  const gated: Transactor = async (cb) => {
    if (first) {
      first = false;
      await held.promise;
    }
    return deps.runInTx(cb);
  };
  const cutOff = new AbortController();
  const inserting = insertChildContainer(
    { store, runInTx: gated, docker: deps.docker },
    child,
    cutOff.signal,
  );
  cutOff.abort(new Error("the socket was torn down"));
  const inserted = await inserting;
  held.resolve();
  return inserted;
}

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

  it("leaves no listener on the cut-off once the insert wins", async () => {
    const { docker } = stubDocker();
    const child = await childOf();
    const cutOff = new AbortController();

    const inserted = await insertChildContainer(
      { store, runInTx: tx, docker },
      child,
      cutOff.signal,
    );

    expect(inserted.isOk()).toBe(true);
    expect(getEventListeners(cutOff.signal, "abort")).toEqual([]);
  });

  it("removes the container with its anonymous volumes when the insert fails", async () => {
    const { docker, container } = stubDocker();
    const child = { ...(await childOf()), instanceId: UNKNOWN_INSTANCE };

    const inserted = await insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF);

    expect(inserted.isErr() && inserted.error.kind).toBe("record_failed");
    // The removal finishes in the background.
    await vi.waitFor(() => expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }));
    expect(docker.getContainer).toHaveBeenCalledWith("child-container");
    expect(await tx((trx) => store.getContainerByDockerId(trx, "child-container"))).toBeUndefined();
  });

  it("answers record_failed before the rollback's removal finishes", async () => {
    const { docker, container } = stubDocker();
    const kill = Promise.withResolvers<void>();
    container.kill.mockReturnValue(kill.promise);
    const child = { ...(await childOf()), instanceId: UNKNOWN_INSTANCE };

    const inserted = await resolvesWithin(
      insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF),
      2_500,
      "the insert's answer",
    );

    expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
    expect(container.remove).not.toHaveBeenCalled();
    kill.resolve();
    await vi.waitFor(() => expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }));
  });

  it("rethrows a failure that is not the store's, such as a column's schema refusing the row, and still removes the container", async () => {
    const { docker, container } = stubDocker();
    const child = { ...(await childOf()), resourceLimits: { cpus: -1, memory_bytes: 1, pids: 1 } };

    await expect(
      insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF),
    ).rejects.toThrow(/cpus/);
    await vi.waitFor(() => expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }));
  });

  it("rethrows a Node programmer error that carries a code but is not the store's, and still removes the container", async () => {
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
    await vi.waitFor(() => expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }));
  });

  it.each([
    // postgres-js's own connection failures (`Errors.connection`).
    "CONNECT_TIMEOUT",
    "CONNECTION_CLOSED",
    "CONNECTION_DESTROYED",
    "CONNECTION_ENDED",
    // Node's, from the driver's socket.
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
  ])(
    "is record_failed, removing the container, when the connection fails with %s",
    async (code) => {
      const { docker, container } = stubDocker();
      const child = await childOf();
      const unreachable: Transactor = () =>
        Promise.reject(
          Object.assign(new Error(`write ${code} db:5432`), { code, errno: code, address: "db" }),
        );

      const inserted = await insertChildContainer(
        { store, runInTx: unreachable, docker },
        child,
        NO_CUT_OFF,
      );

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
      await vi.waitFor(() =>
        expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }),
      );
    },
  );

  it.each(["EPERM", "EBADF", "EXDEV"])(
    "rethrows a %s, an errno code shaped like a SQLSTATE but not the store's, and still removes the container",
    async (code) => {
      const { docker, container } = stubDocker();
      const child = await childOf();
      const misuse: Transactor = () =>
        Promise.reject(Object.assign(new Error(`${code}: operation failed`), { code }));

      await expect(
        insertChildContainer({ store, runInTx: misuse, docker }, child, NO_CUT_OFF),
      ).rejects.toThrow(code);
      await vi.waitFor(() =>
        expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }),
      );
    },
  );

  it.each(["23503", "42P01", "P0001", "XX000", "HV000", "F0000"])(
    "is record_failed for the SQLSTATE %s",
    async (code) => {
      const { docker } = stubDocker();
      const child = await childOf();
      const refusing: Transactor = () =>
        Promise.reject(Object.assign(new Error(`postgres ${code}`), { code }));

      const inserted = await insertChildContainer(
        { store, runInTx: refusing, docker },
        child,
        NO_CUT_OFF,
      );

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
    },
  );

  it("is record_failed when the removal is refused too", async () => {
    const { docker, container } = stubDocker();
    container.remove.mockRejectedValue(Object.assign(new Error("daemon i/o"), { statusCode: 500 }));
    const child = { ...(await childOf()), instanceId: UNKNOWN_INSTANCE };

    const inserted = await insertChildContainer({ store, runInTx: tx, docker }, child, NO_CUT_OFF);

    expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
    await vi.waitFor(() => expect(container.remove).toHaveBeenCalledTimes(1));
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
      await vi.waitFor(() =>
        expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }),
      );
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
      // The insert commits late, over a container already removed: the row goes to exited.
      held.resolve();
      await vi.waitFor(async () =>
        expect(
          (await tx((trx) => store.getContainerByDockerId(trx, "child-container")))?.status,
        ).toBe("exited"),
      );
      expect(container.remove).toHaveBeenCalledTimes(1);
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

    it("takes a row that commits late exited, retrying the removal the daemon refused first", async () => {
      const { docker, container } = stubDocker();
      container.kill.mockRejectedValueOnce(
        Object.assign(new Error("daemon i/o"), { statusCode: 500 }),
      );
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
      expect((await inserting)._unsafeUnwrapErr()).toEqual({ kind: "cut_off" });
      await vi.waitFor(() => expect(container.kill).toHaveBeenCalledTimes(1));
      expect(container.remove).not.toHaveBeenCalled();
      held.resolve();

      // Not live, so it holds no place under the child cap.
      await vi.waitFor(async () =>
        expect(
          (await tx((trx) => store.getContainerByDockerId(trx, "child-container")))?.status,
        ).toBe("exited"),
      );
      expect(container.remove).toHaveBeenCalledWith({ force: true, v: true });
    });

    describe("a late row another path moves before its exited write", () => {
      /** Commits the insert, then runs `before` ahead of the exited write. */
      function interleaved(before: () => Promise<void>): Transactor {
        let calls = 0;
        return async (cb) => {
          calls += 1;
          if (calls === 2) await before();
          return tx(cb);
        };
      }

      async function lateRow(runInTx: Transactor): Promise<void> {
        const { docker } = stubDocker();
        await insertCutOffMidway({ runInTx, docker }, await childOf());
      }

      const rowNow = () => tx((trx) => store.getContainerByDockerId(trx, "child-container"));

      it("lands on exited when a start moved it to running first", async () => {
        await lateRow(
          interleaved(async () => {
            const row = expectDefined(await rowNow(), "the late row");
            await tx((trx) =>
              store.transitionContainerStatus(trx, {
                id: row.id,
                from: "starting",
                to: "running",
                at: new Date(),
              }),
            );
          }),
        );

        await vi.waitFor(async () => expect((await rowNow())?.status).toBe("exited"));
      });

      it("leaves it reaped when the cascade reaped it first", async () => {
        await lateRow(
          interleaved(async () => {
            const row = expectDefined(await rowNow(), "the late row");
            await tx((trx) =>
              store.transitionContainerStatus(trx, {
                id: row.id,
                to: "reaped",
                reason: "cascade",
                at: new Date(),
              }),
            );
          }),
        );

        await vi.waitFor(() =>
          expect(log.debug).toHaveBeenCalledWith(
            expect.objectContaining({ dockerId: "child-container", status: "reaped" }),
            expect.stringContaining("already finished"),
          ),
        );
        expect(await rowNow()).toMatchObject({ status: "reaped", reapedReason: "cascade" });
      });
    });

    it("leaves a late row starting, and logs it, when the daemon refuses the retried removal too", async () => {
      const { docker, container } = stubDocker();
      container.kill.mockRejectedValue(Object.assign(new Error("daemon i/o"), { statusCode: 500 }));
      const child = await childOf();

      const inserted = await insertCutOffMidway({ runInTx: tx, docker }, child);

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "cut_off" });
      await vi.waitFor(() =>
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ dockerId: "child-container" }),
          expect.stringContaining("could not be removed"),
        ),
      );
      expect(container.kill).toHaveBeenCalledTimes(2);
      expect(
        (await tx((trx) => store.getContainerByDockerId(trx, "child-container")))?.status,
      ).toBe("starting");
    });

    it("leaves a late row to the stale pass, and logs it, when its exited write fails", async () => {
      const { docker } = stubDocker();
      const child = await childOf();
      let calls = 0;
      // The insert commits; the exited write after it fails.
      const flaky: Transactor = async (cb) => {
        calls += 1;
        if (calls === 1) return tx(cb);
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      };

      await insertCutOffMidway({ runInTx: flaky, docker }, child);

      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ dockerId: "child-container" }),
          expect.stringContaining("could not be marked exited"),
        ),
      );
      expect(
        (await tx((trx) => store.getContainerByDockerId(trx, "child-container")))?.status,
      ).toBe("starting");
    });

    it("logs a late insert that fails after the cut-off at debug", async () => {
      const { docker } = stubDocker();
      const child = await childOf();
      const cutOff = new AbortController();
      const held = Promise.withResolvers<void>();
      const lost: Transactor = async () => {
        await held.promise;
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      };

      const inserting = insertChildContainer(
        { store, runInTx: lost, docker },
        child,
        cutOff.signal,
      );
      cutOff.abort(new Error("the create's deadline passed"));
      expect((await inserting)._unsafeUnwrapErr()).toEqual({ kind: "cut_off" });
      held.resolve();

      await vi.waitFor(() =>
        expect(log.debug).toHaveBeenCalledWith(
          expect.objectContaining({ dockerId: "child-container" }),
          "a late child row insert failed",
        ),
      );
    });

    it("logs a background removal that throws as an error", async () => {
      const { docker } = stubDocker();
      const bug = new Error("getContainer is broken");
      vi.mocked(docker.getContainer).mockImplementation(() => {
        throw bug;
      });
      const child = { ...(await childOf()), instanceId: UNKNOWN_INSTANCE };

      const inserted = await insertChildContainer(
        { store, runInTx: tx, docker },
        child,
        NO_CUT_OFF,
      );

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "record_failed" });
      await vi.waitFor(() =>
        expect(log.error).toHaveBeenCalledWith(
          { err: bug, dockerId: "child-container" },
          "finishing a child's rollback threw",
        ),
      );
    });

    it("inserts nothing for a cut-off already aborted, and removes the container", async () => {
      const { docker, container } = stubDocker();
      const child = await childOf();
      const cutOff = new AbortController();
      cutOff.abort(new Error("the socket was torn down"));
      let opened = 0;
      const runInTx: Transactor = (cb) => {
        opened += 1;
        return tx(cb);
      };

      const inserted = await insertChildContainer({ store, runInTx, docker }, child, cutOff.signal);

      expect(inserted._unsafeUnwrapErr()).toEqual({ kind: "cut_off" });
      await vi.waitFor(() =>
        expect(container.remove).toHaveBeenCalledWith({ force: true, v: true }),
      );
      expect(opened).toBe(0);
      expect(
        await tx((trx) => store.getContainerByDockerId(trx, "child-container")),
      ).toBeUndefined();
    });
  });
});
