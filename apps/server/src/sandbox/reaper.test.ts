import type Docker from "dockerode";
import { sql } from "drizzle-orm";
import { match } from "ts-pattern";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { markChildExited } from "./mark-child-exited.js";
import { runReap } from "./reaper.js";
import { type ContainerTransition, DrizzleSandboxStore } from "./store/index.js";
import type { ContainerLabels, ResourceLimits } from "./types.js";

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 0.5,
  memory_bytes: 256 * 1024 * 1024,
  pids: 64,
};

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSandboxStore;
let instanceId: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSandboxStore();
});

beforeEach(async () => {
  const inst = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 1 }));
  instanceId = inst.id;
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

function labels(extra: Partial<ContainerLabels> = {}): ContainerLabels {
  return {
    "cogmo.managed": "true",
    "cogmo.instance": instanceId,
    "cogmo.root_task": TASK_ID,
    "cogmo.parent": "",
    "cogmo.depth": "0",
    ...extra,
  };
}

interface DockerSideContainer {
  Id: string;
  /** The daemon's create time, in Unix seconds. */
  Created: number;
  Labels?: Record<string, string>;
}

/**
 * Stub Docker enough to drive the reaper. Tracks killed/removed ids per
 * resource so tests can assert order + count.
 */
function fakeDocker(
  opts: {
    containers?: DockerSideContainer[];
    failKill?: Map<string, number>;
    failRemove?: Map<string, number>;
    /** Runs before a kill is recorded — simulates another path finishing the row mid-pass. */
    onKill?: (id: string) => Promise<void>;
    /** Runs before `listContainers` answers — same purpose, between the TTL read and the stale pass. */
    onList?: () => Promise<void>;
  } = {},
): {
  docker: Docker;
  killCalls: string[];
  removeCalls: string[];
  networkRemoveCalls: string[];
  volumeRemoveCalls: string[];
} {
  const killCalls: string[] = [];
  const removeCalls: string[] = [];
  const networkRemoveCalls: string[] = [];
  const volumeRemoveCalls: string[] = [];
  const containers = opts.containers ?? [];
  const docker = {
    listContainers: vi.fn(async () => {
      await opts.onList?.();
      return containers;
    }),
    getContainer: (id: string) => ({
      kill: vi.fn(async () => {
        await opts.onKill?.(id);
        const code = opts.failKill?.get(id);
        if (code !== undefined) {
          throw Object.assign(new Error("nope"), { statusCode: code });
        }
        killCalls.push(id);
      }),
      remove: vi.fn(async () => {
        const code = opts.failRemove?.get(id);
        if (code !== undefined) {
          throw Object.assign(new Error("nope"), { statusCode: code });
        }
        removeCalls.push(id);
      }),
    }),
    getNetwork: (id: string) => ({
      remove: vi.fn(async () => {
        networkRemoveCalls.push(id);
      }),
    }),
    getVolume: (id: string) => ({
      remove: vi.fn(async () => {
        volumeRemoveCalls.push(id);
      }),
    }),
  };
  return {
    docker: docker as any,
    killCalls,
    removeCalls,
    networkRemoveCalls,
    volumeRemoveCalls,
  };
}

const NOW = () => new Date("2026-04-27T12:00:00Z");

/** A daemon `Created` time, in Unix seconds, `ms` before the fake `NOW`. */
function createdAgo(ms: number): number {
  return Math.floor((NOW().getTime() - ms) / 1000);
}

/** Created an hour before the fake `NOW`: past any grace window. */
const LONG_AGO = createdAgo(60 * 60_000);

