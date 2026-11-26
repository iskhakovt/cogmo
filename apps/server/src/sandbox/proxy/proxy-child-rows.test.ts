/**
 * Child rows (design/sandbox.md → Proxy Design → Child containers), as a
 * deliberate cross-module test, which the design's test plan names: the
 * proxy in front of a fake daemon, with its `ContainerRows` and
 * `ChildContainers` over the sandbox store on PGlite, and for teardown the
 * supervisor too, none of them mocked. The daemon creates children with
 * fresh ids it then resolves, and answers start, stop, kill and DELETE 204,
 * as the daemon does.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { sql } from "drizzle-orm";
import { ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined, resolvesWithin } from "../../test/assertions.js";
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
import { runReap } from "../reaper.js";
import { DrizzleSandboxStore } from "../store/index.js";
import { storeChildContainers } from "../store-child-containers.js";
import { storeContainerRows } from "../store-container-rows.js";
import { LocalDockerSandboxClient } from "../supervisor.js";
import type { ResourceLimits } from "../types.js";
import { CogmoSocketProxy } from "./index.js";
import type { ChildContainers, TaskScope } from "./types.js";

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
/** Runs before the daemon answers a child's restart. */
let onRestart: (dockerId: string) => Promise<void>;
/** Runs before the daemon answers a child's DELETE. */
let onRemove: (dockerId: string) => Promise<void>;
/** The creates whose connection closed before the daemon answered them. */
let abandonedCreates: number;
/** Runs before the daemon answers a child's kill. */
let onKill: (dockerId: string) => Promise<void>;
/** Runs before the daemon answers an image inspect. */
let onInspect: () => Promise<void>;
/** Holds the daemon's answer to a create until it resolves. */
let createGate: Promise<void>;
/**
 * Holds each child write until it resolves, before its transaction opens:
 * PGlite runs one transaction at a time, so a gate inside one would hold
 * every other read too.
 */
let childWriteGate: Promise<void>;
/** Holds each insert's result once the insert has committed, until it resolves. */
let recordGate: Promise<void>;

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
    anchor: { rowId: own.id, dockerId: OWN_DOCKER_ID },
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
  onRestart = async () => {};
  onRemove = async () => {};
  abandonedCreates = 0;
  onKill = async () => {};
  onInspect = async () => {};
  createGate = Promise.resolve();
  childWriteGate = Promise.resolve();
  recordGate = Promise.resolve();
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-child-rows-"));
  daemon = await startFakeDockerDaemon(join(baseDir, "docker.sock"), childDaemon());
  proxy = await CogmoSocketProxy.create({
    socketDir: join(baseDir, "sockets"),
    hostDockerSocket: daemon.socketPath,
    containerRows: storeContainerRows({ store, runInTx: tx }),
    childContainers: gatedRecords(
      storeChildContainers({
        store,
        runInTx: async (cb) => {
          await childWriteGate;
          return tx(cb);
        },
        docker: new Docker({ socketPath: daemon.socketPath }),
      }),
    ),
  });
  socket = await proxy.registerTask(scope);
});

afterEach(async () => {
  await proxy.close();
  await daemon.close();
  await rm(baseDir, { recursive: true, force: true });
  await truncateAll(db);
});

