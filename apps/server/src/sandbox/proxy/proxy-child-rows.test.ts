/**
 * Child rows (design/sandbox.md → Proxy Design → Child containers): the
 * proxy in front of a fake daemon, with its `ContainerRows` and
 * `ChildContainers` over the sandbox store on PGlite. The daemon creates
 * children with fresh ids it then resolves, and answers start, stop, kill
 * and DELETE 204, as the daemon does.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import {
  BRIDGE_NETWORK,
  dockerApi,
  type FakeContainer,
  type FakeDaemonResponder,
  type FakeDockerDaemon,
  requestOverSocket,
  respondJson,
  type SocketResponse,
  startFakeDockerDaemon,
} from "../../test/fake-docker-daemon.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleSandboxStore } from "../store/index.js";
import { storeChildContainers } from "../store-child-containers.js";
import { storeContainerRows } from "../store-container-rows.js";
import type { ResourceLimits } from "../types.js";
import { CogmoSocketProxy } from "./index.js";
import type { TaskScope } from "./types.js";

const TASK_ID = "019d0000-0000-7000-8000-00000000aaaa";
const IMAGE = "alpine:3";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const GIB = 1024 ** 3;
const LIMITS: ResourceLimits = { cpus: 2, memory_bytes: GIB, pids: 256 };
const TTL = new Date("2026-12-01T00:00:00.000Z");
const OWN_DOCKER_ID = `1a${"0".repeat(62)}`;

const CreatedSchema = z.object({ Id: z.string() });

/** The child statuses a test row may be put in, with the reason only a `reaped` one records. */
const CHILD_STATUS = {
  starting: { reapedReason: null },
  running: { reapedReason: null },
  exited: { reapedReason: null },
  reaped: { reapedReason: "cascade" },
} as const;

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSandboxStore();

let baseDir: string;
let daemon: FakeDockerDaemon;
let proxy: CogmoSocketProxy;
let socket: string;
let scope: TaskScope;
/** The containers the fake daemon has; a create adds one, a DELETE removes it. */
const containers: FakeContainer[] = [];
/** Every id the fake daemon answered a create with, in order. */
const createdIds: string[] = [];
/** Runs before the daemon answers a child's start, as another path would. */
let onStart: (dockerId: string) => Promise<void>;
/** Holds the daemon's answer to a create until it resolves. */
let createGate: Promise<void>;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  const instance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
  const own = await tx((trx) =>
    store.insertContainer(trx, {
      dockerId: OWN_DOCKER_ID,
      parentId: null,
      rootTaskId: TASK_ID,
      depth: 0,
      image: "devbase",
      runtime: "sysbox-runc",
      labels: { "cogmo.managed": "true" },
      resourceLimits: LIMITS,
      ttlExpiresAt: TTL,
      instanceId: instance.id,
    }),
  );
  scope = {
    taskId: TASK_ID,
    parentContainerRowId: own.id,
    parentDockerId: OWN_DOCKER_ID,
    parentDepth: 0,
    runtime: "sysbox-runc",
    cgroupParent: "cogmo-task-abc.slice",
    instanceId: instance.id,
    resourceLimits: LIMITS,
    ttlExpiresAt: TTL,
  };
  containers.splice(0, containers.length, {
    id: OWN_DOCKER_ID,
    name: "cogmo-task-own",
    labels: {},
  });
  createdIds.splice(0, createdIds.length);
  onStart = async () => {};
  createGate = Promise.resolve();
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-child-rows-"));
  daemon = await startFakeDockerDaemon(join(baseDir, "docker.sock"), childDaemon());
  proxy = await CogmoSocketProxy.create({
    socketDir: join(baseDir, "sockets"),
    hostDockerSocket: daemon.socketPath,
    containerRows: storeContainerRows({ store, runInTx: tx }),
    childContainers: storeChildContainers({
      store,
      runInTx: tx,
      docker: new Docker({ socketPath: daemon.socketPath }),
    }),
  });
  socket = await proxy.registerTask(scope);
});

afterEach(async () => {
  await proxy.close();
  await daemon.close();
  await rm(baseDir, { recursive: true, force: true });
  await truncateAll(db);
});

