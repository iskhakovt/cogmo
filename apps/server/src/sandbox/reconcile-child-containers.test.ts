import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { expectOk, resolvesWithin } from "../test/assertions.js";
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
 * error status, the container's state, or `never`, until the inspect's
 * signal aborts it; any other id is running.
 */
function daemonAnswering(
  answers: Readonly<Record<string, number | "exited" | "never">>,
): DockerFacade {
  const docker = mock<DockerFacade>();
  docker.getContainer.mockImplementation((id) => {
    const container = mock<DockerContainer>();
    const status = answers[id];
    if (status === "never") {
      container.inspect.mockImplementation(
        (opts) =>
          new Promise((_, reject) => {
            const signal = opts?.abortSignal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
    } else if (typeof status === "number") {
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

/** A task signal that never aborts. */
const NO_ABORT = new AbortController().signal;

/** The time the adapter hands the reconcile, which its exit writes record. */
const AT = new Date("2026-11-20T10:00:00.000Z");

describe("reconcileChildContainers", () => {
  it("keeps the children the daemon has and moves the ones it answers 404 for to exited", async () => {
    const present = await child("present");
    const removed = await child("auto-removed");
    const docker = daemonAnswering({ "auto-removed": 404 });

    const live = expectOk(
      await reconcileChildContainers(
        { store, runInTx: tx, docker },
        { children: [present, removed], at: AT, signal: NO_ABORT },
      ),
    );

    expect(live).toEqual([present]);
    const exited = await tx((trx) => store.getContainer(trx, removed.id));
    expect(exited?.status).toBe("exited");
    expect(exited?.exitedAt).toEqual(AT);
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

    const live = expectOk(
      await reconcileChildContainers(
        { store, runInTx: tx, docker },
        { children: [read], at: AT, signal: NO_ABORT },
      ),
    );

    expect(live).toEqual([]);
    expect((await tx((trx) => store.getContainer(trx, read.id)))?.status).toBe("exited");
  });

  it("keeps a child that exited but was not removed, and its place", async () => {
    const stopped = await child("stopped");
    const docker = daemonAnswering({ stopped: "exited" });

    const live = expectOk(
      await reconcileChildContainers(
        { store, runInTx: tx, docker },
        { children: [stopped], at: AT, signal: NO_ABORT },
      ),
    );

    expect(live).toEqual([stopped]);
    expect((await tx((trx) => store.getContainer(trx, stopped.id)))?.status).toBe("starting");
  });

  it("counts a child whose inspect fails otherwise as live, writing nothing", async () => {
    const unsure = await child("unsure");
    const docker = daemonAnswering({ unsure: 500 });

    const live = expectOk(
      await reconcileChildContainers(
        { store, runInTx: tx, docker },
        { children: [unsure], at: AT, signal: NO_ABORT },
      ),
    );

    expect(live).toEqual([unsure]);
    expect((await tx((trx) => store.getContainer(trx, unsure.id)))?.status).toBe("starting");
  });

  it("counts a child whose inspect does not answer within 5 seconds as live, writing nothing", async () => {
    const wedged = await child("wedged");
    const removed = await child("auto-removed");
    const docker = daemonAnswering({ wedged: "never", "auto-removed": 404 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reconciling: ReturnType<typeof reconcileChildContainers>;
    try {
      reconciling = reconcileChildContainers(
        { store, runInTx: tx, docker },
        { children: [wedged, removed], at: AT, signal: NO_ABORT },
      );
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      vi.useRealTimers();
    }

    const live = expectOk(await resolvesWithin(reconciling, 2_500, "the reconcile"));

    expect(live).toEqual([wedged]);
    expect((await tx((trx) => store.getContainer(trx, wedged.id)))?.status).toBe("starting");
    expect((await tx((trx) => store.getContainer(trx, removed.id)))?.status).toBe("exited");
  });

  it("counts a child whose inspect the task's signal aborts as live", async () => {
    const wedged = await child("wedged");
    const docker = daemonAnswering({ wedged: "never" });
    const task = new AbortController();

    const reconciling = reconcileChildContainers(
      { store, runInTx: tx, docker },
      { children: [wedged], at: AT, signal: task.signal },
    );
    task.abort(new Error("task socket unregistered"));

    expect(expectOk(await resolvesWithin(reconciling, 2_500, "the reconcile"))).toEqual([wedged]);
  });

  it("is store_failed when the exited write throws", async () => {
    const removed = await child("auto-removed");
    const cause = new Error("connection reset");
    const failing: Transactor = () => Promise.reject(cause);

    const live = await reconcileChildContainers(
      { store, runInTx: failing, docker: daemonAnswering({ "auto-removed": 404 }) },
      { children: [removed], at: AT, signal: NO_ABORT },
    );

    expect(live._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });
});