/** `children`, each insert's result held at `recordGate` once the insert has committed. */
function gatedRecords(children: ChildContainers): ChildContainers {
  return {
    ...children,
    record: (child, cutOff) =>
      children
        .record(child, cutOff)
        .andThen((recorded) => ResultAsync.fromSafePromise(recordGate.then(() => recorded))),
  };
}

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
      res.once("close", () => {
        if (!res.writableEnded) abandonedCreates += 1;
      });
      void createGate.then(() => respondJson(res, 201, { Id: id, Warnings: [] }));
      return;
    }
    const lifecycle = /^\/containers\/([0-9a-f]{64})\/(start|restart|stop|kill)$/.exec(path);
    if (req.method === "POST" && lifecycle?.[1] !== undefined) {
      const id = lifecycle[1];
      const started = match(lifecycle[2])
        .with("start", () => onStart(id))
        .with("restart", () => onRestart(id))
        .with("kill", () => onKill(id))
        .otherwise(() => Promise.resolve());
      void started.then(() => {
        res.writeHead(204);
        res.end();
      });
      return;
    }
    const removed = /^\/containers\/([0-9a-f]{64})$/.exec(path);
    if (req.method === "DELETE" && removed?.[1] !== undefined) {
      const id = removed[1];
      void onRemove(id).then(() => {
        const at = containers.findIndex((c) => c.id === id);
        if (at !== -1) containers.splice(at, 1);
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && path.startsWith("/images/")) {
      void onInspect().then(() => api(req, res, raw));
      return;
    }
    // The supervisor's runtime check reads the daemon's runtimes.
    if (req.method === "GET" && path === "/info") {
      respondJson(res, 200, { Runtimes: { runc: { path: "runc" } }, SecurityOptions: [] });
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

/** Send `method path` on a fresh connection, to be hung up once the daemon has it. */
function sendRaw(method: string, path: string): { hangUp: () => void } {
  const client = net.createConnection({ path: socket });
  client.on("error", () => {});
  client.write(`${method} ${path} HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n`);
  return { hangUp: () => client.destroy() };
}

/** Insert a child row of the task's own row in `status`, whose container the daemon has or not. */
async function insertChildRow(
  n: number,
  status: keyof typeof CHILD_STATUS,
  onDaemon: "present" | "gone",
): Promise<void> {
  const dockerId = createHash("sha256").update(`row-${n}`).digest("hex");
  match(onDaemon)
    .with("present", () => containers.push({ id: dockerId, name: `row-${n}`, labels: {} }))
    .with("gone", () => undefined)
    .exhaustive();
  await tx(async (trx) => {
    const row = await store.insertContainer(trx, {
      dockerId,
      parentId: expectDefined(scope.anchor, "the scope's anchor").rowId,
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
}

function creates(): string[] {
  return received().filter((r) => r.startsWith("POST /containers/create"));
}

describe("child rows", () => {
  it("records a created child as a starting row with the scope's lineage", async () => {
    const id = await createChild({ Image: IMAGE, HostConfig: { Memory: GIB / 2 } });

    const row = expectDefined(await rowOf(id), "the child's row");
    expect(row).toMatchObject({
      parentId: expectDefined(scope.anchor, "the scope's anchor").rowId,
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

  it("answers the daemon's 204 to a start whose child removed itself before the row write, and kills nothing", async () => {
    const id = await createChild({ Image: IMAGE });
    const written = Promise.withResolvers<void>();
    childWriteGate = written.promise;
    const starting = send("POST", `/containers/${id}/start`);
    try {
      await vi.waitFor(() => expect(received()).toContain(`POST /containers/${id}/start`));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // A `--rm` child ran, exited and removed itself; the stale pass found it gone.
      const at = containers.findIndex((c) => c.id === id);
      containers.splice(at, 1);
      await db.execute(
        sql`UPDATE containers SET status = 'exited', exited_at = now() WHERE docker_id = ${id}`,
      );
    } finally {
      written.resolve();
    }

    const r = await starting;

    expect(r.status, r.body).toBe(204);
    expect(received()).not.toContain(`POST /containers/${id}/kill?signal=SIGTERM`);
    expect((await rowOf(id))?.status).toBe("exited");
  });

  it("removes the container and answers 500 when the row insert fails", async () => {
    // No `cogmo_instances` row has this id, so the insert fails on its foreign key.
    await proxy.registerTask({ ...scope, instanceId: "019d0000-0000-7000-8000-000000000bad" });

    const r = await send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

    expect(r.status, r.body).toBe(500);
    const child = expectDefined(createdIds.at(-1), "the created child");
    // Answered at once; the removal finishes in the background.
    await vi.waitFor(() =>
      expect(received()).toContain(`DELETE /containers/${child}?force=true&v=true`),
    );
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
    for (let n = 0; n < 15; n += 1) {
      await insertChildRow(n, n % 2 === 0 ? "running" : "starting", "present");
    }
    await insertChildRow(100, "exited", "gone");
    await insertChildRow(101, "reaped", "gone");

    await createChild({ Image: IMAGE });
    expect(creates()).toHaveLength(1);

    const r = await send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

    expect(r.status, r.body).toBe(403);
    expect(creates()).toHaveLength(1);
  });

  it("moves children the daemon no longer has to exited before it decides the cap", async () => {
    // `docker run --rm` children: auto-removed, never removed through the proxy.
    for (let n = 0; n < 16; n += 1) await insertChildRow(n, "running", "gone");

    const id = await createChild({ Image: IMAGE });

    const rows = await tx((trx) => store.listContainersForTask(trx, TASK_ID));
    expect(rows.filter((row) => row.depth === 1 && row.status === "exited")).toHaveLength(16);
    expect((await rowOf(id))?.status).toBe("starting");
  });

  it("counts a child that exited but was not removed, which the daemon still has", async () => {
    for (let n = 0; n < 16; n += 1) await insertChildRow(n, "running", "present");

    const r = await send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

    expect(r.status, r.body).toBe(403);
    const rows = await tx((trx) => store.listContainersForTask(trx, TASK_ID));
    expect(rows.filter((row) => row.status === "running")).toHaveLength(16);
  });

  it("counts a create in flight, so the second of two concurrent creates past 15 live children is denied", async () => {
    for (let n = 0; n < 15; n += 1) await insertChildRow(n, "running", "present");
    const released = Promise.withResolvers<void>();
    createGate = released.promise;

    const first = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
    try {
      await vi.waitFor(() => expect(creates()).toHaveLength(1));

      // The first is still held at the daemon.
      const second = await send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

      expect(second.status, second.body).toBe(403);
      expect(creates()).toHaveLength(1);
    } finally {
      released.resolve();
    }
    expect((await first).status).toBe(201);
  });

  it("counts a create still held on a retiring socket against a re-registration's cap", async () => {
    for (let n = 0; n < 15; n += 1) await insertChildRow(n, "running", "present");
    const released = Promise.withResolvers<void>();
    createGate = released.promise;
    const first = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE })).catch(
      () => null,
    );
    try {
      await vi.waitFor(() => expect(creates()).toHaveLength(1));
      const unregistering = proxy.unregisterTask(TASK_ID);
      const replacement = await proxy.registerTask(scope);

      const second = requestOverSocket(replacement, {
        method: "POST",
        path: "/containers/create",
        body: JSON.stringify({ Image: IMAGE }),
      });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(creates()).toHaveLength(1);
      released.resolve();
      expect((await second).status).toBe(403);
      await unregistering;
    } finally {
      released.resolve();
    }
    await first;
  });

  it("removes the container and answers 502 when the row is not written within the create's deadline", async () => {
    const inserted = Promise.withResolvers<void>();
    childWriteGate = inserted.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let creating: Promise<SocketResponse>;
    try {
      creating = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
      await vi.waitFor(() => expect(creates()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    try {
      const child = expectDefined(createdIds.at(-1), "the created child");

      const r = await resolvesWithin(creating, 2_500, "the create's answer");

      expect(r.status, r.body).toBe(502);
      await vi.waitFor(() =>
        expect(received()).toContain(`DELETE /containers/${child}?force=true&v=true`),
      );
    } finally {
      inserted.resolve();
    }
    // The insert lands late, over a container already removed, and goes to exited.
    const child = expectDefined(createdIds.at(-1), "the created child");
    await vi.waitFor(async () => expect((await rowOf(child))?.status).toBe("exited"));
  });

  it("answers 502 to a create the daemon never answers before its deadline, recording nothing and releasing its admission", async () => {
    createGate = new Promise(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let creating: Promise<SocketResponse>;
    try {
      creating = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
      await vi.waitFor(() => expect(creates()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    const child = expectDefined(createdIds.at(-1), "the created child");

    const r = await resolvesWithin(creating, 2_500, "the create's answer");

    expect(r.status, r.body).toBe(502);
    await vi.waitFor(() => expect(abandonedCreates).toBe(1));
    expect(await rowOf(child)).toBeUndefined();
    // With no admission left, the teardown has no create to wait for.
    await resolvesWithin(proxy.unregisterTask(TASK_ID), 2_500, "the teardown");
  });

  it("answers 502 at the deadline without waiting for the rollback's removal", async () => {
    const inserted = Promise.withResolvers<void>();
    childWriteGate = inserted.promise;
    const killed = Promise.withResolvers<void>();
    onKill = () => killed.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let creating: Promise<SocketResponse>;
    try {
      creating = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
      await vi.waitFor(() => expect(creates()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    const child = expectDefined(createdIds.at(-1), "the created child");
    try {
      const r = await resolvesWithin(creating, 2_500, "the create's answer");

      expect(r.status, r.body).toBe(502);
      expect(received()).toContain(`POST /containers/${child}/kill?signal=SIGTERM`);
      expect(received()).not.toContain(`DELETE /containers/${child}?force=true&v=true`);
    } finally {
      killed.resolve();
      inserted.resolve();
    }
    // The removal finishes in the background.
    await vi.waitFor(() =>
      expect(received()).toContain(`DELETE /containers/${child}?force=true&v=true`),
    );
  });

  it("reads the rows for the cap after the image inspect, so creates held there land at most one past it", async () => {
    for (let n = 0; n < 15; n += 1) await insertChildRow(n, "running", "present");
    const parked: Array<() => void> = [];
    onInspect = () => new Promise<void>((resolve) => parked.push(resolve));
    const first = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
    const second = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
    const third = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
    await vi.waitFor(() => expect(parked).toHaveLength(3));

    // The first create's inspect is answered, and it is recorded and answered.
    expectDefined(parked[0], "the first inspect")();
    expect((await first).status).toBe(201);
    expectDefined(parked[1], "the second inspect")();
    expectDefined(parked[2], "the third inspect")();

    expect([(await second).status, (await third).status]).toEqual([403, 403]);
    expect(creates()).toHaveLength(1);
  });

  it("counts a create whose row has committed once, as a row, not again as a create in flight", async () => {
    for (let n = 0; n < 14; n += 1) await insertChildRow(n, "running", "present");
    const recorded = Promise.withResolvers<void>();
    recordGate = recorded.promise;
    const first = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
    try {
      await vi.waitFor(async () => {
        const child = expectDefined(createdIds.at(0), "the first child");
        expect(await rowOf(child)).toBeDefined();
      });

      // 14 rows, and the first create's row: room for one more.
      const second = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));

      await vi.waitFor(() => expect(creates()).toHaveLength(2));
      recorded.resolve();
      expect((await second).status).toBe(201);
    } finally {
      recorded.resolve();
    }
    expect((await first).status).toBe(201);
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

describe("a client that hangs up once the daemon has its request", () => {
  it("still has its child's row moved to running once the daemon has started it", async () => {
    const id = await createChild({ Image: IMAGE });
    const answer = Promise.withResolvers<void>();
    onStart = () => answer.promise;
    const { hangUp } = sendRaw("POST", `/containers/${id}/start`);
    await vi.waitFor(() => expect(received()).toContain(`POST /containers/${id}/start`));

    hangUp();
    // The proxy sees the hang-up before the daemon answers.
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer.resolve();

    await vi.waitFor(async () => expect((await rowOf(id))?.status).toBe("running"));
  });

  it("still has its child's row moved to running once the daemon has restarted it", async () => {
    const id = await createChild({ Image: IMAGE });
    const answer = Promise.withResolvers<void>();
    onRestart = () => answer.promise;
    const { hangUp } = sendRaw("POST", `/containers/${id}/restart`);
    await vi.waitFor(() => expect(received()).toContain(`POST /containers/${id}/restart`));

    hangUp();
    // The proxy sees the hang-up before the daemon answers.
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer.resolve();

    await vi.waitFor(async () => expect((await rowOf(id))?.status).toBe("running"));
  });

  it("still has a child the daemon started under a reaped row killed and removed", async () => {
    const id = await createChild({ Image: IMAGE });
    const answer = Promise.withResolvers<void>();
    onStart = async (dockerId) => {
      await answer.promise;
      await db.execute(
        sql`UPDATE containers SET status = 'reaped', reaped_reason = 'ttl_expired', exited_at = now() WHERE docker_id = ${dockerId}`,
      );
    };
    const { hangUp } = sendRaw("POST", `/containers/${id}/start`);
    await vi.waitFor(() => expect(received()).toContain(`POST /containers/${id}/start`));

    hangUp();
    // The proxy sees the hang-up before the daemon answers.
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer.resolve();

    await vi.waitFor(() =>
      expect(received()).toEqual(
        expect.arrayContaining([
          `POST /containers/${id}/kill?signal=SIGTERM`,
          `DELETE /containers/${id}?force=true&v=true`,
        ]),
      ),
    );
  });

  it("still has its removed child's row moved to exited", async () => {
    const id = await createChild({ Image: IMAGE });
    const answer = Promise.withResolvers<void>();
    onRemove = () => answer.promise;
    const { hangUp } = sendRaw("DELETE", `/containers/${id}?force=1`);
    await vi.waitFor(() => expect(received()).toContain(`DELETE /containers/${id}?force=1&v=true`));

    hangUp();
    // The proxy sees the hang-up before the daemon answers.
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer.resolve();

    await vi.waitFor(async () => expect((await rowOf(id))?.status).toBe("exited"));
  });
});

describe("two teardowns of one task", () => {
  it("both wait for a create the daemon has answered before either cascade lists the task's rows", async () => {
    const sandbox = await LocalDockerSandboxClient.create({
      docker: new Docker({ socketPath: daemon.socketPath }),
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: scope.instanceId,
      proxy,
    });
    const inserted = Promise.withResolvers<void>();
    childWriteGate = inserted.promise;
    const creating = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE }));
    await vi.waitFor(() => expect(creates()).toHaveLength(1));
    // The daemon has answered, and the insert waits at its gate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // From here, only a cascade lists the task's rows.
    const listed = vi.spyOn(store, "listContainersForTask");
    try {
      const first = sandbox.deleteByTaskId(TASK_ID);
      const second = sandbox.deleteByTaskId(TASK_ID);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(listed).not.toHaveBeenCalled();

      inserted.resolve();
      await Promise.all([first, second]);
      expect((await creating).status).toBe(201);
      const child = expectDefined(createdIds.at(-1), "the created child");
      expect(await rowOf(child)).toMatchObject({ status: "reaped", reapedReason: "cascade" });
    } finally {
      inserted.resolve();
      listed.mockRestore();
    }
  });
});

describe("a create outliving the teardown's wait", () => {
  it("removes its child once the teardown aborts the held insert, and takes the late row exited", async () => {
    const sandbox = await LocalDockerSandboxClient.create({
      docker: new Docker({ socketPath: daemon.socketPath }),
      store,
      runInTx: tx,
      runtime: "runc",
      instanceId: scope.instanceId,
      proxy,
    });
    const inserted = Promise.withResolvers<void>();
    childWriteGate = inserted.promise;
    // The teardown ends the client's connection before the insert lands.
    const creating = send("POST", "/containers/create", JSON.stringify({ Image: IMAGE })).catch(
      () => null,
    );
    await vi.waitFor(() => expect(creates()).toHaveLength(1));
    // The daemon has answered, and the insert waits at its gate.
    await new Promise((resolve) => setTimeout(resolve, 50));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let deleting: Promise<void>;
    try {
      deleting = sandbox.deleteByTaskId(TASK_ID);
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      vi.useRealTimers();
    }
    await deleting;
    const child = expectDefined(createdIds.at(-1), "the created child");
    try {
      // After the cascade: no row, and the container removed.
      await vi.waitFor(() =>
        expect(received()).toContain(`DELETE /containers/${child}?force=true&v=true`),
      );
      expect(await rowOf(child)).toBeUndefined();
    } finally {
      inserted.resolve();
    }
    await creating;
    // The insert commits late, over a container already gone: not live, so no reap needs it.
    await vi.waitFor(async () => expect((await rowOf(child))?.status).toBe("exited"));

    const tick = await runReap({
      docker: new Docker({ socketPath: daemon.socketPath }),
      store,
      runInTx: tx,
      instanceId: scope.instanceId,
      now: () => new Date(),
    });

    expect(tick.staleMarked).toBe(0);
  });
});