/** The shared fake daemon, plus the child lifecycle routes a real daemon answers 201 and 204. */
function childDaemon(): FakeDaemonResponder {
  const api = dockerApi({
    images: new Map([[IMAGE, { id: IMAGE_ID, env: [] }]]),
    // Read on every request, so the children a create adds resolve.
    containers,
    networks: [BRIDGE_NETWORK],
    arch: "amd64",
    bridgeGateway: "172.17.0.1",
    rootless: false,
  });
  let created = 0;
  return (req, res, raw) => {
    const path = (req.url.split("?")[0] ?? "").replace(/^\/v[\d.]+/, "");
    if (req.method === "POST" && path === "/containers/create") {
      created += 1;
      const id = createHash("sha256").update(`child-${created}`).digest("hex");
      containers.push({ id, name: `child-${created}`, labels: {} });
      createdIds.push(id);
      void createGate.then(() => respondJson(res, 201, { Id: id, Warnings: [] }));
      return;
    }
    const lifecycle = /^\/containers\/([0-9a-f]{64})\/(start|stop|kill)$/.exec(path);
    if (req.method === "POST" && lifecycle?.[1] !== undefined) {
      const id = lifecycle[1];
      const started = lifecycle[2] === "start" ? onStart(id) : Promise.resolve();
      void started.then(() => {
        res.writeHead(204);
        res.end();
      });
      return;
    }
    const removed = /^\/containers\/([0-9a-f]{64})$/.exec(path);
    if (req.method === "DELETE" && removed?.[1] !== undefined) {
      const at = containers.findIndex((c) => c.id === removed[1]);
      if (at !== -1) containers.splice(at, 1);
      res.writeHead(204);
      res.end();
      return;
    }
    api(req, res, raw);
  };
}

function send(method: string, path: string, body?: string): Promise<SocketResponse> {
  return requestOverSocket(socket, { method, path, ...(body !== undefined && { body }) });
}

async function createChild(body: object): Promise<string> {
  const r = await send("POST", "/containers/create", JSON.stringify(body));
  expect(r.status, r.body).toBe(201);
  return CreatedSchema.parse(JSON.parse(r.body)).Id;
}

async function rowOf(dockerId: string) {
  return tx((trx) => store.getContainerByDockerId(trx, dockerId));
}

function received(): string[] {
  return daemon.requests().map((r) => `${r.method} ${r.url}`);
}