async function insertContainer(opts: {
  dockerId: string;
  /** TTL offset relative to the fake `NOW` — negative = expired. */
  ttlMs: number;
  status?: "starting" | "running" | "exited" | "reaped";
  depth?: number;
  rootTaskId?: string;
  instanceId?: string;
  parentId?: string | null;
}): Promise<string> {
  const row = await tx((trx) =>
    store.insertContainer(trx, {
      dockerId: opts.dockerId,
      parentId: opts.parentId ?? null,
      rootTaskId: opts.rootTaskId ?? TASK_ID,
      depth: opts.depth ?? 0,
      image: "img",
      runtime: "runc",
      labels: labels(),
      resourceLimits: RESOURCE_LIMITS,
      ttlExpiresAt: new Date(NOW().getTime() + opts.ttlMs),
      instanceId: opts.instanceId ?? instanceId,
    }),
  );
  // Walk the row through the state machine to the requested status.
  const steps: ContainerTransition[] = match(opts.status)
    .with(undefined, "starting", () => [])
    .with("running", () => [{ from: "starting" as const, to: "running" as const }])
    .with("exited", () => [
      { from: "starting" as const, to: "running" as const },
      { from: "running" as const, to: "exited" as const },
    ])
    .with("reaped", () => [
      { from: "starting" as const, to: "running" as const },
      { to: "reaped" as const, reason: "cascade" as const },
    ])
    .exhaustive();
  for (const step of steps) {
    await tx((trx) => store.transitionContainerStatus(trx, { id: row.id, at: NOW(), ...step }));
  }
  return row.id;
}

describe("runReap — TTL pass", () => {
  it("reaps containers whose TTL has expired and were running", async () => {
    const dockerSide: DockerSideContainer[] = [{ Id: "c1", Created: LONG_AGO, Labels: labels() }];
    const { docker, killCalls, removeCalls } = fakeDocker({ containers: dockerSide });
    const cogmoId = await insertContainer({
      dockerId: "c1",
      ttlMs: -1000, // expired 1s ago (relative to real now; test uses fake now anyway)
      status: "running",
    });

    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect(killCalls).toEqual(["c1"]);
    expect(removeCalls).toEqual(["c1"]);
    const reloaded = await tx((trx) => store.getContainer(trx, cogmoId));
    expect(reloaded?.status).toBe("reaped");
    expect(reloaded?.reapedReason).toBe("ttl_expired");
  });

  it.each([
    { code: 304, label: "304 ('container already stopped')" },
    { code: 409, label: "409 ('container is not running')" },
    { code: 404, label: "404 ('no such container')" },
  ])("swallows kill rejection with statusCode $label", async ({ code }) => {
    const { docker, removeCalls } = fakeDocker({
      containers: [{ Id: "c-gone", Created: LONG_AGO, Labels: labels() }],
      failKill: new Map([["c-gone", code]]),
    });
    const cogmoId = await insertContainer({
      dockerId: "c-gone",
      ttlMs: -1000,
      status: "running",
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect(removeCalls).toEqual(["c-gone"]);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("reaped");
  });

  it.each([
    { code: 404, label: "404 ('no such container')" },
    { code: 409, label: "409 ('removal already in progress')" },
  ])("swallows remove rejection with statusCode $label", async ({ code }) => {
    // 409 is moby's `SetRemovalInProgress` race-protection (daemon/delete.go);
    // fires when reaper + `deleteByTaskId` hit the same container.
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-rm-race", Created: LONG_AGO, Labels: labels() }],
      failRemove: new Map([["c-rm-race", code]]),
    });
    const cogmoId = await insertContainer({
      dockerId: "c-rm-race",
      ttlMs: -1000,
      status: "running",
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect(killCalls).toEqual(["c-rm-race"]);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("reaped");
  });

  it("does not reap containers with future TTL", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-fresh", Created: LONG_AGO, Labels: labels() }],
    });
    await insertContainer({ dockerId: "c-fresh", ttlMs: 60_000, status: "running" });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("kills children before parents (depth DESC)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [
        { Id: "parent", Created: LONG_AGO, Labels: labels() },
        { Id: "child", Created: LONG_AGO, Labels: labels() },
      ],
    });
    const parentId = await insertContainer({
      dockerId: "parent",
      ttlMs: -1000,
      status: "running",
      depth: 0,
    });
    await insertContainer({
      dockerId: "child",
      ttlMs: -1000,
      status: "running",
      depth: 1,
      parentId,
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(2);
    expect(killCalls).toEqual(["child", "parent"]);
  });

  it("skips already-reaped rows on re-tick (idempotent)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-old", Created: LONG_AGO, Labels: labels() }],
    });
    await insertContainer({
      dockerId: "c-old",
      ttlMs: -10_000,
      status: "reaped",
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("does NOT reap a container whose TTL is exactly now() (filter uses strict <)", async () => {
    // Boundary case: a container whose TTL lands precisely on the reaper's
    // current clock should remain alive for one more tick. The filter at
    // reaper.ts:75 uses `< now`, not `<=`. A regression to `<=` would
    // shave a minute off every container's effective TTL — small in
    // absolute terms but a silent contract drift.
    const cogmoId = await insertContainer({
      dockerId: "c-boundary",
      ttlMs: 0, // expires_at === NOW()
      status: "running",
    });
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-boundary", Created: LONG_AGO, Labels: labels() }],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(0);
    expect(killCalls).toEqual([]);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("running");
  });
});

