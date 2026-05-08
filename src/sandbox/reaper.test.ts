import type Docker from "dockerode";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../db/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { runReap } from "./reaper.js";
import { DrizzleSandboxStore } from "./store/index.js";
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
  Labels?: Record<string, string>;
}

/**
 * Stub Docker enough to drive the reaper. Tracks killed/removed ids per
 * resource so tests can assert order + count.
 */
function fakeDocker(opts: { containers?: DockerSideContainer[]; failKill?: Set<string> } = {}): {
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
    listContainers: vi.fn(async () => containers),
    getContainer: (id: string) => ({
      kill: vi.fn(async () => {
        if (opts.failKill?.has(id)) {
          throw Object.assign(new Error("nope"), { statusCode: 304 });
        }
        killCalls.push(id);
      }),
      remove: vi.fn(async () => {
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
  if (opts.status && opts.status !== "starting") {
    await tx((trx) => store.updateContainerStatus(trx, { id: row.id, status: opts.status }));
  }
  return row.id;
}

describe("runReap — TTL pass", () => {
  it("reaps containers whose TTL has expired and were running", async () => {
    const dockerSide: DockerSideContainer[] = [{ Id: "c1", Labels: labels() }];
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
  });

  it("does not reap containers with future TTL", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-fresh", Labels: labels() }],
    });
    await insertContainer({ dockerId: "c-fresh", ttlMs: 60_000, status: "running" });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(0);
    expect(killCalls).toEqual([]);
  });

  it("kills children before parents (depth DESC)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [
        { Id: "parent", Labels: labels() },
        { Id: "child", Labels: labels() },
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
      containers: [{ Id: "c-old", Labels: labels() }],
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
      containers: [{ Id: "c-boundary", Labels: labels() }],
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
      containers: [{ Id: "c-no-db", Labels: labels() }],
    });
    // No insertContainer for c-no-db.
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect(killCalls).toEqual(["c-no-db"]);
  });

  it("does NOT reap a healthy container (live instance + DB row present)", async () => {
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-good", Labels: labels() }],
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
          Labels: { ...labels(), "cogmo.instance": deadInstance.id },
        },
      ],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.orphansReaped).toBe(1);
    expect((await tx((trx) => store.getContainer(trx, cogmoId)))?.status).toBe("reaped");
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
      containers: [{ Id: "c-double", Labels: labels() }],
    });
    const result = await runReap({ docker, store, runInTx: tx, instanceId, now: NOW });
    expect(result.ttlReaped).toBe(1);
    expect(result.staleMarked).toBe(0);
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
  // can read the same `running` rows before either writes `reaped`,
  // so each row gets killed twice and counted twice. That's the
  // observed behaviour and is acceptable because (a) `killAndRemove`
  // tolerates a 304/404 (already-killed/already-gone) and (b) the
  // singleton scheduler keeps it out of production. If we ever add a
  // row-level lock, these tests will tighten.

  it("two interleaved runReap calls reach a consistent terminal DB state", async () => {
    const dockerSide: DockerSideContainer[] = [
      { Id: "c-a", Labels: labels() },
      { Id: "c-b", Labels: labels() },
    ];
    const { docker, killCalls, removeCalls } = fakeDocker({ containers: dockerSide });
    const idA = await insertContainer({ dockerId: "c-a", ttlMs: -1000, status: "running" });
    const idB = await insertContainer({ dockerId: "c-b", ttlMs: -2000, status: "running" });

    const [r1, r2] = await Promise.all([
      runReap({ docker, store, runInTx: tx, instanceId, now: NOW }),
      runReap({ docker, store, runInTx: tx, instanceId, now: NOW }),
    ]);

    // Terminal DB state is identical to a single-run terminal state.
    // `updateContainerStatus({status: "reaped"})` is idempotent at the
    // row level — a second write of the same value is a no-op-equivalent
    // — so whichever call commits last lands the same row contents.
    expect((await tx((trx) => store.getContainer(trx, idA)))?.status).toBe("reaped");
    expect((await tx((trx) => store.getContainer(trx, idB)))?.status).toBe("reaped");

    // Every TTL-expired container is killed at least once. The exact
    // count may be 1 or 2 per container depending on interleave —
    // `killAndRemove` is tolerant of repeats (statusCode 304/404 are
    // swallowed), so we only assert coverage.
    expect(new Set(killCalls)).toEqual(new Set(["c-a", "c-b"]));
    expect(new Set(removeCalls)).toEqual(new Set(["c-a", "c-b"]));

    // Sum of ttlReaped covers every container at least once. Without an
    // advisory lock, both calls can read the same `running` rows and
    // each claims an increment, so the sum can be up to 2 * N.
    expect(r1.ttlReaped + r2.ttlReaped).toBeGreaterThanOrEqual(2);
    expect(r1.ttlReaped + r2.ttlReaped).toBeLessThanOrEqual(4);
  });

  it("a second runReap after the first finished sees nothing to do", async () => {
    // Sequential, not interleaved: the second call starts cleanly after
    // the first has committed its terminal `reaped` row. This is the
    // "next cron tick" scenario — the production-realistic flow given
    // Inngest's singleton-by-name. Must be a complete no-op.
    const { docker, killCalls } = fakeDocker({
      containers: [{ Id: "c-seq", Labels: labels() }],
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