describe("child rows", () => {
  it("records a created child as a starting row with the scope's lineage", async () => {
    const id = await createChild({ Image: IMAGE, HostConfig: { Memory: GIB / 2 } });

    const row = expectDefined(await rowOf(id), "the child's row");
    expect(row).toMatchObject({
      parentId: scope.parentContainerRowId,
      rootTaskId: TASK_ID,
      depth: 1,
      image: IMAGE,
      runtime: "sysbox-runc",
      status: "starting",
      ttlExpiresAt: TTL,
      instanceId: scope.instanceId,
      resourceLimits: { cpus: 2, memory_bytes: GIB / 2, pids: 256 },
      labels: {
        "cogmo.managed": "true",
        "cogmo.instance": scope.instanceId,
        "cogmo.root_task": TASK_ID,
        "cogmo.parent": OWN_DOCKER_ID,
        "cogmo.depth": "1",
      },
    });
  });

  it("records the CPUs a CpuQuota asks for", async () => {
    const id = await createChild({
      Image: IMAGE,
      HostConfig: { CpuQuota: 50_000, CpuPeriod: 100_000 },
    });

    expect((await rowOf(id))?.resourceLimits).toMatchObject({ cpus: 0.5 });
  });

  it("owns a child once its row exists", async () => {
    const id = await createChild({ Image: IMAGE });

    const r = await send("GET", `/containers/${id}/json`);

    expect(r.status, r.body).toBe(200);
  });

  it("moves the row to running on start and to exited on DELETE", async () => {
    const id = await createChild({ Image: IMAGE });

    const started = await send("POST", `/containers/${id}/start`);
    expect(started.status, started.body).toBe(204);
    expect((await rowOf(id))?.status).toBe("running");

    const removed = await send("DELETE", `/containers/${id}?force=true`);
    expect(removed.status, removed.body).toBe(204);
    expect((await rowOf(id))?.status).toBe("exited");
    expect(received()).toContain(`DELETE /containers/${id}?force=true&v=true`);
  });

  it("leaves a child stopped and started again running", async () => {
    const id = await createChild({ Image: IMAGE });
    await send("POST", `/containers/${id}/start`);

    expect((await send("POST", `/containers/${id}/stop`)).status).toBe(204);
    const restarted = await send("POST", `/containers/${id}/start`);

    expect(restarted.status, restarted.body).toBe(204);
    expect((await rowOf(id))?.status).toBe("running");
  });

  it("kills and removes a child whose row was reaped while the daemon started it, and answers 404", async () => {
    const id = await createChild({ Image: IMAGE });
    onStart = async (dockerId) => {
      await db.execute(
        sql`UPDATE containers SET status = 'reaped', reaped_reason = 'ttl_expired', exited_at = now() WHERE docker_id = ${dockerId}`,
      );
    };

    const r = await send("POST", `/containers/${id}/start`);

    expect(r.status, r.body).toBe(404);
    expect(received()).toEqual(
      expect.arrayContaining([
        `POST /containers/${id}/kill?signal=SIGTERM`,
        `DELETE /containers/${id}?force=true&v=true`,
      ]),
    );
    expect((await rowOf(id))?.reapedReason).toBe("ttl_expired");
  });

  it("removes the container and answers 500 when the row insert fails", async () => {
    // No `cogmo_instances` row has this id, so the insert fails on its foreign key.
    await proxy.registerTask({ ...scope, instanceId: "019d0000-0000-7000-8000-000000000bad" });

    const r = await send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

    expect(r.status, r.body).toBe(500);
    const child = expectDefined(createdIds.at(-1), "the created child");
    expect(received()).toContain(`DELETE /containers/${child}?force=true&v=true`);
    expect(await rowOf(child)).toBeUndefined();
  });

  it("answers 502 to a 201 that names no container, and records nothing", async () => {
    const fallback = childDaemon();
    daemon.setResponder((req, res, raw) =>
      req.method === "POST" && req.url.startsWith("/containers/create")
        ? respondJson(res, 201, { Warnings: [] })
        : fallback(req, res, raw),
    );

    const r = await send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

    expect(r.status, r.body).toBe(502);
    const rows = await tx((trx) => store.listContainersForTask(trx, TASK_ID));
    expect(rows).toHaveLength(1);
  });

  it("denies the 17th live child, counting no exited or reaped one", async () => {
    const insertChildRow = (n: number, status: keyof typeof CHILD_STATUS) =>
      tx(async (trx) => {
        const row = await store.insertContainer(trx, {
          dockerId: `child-row-${n}`,
          parentId: scope.parentContainerRowId,
          rootTaskId: TASK_ID,
          depth: 1,
          image: IMAGE,
          runtime: "sysbox-runc",
          labels: {},
          resourceLimits: LIMITS,
          ttlExpiresAt: TTL,
          instanceId: scope.instanceId,
        });
        const { reapedReason } = CHILD_STATUS[status];
        await trx.execute(
          sql`UPDATE containers SET status = ${status}, reaped_reason = ${reapedReason} WHERE id = ${row.id}`,
        );
      });
    for (let n = 0; n < 15; n += 1) await insertChildRow(n, n % 2 === 0 ? "running" : "starting");
    await insertChildRow(100, "exited");
    await insertChildRow(101, "reaped");

    await createChild({ Image: IMAGE });
    const creates = () => received().filter((r) => r.startsWith("POST /containers/create"));
    expect(creates()).toHaveLength(1);

    const r = await send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

    expect(r.status, r.body).toBe(403);
    expect(creates()).toHaveLength(1);
  });

  it("records a child whose create is in flight when the task is torn down", async () => {
    const released = Promise.withResolvers<void>();
    createGate = released.promise;
    const creating = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
    await expect
      .poll(() => received().some((r) => r.startsWith("POST /containers/create")))
      .toBe(true);

    let unregistered = false;
    const unregistering = proxy.unregisterTask(TASK_ID).then(() => {
      unregistered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(unregistered).toBe(false);
    released.resolve();
    await unregistering;

    const child = expectDefined(createdIds.at(-1), "the created child");
    expect((await rowOf(child))?.status).toBe("starting");
    expect((await creating).status).toBe(201);
  });
});