describe("runReap — orphan pass", () => {
  it("reaps a container labelled with a dead instance id", async () => {
    const deadInstance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 99 }));
    await tx((trx) => store.closeInstance(trx, deadInstance.id));
    const { docker, killCalls, removeCalls } = fakeDocker({
      containers: [
        {
          Id: "c-orphan",
          Created: LONG_AGO,
          Labels: { ...labels(), "cogmo.instance": deadInstance.id },
        },
      ],
    });
    // No DB row for c-orphan — purely Docker-side discovery.
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-orphan"]);
    expect(removeCalls).toEqual(["c-orphan"]);
  });

  it("reaps a container with no cogmo.instance label", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [
        {
          Id: "c-bare",
          Created: LONG_AGO,
          Labels: { "cogmo.managed": "true" }, // missing cogmo.instance
        },
      ],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-bare"]);
  });

  it("reaps a Docker container that has no DB row (orphan create)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-no-db", Created: LONG_AGO, Labels: labels() }],
    });
    // No insertContainer for c-no-db.
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-no-db"]);
  });

  it("skips a rowless container labelled with the live instance while it is under 2 minutes old", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-inserting", Created: createdAgo(119_000), Labels: labels() }],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("reaps a rowless container labelled with the live instance once 2 minutes have passed", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-rowless", Created: createdAgo(120_000), Labels: labels() }],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-rowless"]);
  });

  it("reaps a fresh container labelled with a dead instance at once", async () => {
    const deadInstance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 99 }));
    await tx((trx) => store.closeInstance(trx, deadInstance.id));
    const { docker, killCalls } = fakeDocker({
      containers: [
        {
          Id: "c-fresh-dead",
          Created: createdAgo(1_000),
          Labels: { ...labels(), "cogmo.instance": deadInstance.id },
        },
      ],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-fresh-dead"]);
  });

  it("leaves a fresh rowless container labelled with a prior instance whose row is still open", async () => {
    // A crash between the daemon's 201 and the insert leaves the instance row
    // open, which counts as live until boot reconcile closes it.
    const crashed = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 98 }));
    const { docker, killCalls } = fakeDocker({
      containers: [
        {
          Id: "c-crashed-create",
          Created: createdAgo(10_000),
          Labels: { ...labels(), "cogmo.instance": crashed.id },
        },
      ],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("does NOT reap a healthy container (live instance + DB row present)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-good", Created: LONG_AGO, Labels: labels() }],
    });
    await insertContainer({ dockerId: "c-good", ttlMs: 60_000, status: "running" });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("marks the DB row reaped when an orphan with a stale-instance row is killed", async () => {
    const deadInstance = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 99 }));
    await tx((trx) => store.closeInstance(trx, deadInstance.id));
    const cogmoId = await insertContainer({
      dockerId: "c-stale-row",
      ttlMs: 60_000,
      status: "running",
      instanceId: deadInstance.id,
    });
    const { docker } = fakeDocker({
      containers: [
        {
          Id: "c-stale-row",
          Created: LONG_AGO,
          Labels: { ...labels(), "cogmo.instance": deadInstance.id },
        },
      ],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    const row = await tx((trx) => store.getContainer(trx, cogmoId));
    expect(row?.status).toBe("reaped");
    expect(row?.reapedReason).toBe("dead_instance");
  });
});

