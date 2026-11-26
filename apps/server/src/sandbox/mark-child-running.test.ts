import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { expectOk } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import { markChildRunning } from "./mark-child-running.js";
import { DrizzleSandboxStore } from "./store/index.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";
const AT = new Date("2026-11-26T12:00:00.000Z");

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

/** The reason a row in each status records: only a `reaped` row has one. */
const REAPED_REASON = { running: null, exited: null, reaped: "ttl_expired" } as const;

/** A child row in `starting`. */
async function childRow(): Promise<string> {
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
  return row.id;
}

/** A child row moved by raw SQL to `status`, as another path would. */
async function childRowIn(status: keyof typeof REAPED_REASON): Promise<string> {
  const id = await childRow();
  await db.execute(
    sql`UPDATE containers SET status = ${status}, reaped_reason = ${REAPED_REASON[status]} WHERE id = ${id}`,
  );
  return id;
}

describe("markChildRunning", () => {
  it("moves a starting row to running", async () => {
    const { docker, container } = stubDocker();
    const id = await childRow();

    const outcome = await markChildRunning(
      { store, runInTx: tx, docker },
      { id, dockerId: "child-container", at: AT },
    );

    expect(expectOk(outcome)).toEqual({ kind: "running" });
    const row = await tx((trx) => store.getContainer(trx, id));
    expect(row).toMatchObject({ status: "running", startedAt: AT });
    expect(container.kill).not.toHaveBeenCalled();
  });

  it("writes nothing for a child started again, whose row is running", async () => {
    const { docker, container } = stubDocker();
    const id = await childRowIn("running");

    const outcome = await markChildRunning(
      { store, runInTx: tx, docker },
      { id, dockerId: "child-container", at: AT },
    );

    expect(expectOk(outcome)).toEqual({ kind: "running" });
    expect((await tx((trx) => store.getContainer(trx, id)))?.startedAt).toBeNull();
    expect(container.kill).not.toHaveBeenCalled();
  });

  it.each(["exited", "reaped"] as const)(
    "kills and removes the container of a row another path moved to %s",
    async (status) => {
      const { docker, container } = stubDocker();
      const id = await childRowIn(status);

      const outcome = await markChildRunning(
        { store, runInTx: tx, docker },
        { id, dockerId: "child-container", at: AT },
      );

      expect(expectOk(outcome)).toEqual({ kind: "finished" });
      expect(container.kill).toHaveBeenCalledWith({ signal: "SIGTERM" });
      expect(container.remove).toHaveBeenCalledWith({ force: true, v: true });
      expect((await tx((trx) => store.getContainer(trx, id)))?.status).toBe(status);
    },
  );

  it("is finished even when the daemon refuses the kill", async () => {
    const { docker, container } = stubDocker();
    container.kill.mockRejectedValue(Object.assign(new Error("daemon i/o"), { statusCode: 500 }));
    const id = await childRowIn("reaped");

    const outcome = await markChildRunning(
      { store, runInTx: tx, docker },
      { id, dockerId: "child-container", at: AT },
    );

    expect(expectOk(outcome)).toEqual({ kind: "finished" });
    expect(container.remove).not.toHaveBeenCalled();
  });
});