describe("runReap — stale DB pass", () => {
  it("marks a row exited when it's not in Docker's listing anymore", async () => {
    const cogmoId = await insertContainer({
      dockerId: "c-vanished",
      ttlMs: 60_000,
      status: "running",
    });
    const { docker } = fakeDocker({ containers: [] });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.staleMarked).toBe(1);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("exited");
  });

  it("does not double-count rows the TTL pass just reaped", async () => {
    await insertContainer({ dockerId: "c-double", ttlMs: -1000, status: "running" });
    const { docker } = fakeDocker({
      containers: [{ Id: "c-double", Created: LONG_AGO, Labels: labels() }],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect(result.staleMarked).toBe(0);
  });
});

describe("runReap — a row another path already finished", () => {
  // Between a pass reading a row and writing its terminal status, a cascade
  // (`deleteByTaskId`) or the previous tick can finish the same row. The
  // write is conditional on the status the pass read, so the row keeps the
  // terminal state and timestamp the other path gave it.
  const EARLIER = "2026-04-27T11:00:00.000Z";

  async function reapedElsewhere(id: string): Promise<void> {
    await db.execute(
      sql`UPDATE containers SET status = 'reaped', reaped_reason = 'cascade', exited_at = ${EARLIER}::timestamptz WHERE id = ${id}`,
    );
  }

  it("TTL pass: a row reaped during its kill is neither re-written nor counted", async () => {
    const cogmoId = await insertContainer({ dockerId: "c-raced", ttlMs: -1000, status: "running" });
    const { docker } = fakeDocker({
      containers: [{ Id: "c-raced", Created: LONG_AGO, Labels: labels() }],
      onKill: () => reapedElsewhere(cogmoId),
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(0);
    const row = await tx((trx) => store.getContainer(trx, cogmoId));
    expect(row?.status).toBe("reaped");
    expect(row?.exitedAt?.toISOString()).toBe(EARLIER);
  });

  it("TTL pass: a row a proxy DELETE moved to exited during its kill is reaped once, keeping its exit time", async () => {
    const cogmoId = await insertContainer({
      dockerId: "c-deleted",
      ttlMs: -1000,
      status: "running",
      depth: 1,
    });
    const { docker } = fakeDocker({
      containers: [{ Id: "c-deleted", Created: LONG_AGO, Labels: labels() }],
      onKill: async () => {
        await db.execute(
          sql`UPDATE containers SET status = 'exited', exited_at = ${EARLIER}::timestamptz WHERE id = ${cogmoId}`,
        );
      },
    });

    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });

    expect(result.ttlReaped).toBe(1);
    const row = await tx((trx) => store.getContainer(trx, cogmoId));
    expect(row).toMatchObject({ status: "reaped", reapedReason: "ttl_expired" });
    expect(row?.exitedAt?.toISOString()).toBe(EARLIER);
  });

  it("TTL pass: a cut-off create's late row moved to exited during its kill is reaped once, keeping its exit time", async () => {
    const cogmoId = await insertContainer({
      dockerId: "c-late",
      ttlMs: -1000,
      status: "starting",
      depth: 1,
    });
    const { docker } = fakeDocker({
      containers: [{ Id: "c-late", Created: LONG_AGO, Labels: labels() }],
      // The cut-off rollback's late-row write commits while the TTL pass kills.
      onKill: async () => {
        const exited = await markChildExited(
          { store, runInTx: tx },
          {
            child: {
              id: cogmoId,
              dockerId: "c-late",
              parentId: null,
              depth: 1,
              status: "starting",
            },
            cause: "cut_off_create",
            at: new Date(EARLIER),
          },
        );
        expect(exited.isOk()).toBe(true);
      },
    });

    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });

    expect(result.ttlReaped).toBe(1);
    const row = await tx((trx) => store.getContainer(trx, cogmoId));
    expect(row).toMatchObject({ status: "reaped", reapedReason: "ttl_expired" });
    expect(row?.exitedAt?.toISOString()).toBe(EARLIER);
  });

  it("stale pass: a row reaped after the TTL read is not marked exited", async () => {
    const cogmoId = await insertContainer({
      dockerId: "c-gone-mid-tick",
      ttlMs: 60_000,
      status: "running",
    });
    // The cascade removed the container and marked the row before the orphan
    // pass listed the daemon, so the listing no longer has it.
    const { docker } = fakeDocker({ containers: [], onList: () => reapedElsewhere(cogmoId) });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.staleMarked).toBe(0);
    const row = await tx((trx) => store.getContainer(trx, cogmoId));
    expect(row?.status).toBe("reaped");
    expect(row?.exitedAt?.toISOString()).toBe(EARLIER);
  });
});

describe("runReap — a row another path moved forward", () => {
  // `create()` holds a `starting` row between `createContainer` and the
  // running transition. A pass that read it as `starting` and then kills the
  // container must still land the reap when `create()` committed
  // `starting → running` in between: the container is gone either way.
  it("TTL pass: a starting row that became running during its kill is reaped", async () => {
    const cogmoId = await insertContainer({ dockerId: "c-fwd", ttlMs: -1000, status: "starting" });
    const { docker } = fakeDocker({
      containers: [{ Id: "c-fwd", Created: LONG_AGO, Labels: labels() }],
      onKill: async () => {
        await tx((trx) =>
          store.transitionContainerStatus(trx, {
            id: cogmoId,
            from: "starting",
            to: "running",
            at: NOW(),
          }),
        );
      },
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("reaped");
  });

  it("stale pass: a starting row that became running after the read is left for the next tick", async () => {
    const cogmoId = await insertContainer({
      dockerId: "c-fwd-stale",
      ttlMs: 60_000,
      status: "starting",
    });
    let started = false;
    const { docker } = fakeDocker({
      containers: [],
      onList: async () => {
        if (started) return;
        started = true;
        await tx((trx) =>
          store.transitionContainerStatus(trx, {
            id: cogmoId,
            from: "starting",
            to: "running",
            at: NOW(),
          }),
        );
      },
    });

    const first = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });

    expect(first.staleMarked).toBe(0);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("running");

    const second = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });

    expect(second.staleMarked).toBe(1);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("exited");
  });
});

describe("runReap — networks + volumes", () => {
  it("reaps expired networks", async () => {
    const net = await tx((trx) =>
      store.insertNetwork(trx, {
        dockerId: "net-old",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(NOW().getTime() - 1000),
        instanceId,
      }),
    );
    const { docker, networkRemoveCalls } = fakeDocker();
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.networksReaped).toBe(1);
    expect(networkRemoveCalls).toEqual(["net-old"]);
    expect((await tx((trx) => store.getNetwork(trx, net.id)))?.status).toBe("reaped");
  });

  it("reaps expired volumes", async () => {
    const vol = await tx((trx) =>
      store.insertVolume(trx, {
        dockerId: "vol-old",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(NOW().getTime() - 1000),
        instanceId,
      }),
    );
    const { docker, volumeRemoveCalls } = fakeDocker();
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.volumesReaped).toBe(1);
    expect(volumeRemoveCalls).toEqual(["vol-old"]);
    expect((await tx((trx) => store.getVolume(trx, vol.id)))?.status).toBe("reaped");
  });

  it("skips already-reaped networks/volumes (idempotent)", async () => {
    const net = await tx((trx) =>
      store.insertNetwork(trx, {
        dockerId: "net-already-gone",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(NOW().getTime() - 60_000),
        instanceId,
      }),
    );
    await tx((trx) => store.updateNetworkStatus(trx, { id: net.id, status: "reaped" }));
    const { docker, networkRemoveCalls } = fakeDocker();
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.networksReaped).toBe(0);
    expect(networkRemoveCalls).toEqual([]);
  });

  it("does not reap networks with future TTL", async () => {
    await tx((trx) =>
      store.insertNetwork(trx, {
        dockerId: "net-fresh",
        parentId: null,
        rootTaskId: TASK_ID,
        depth: 0,
        labels: labels(),
        ttlExpiresAt: new Date(NOW().getTime() + 60_000),
        instanceId,
      }),
    );
    const { docker } = fakeDocker();
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.networksReaped).toBe(0);
  });
});

describe("runReap — resilience", () => {
  it("survives a docker.listContainers failure (orphan pass logs and continues)", async () => {
    await insertContainer({ dockerId: "c-x", ttlMs: -1000, status: "running" });
    const docker = {
      listContainers: vi.fn(async () => {
        throw new Error("daemon down");
      }),
      getContainer: () => ({
        kill: vi.fn(),
        remove: vi.fn(),
      }),
      getNetwork: () => ({ remove: vi.fn() }) as any,
      getVolume: () => ({ remove: vi.fn() }) as any,
    };
    const result = await runReap({
      docker: docker as any,
      store,
      runInTx: tx,
      instanceId,
      now: NOW,
    });
    // TTL pass still ran (it doesn't depend on listContainers).
    expect(result.ttlReaped).toBe(1);
    // Orphan pass got 0 (listContainers threw, dockerContainers is empty).
    expect(result.orphansReaped).toBe(0);
  });

  it("skips the stale-DB pass entirely when listContainers fails (regression canary)", async () => {
    // Disastrous failure mode if the stale pass ran on a failed listContainers:
    // an empty `dockerContainers` array is indistinguishable from "no
    // containers exist", so every live DB row would get its `dockerIdSet`
    // miss and be marked `exited`. Every running task would lose its
    // admission slot and be reported as terminal — silent data loss.
    //
    // The reaper guards this via the `dockerListOk` flag (reaper.ts:138).
    // This test asserts the guard works: with several live containers in
    // the DB and a thrown listContainers, NONE of them are marked exited
    // by the stale pass. The TTL pass is independently exercised in the
    // sibling test above.
    const aliveA = await insertContainer({
      dockerId: "c-alive-a",
      ttlMs: 60_000,
      status: "running",
    });
    const aliveB = await insertContainer({
      dockerId: "c-alive-b",
      ttlMs: 60_000,
      status: "starting",
    });
    const docker = {
      listContainers: vi.fn(async () => {
        throw new Error("daemon down");
      }),
      getContainer: () => ({ kill: vi.fn(), remove: vi.fn() }),
      getNetwork: () => ({ remove: vi.fn() }) as any,
      getVolume: () => ({ remove: vi.fn() }) as any,
    };
    const result = await runReap({
      docker: docker as any,
      store,
      runInTx: tx,
      instanceId,
      now: NOW,
    });
    expect(result.staleMarked).toBe(0);
    expect((await tx((trx) => store.getContainer(trx, aliveA)))?.status).toBe("running");
    expect((await tx((trx) => store.getContainer(trx, aliveB)))?.status).toBe("starting");
  });
});

describe("runReap — the next tick after a failure", () => {
  // The states a failed write or removal leaves a row in, fed to the next
  // tick on each side of the row's expiry.
  it.each([
    [
      "a live row over a container that is gone, before expiry",
      "running",
      "gone",
      60_000,
      { status: "exited", reapedReason: null },
    ],
    [
      "a live row over a container that is gone, after expiry",
      "running",
      "gone",
      -1_000,
      { status: "reaped", reapedReason: "ttl_expired" },
    ],
    [
      "a starting row over a container never started, before expiry",
      "starting",
      "present",
      60_000,
      { status: "starting", reapedReason: null },
    ],
    [
      "a starting row over a container never started, after expiry",
      "starting",
      "present",
      -1_000,
      { status: "reaped", reapedReason: "ttl_expired" },
    ],
    [
      "an exited row, after expiry, which the TTL pass leaves to the cascade",
      "exited",
      "gone",
      -1_000,
      { status: "exited", reapedReason: null },
    ],
    [
      "a starting row over a container that is gone, before expiry",
      "starting",
      "gone",
      60_000,
      { status: "exited", reapedReason: null },
    ],
    [
      "a starting row over a container that is gone, after expiry",
      "starting",
      "gone",
      -1_000,
      { status: "reaped", reapedReason: "ttl_expired" },
    ],
    [
      "a starting row over a container that is running, before expiry",
      "starting",
      "present",
      60_000,
      { status: "starting", reapedReason: null },
    ],
    [
      "a starting row over a container that is running, after expiry",
      "starting",
      "present",
      -1_000,
      { status: "reaped", reapedReason: "ttl_expired" },
    ],
  ] as const)("%s", async (_label, status, onDaemon, ttlMs, expected) => {
    const id = await insertContainer({ dockerId: "c-after-failure", ttlMs, status });
    const listed: DockerSideContainer[] = match(onDaemon)
      .with("present", (): DockerSideContainer[] => [
        { Id: "c-after-failure", Created: LONG_AGO, Labels: labels() },
      ])
      .with("gone", (): DockerSideContainer[] => [])
      .exhaustive();
    const { docker } = fakeDocker({ containers: listed });

    await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });

    expect(await tx((trx) => store.getContainer(trx, id))).toMatchObject(expected);
  });

  it("reaps at once a row and container whose instance reconcile closed after failing to remove it", async () => {
    // Reconcile closes the instance row even when its kill failed, so the
    // next tick sees the instance dead, whatever the container's age.
    const prior = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 97 }));
    const id = await insertContainer({
      dockerId: "c-reconcile-failed",
      ttlMs: 60_000,
      status: "running",
      instanceId: prior.id,
    });
    await tx((trx) => store.closeInstances(trx, [prior.id]));
    const { docker, killCalls } = fakeDocker({
      containers: [
        {
          Id: "c-reconcile-failed",
          Created: createdAgo(5_000),
          Labels: { ...labels(), "cogmo.instance": prior.id },
        },
      ],
    });

    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });

    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-reconcile-failed"]);
    expect(await tx((trx) => store.getContainer(trx, id))).toMatchObject({
      status: "reaped",
      reapedReason: "dead_instance",
    });
  });

  it("removes at once a fresh rowless child whose instance reconcile closed after failing to remove it", async () => {
    // Reconcile closes the prior instance however its removals went, so the
    // child's grace window, which covers only a live instance, does not apply.
    const prior = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 95 }));
    await tx((trx) => store.closeInstances(trx, [prior.id]));
    const { docker, killCalls } = fakeDocker({
      containers: [
        {
          Id: "c-rowless-handoff",
          Created: createdAgo(5_000),
          Labels: { ...labels(), "cogmo.instance": prior.id, "cogmo.depth": "1" },
        },
      ],
    });

    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });

    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-rowless-handoff"]);
  });

  it("makes one transition when two orphan passes remove one dead-instance object, each counting it", async () => {
    const dead = await tx((trx) => store.insertInstance(trx, { host: "h", pid: 96 }));
    await tx((trx) => store.closeInstance(trx, dead.id));
    const id = await insertContainer({
      dockerId: "c-twice",
      ttlMs: 60_000,
      status: "running",
      instanceId: dead.id,
    });
    // Both passes kill before either transitions.
    const bothKilling = Promise.withResolvers<void>();
    let killing = 0;
    const { docker } = fakeDocker({
      containers: [
        { Id: "c-twice", Created: LONG_AGO, Labels: { ...labels(), "cogmo.instance": dead.id } },
      ],
      onKill: async () => {
        killing += 1;
        if (killing === 2) bothKilling.resolve();
        await bothKilling.promise;
      },
    });
    const transition = vi.spyOn(store, "transitionContainerStatus");

    const [first, second] = await Promise.all([
      runReap({ docker, store, runInTx: tx, instanceId, now: NOW }),
      runReap({ docker, store, runInTx: tx, instanceId, now: NOW }),
    ]);

    const outcomes = await Promise.all(transition.mock.results.map((r) => r.value));
    transition.mockRestore();
    expect(outcomes).toEqual(
      expect.arrayContaining([{ kind: "transitioned" }, { kind: "stale", status: "reaped" }]),
    );
    expect(outcomes).toHaveLength(2);
    expect([first.orphansReaped, second.orphansReaped]).toEqual([1, 1]);
    expect(await tx((trx) => store.getContainer(trx, id))).toMatchObject({
      status: "reaped",
      reapedReason: "dead_instance",
    });
  });
});

describe("runReap — concurrent invocation", () => {
  // Production guarantee: Inngest's singleton-by-name semantics on the
  // cron function id `sandbox-reaper` (see reaper.ts:223) prevent two
  // ticks from overlapping. The reaper itself takes no DB advisory lock
  // — its concurrency safety relies on that scheduler property.
  //
  // These tests pin the *post-interleave* contract: if two `runReap`
  // calls did somehow overlap (duplicate dispatch, manual invocation
  // alongside a tick, future scheduler swap), the terminal DB state
  // remains consistent — every targeted row lands in `reaped`, and the
  // sum of `ttlReaped` across both calls covers every container at
  // least once.
  //
  // What this suite intentionally does NOT pin: that each Docker
  // `kill` call happens exactly once, or that the totals sum to
  // exactly N. With no advisory lock around the TTL pass, both calls
  // can read the same `running` rows before either writes `reaped`, so
  // each row can be killed twice — `killAndRemoveContainer` tolerates
  // the 304/404 of an already-gone container — but the conditional
  // transition lets only one of them count it.

  it("two interleaved runReap calls reach a consistent terminal DB state", async () => {
    const dockerSide: DockerSideContainer[] = [
      { Id: "c-a", Created: LONG_AGO, Labels: labels() },
      { Id: "c-b", Created: LONG_AGO, Labels: labels() },
    ];
    const { docker, killCalls, removeCalls } = fakeDocker({ containers: dockerSide });
    const idA = await insertContainer({ dockerId: "c-a", ttlMs: -1000, status: "running" });
    const idB = await insertContainer({ dockerId: "c-b", ttlMs: -2000, status: "running" });

    const [r1, r2] = await Promise.all([
      runReap({ docker, store, runInTx: tx, instanceId, now: NOW }),
      runReap({ docker, store, runInTx: tx, instanceId, now: NOW }),
    ]);

    // Terminal DB state is identical to a single-run terminal state: the
    // second writer's transition finds the row already `reaped` and
    // leaves it, so whichever call commits last lands the same row.
    expect((await tx((trx) => store.getContainer(trx, idA)))?.status).toBe("reaped");
    expect((await tx((trx) => store.getContainer(trx, idB)))?.status).toBe("reaped");

    // Every TTL-expired container is killed at least once. The exact
    // count may be 1 or 2 per container depending on interleave —
    // `killAndRemove` is tolerant of repeats (statusCode 304/409/404 are
    // swallowed), so we only assert coverage.
    expect(new Set(killCalls)).toEqual(new Set(["c-a", "c-b"]));
    expect(new Set(removeCalls)).toEqual(new Set(["c-a", "c-b"]));

    // Each row is counted exactly once across both calls: the second
    // writer's transition is `stale`, which does not count.
    expect(r1.ttlReaped + r2.ttlReaped).toBe(2);
  });

  it("a second runReap after the first finished sees nothing to do", async () => {
    // Sequential, not interleaved: the second call starts cleanly after
    // the first has committed its terminal `reaped` row. This is the
    // "next cron tick" scenario — the production-realistic flow given
    // Inngest's singleton-by-name. Must be a complete no-op.
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-seq", Created: LONG_AGO, Labels: labels() }],
    });
    const cogmoId = await insertContainer({
      dockerId: "c-seq",
      ttlMs: -1000,
      status: "running",
    });

    const r1 = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(r1.ttlReaped).toBe(1);
    expect(killCalls).toEqual(["c-seq"]);

    // Second tick. The DB row is already `reaped`, so the TTL filter
    // (status === "running" || "starting") excludes it. The orphan
    // pass sees the Docker listing still contains c-seq (our stub
    // doesn't remove it) but `getContainerByDockerId` returns the
    // reaped row, which counts as "DB row present + live instance"
    // → not an orphan. The stale-DB pass also skips it because the
    // row is no longer running. Strict no-op.
    const r2 = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(r2.ttlReaped).toBe(0);
    expect(r2.staleMarked).toBe(0);
    expect(r2.orphansReaped).toBe(0);
    // killCalls is cumulative across both runs; only the first touched
    // the daemon.
    expect(killCalls).toEqual(["c-seq"]);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("reaped");
  });
});
