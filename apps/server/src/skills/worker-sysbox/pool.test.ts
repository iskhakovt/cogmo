import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { SandboxClient } from "../../sandbox/index.js";
import { expectDefined } from "../../test/assertions.js";
import { seededRandom } from "../../test/seeded-random.js";
import type { CtxHandler } from "../dispatcher.js";
import type { Death } from "../worker-state.js";
import {
  DEFAULT_POOL_OPTIONS,
  SysboxWorkerPool,
  type SysboxWorkerPoolOptions,
  type WorkerHandle,
} from "./pool.js";
import type { InvokeParams, InvokeResult, WorkerStatus } from "./worker.js";

/** A fake worker with the real one's lease and death semantics. */
interface FakeWorker extends WorkerHandle {
  /** The supervisor goes away. */
  die(reason: string): void;
}

interface FakeWorkerOptions {
  now?: () => number;
  /** Runs each task; defaults to an immediate, reusable success. */
  invoke?: (params: InvokeParams) => Promise<InvokeResult>;
  /** Runs on dispose. */
  onDispose?: () => Promise<void>;
}

function fakeWorker(workerId: string, opts: FakeWorkerOptions = {}): FakeWorker {
  const now = opts.now ?? Date.now;
  let status: WorkerStatus = "idle";
  let held = false;
  let taskCount = 0;
  const createdAt = now();
  let lastUsed = createdAt;
  const dead = Promise.withResolvers<Death>();
  const disposable = Promise.withResolvers<void>();
  const end = (death: Death): void => {
    if (status === "dead" || status === "disposed") return;
    status = "dead";
    dead.resolve(death);
    if (!held) disposable.resolve();
  };

  const worker: FakeWorker = {
    workerId,
    get state() {
      return status;
    },
    get taskCount() {
      return taskCount;
    },
    dead: dead.promise,
    disposable: disposable.promise,
    idleMs: (n) => Math.max(0, n - lastUsed),
    ageMs: (n) => Math.max(0, n - createdAt),
    tryAcquire: () => {
      if (status !== "idle") return err(`cannot acquire a worker that is ${status}`);
      status = "busy";
      held = true;
      return ok(undefined);
    },
    release: () => {
      if (!held) return err("no task holds the worker");
      held = false;
      if (status === "busy") status = "idle";
      else disposable.resolve();
      return ok(undefined);
    },
    die: (reason) => end({ cause: "worker", reason }),
    retire: () => end({ cause: "host", reason: "retired" }),
    invoke: async (params) => {
      const result = await (opts.invoke ?? succeed)(params);
      // Counted once the task returns, as `SysboxSkillWorker` does.
      taskCount += 1;
      lastUsed = now();
      if (!result.workerReusable) worker.die("not reusable");
      return result;
    },
    dispose: async () => {
      end({ cause: "host", reason: "disposed" });
      status = "disposed";
      await opts.onDispose?.();
    },
  };
  return worker;
}

async function succeed(): Promise<InvokeResult> {
  return { ok: true, output: null, workerReusable: true };
}

/** A promise the test opens when it chooses. */
function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

const noopCtx = mock<CtxHandler>();

function invokeParams(taskId: string): InvokeParams {
  return {
    taskId,
    skillName: "test",
    body: "async def run(inputs, ctx): return {}",
    inputs: {},
    ctxHandler: noopCtx,
  };
}

/** A pool of fake workers whose sweep runs only when the test calls it. */
function poolWith(
  opts: Partial<SysboxWorkerPoolOptions> & Pick<SysboxWorkerPoolOptions, "createWorker">,
): { pool: Promise<SysboxWorkerPool>; sweep: () => void } {
  const sweeps: Array<() => void> = [];
  const pool = SysboxWorkerPool.create({
    sandbox: mock<SandboxClient>(),
    image: "fake:test",
    ...DEFAULT_POOL_OPTIONS,
    setInterval: (cb: () => void): unknown => {
      sweeps.push(cb);
      return {};
    },
    clearInterval: () => {},
    ...opts,
  });
  return {
    pool,
    sweep: () => {
      for (const cb of sweeps) cb();
    },
  };
}

/**
 * Build a pool with deterministic scripted workers. Each spawn pulls the
 * next script entry, a list of task results (or throws) in order; past its
 * end tasks succeed.
 */
function buildPoolHarness(opts: {
  scripts?: Array<Array<InvokeResult | "throw">>;
  poolOptions?: Partial<typeof DEFAULT_POOL_OPTIONS>;
  spawnFails?: number[];
}) {
  const scripts = opts.scripts ?? [];
  const spawnFailIndices = new Set(opts.spawnFails ?? []);
  const spawned: FakeWorker[] = [];
  let spawnIndex = 0;
  let now = 1_000_000;

  const { pool, sweep } = poolWith({
    ...opts.poolOptions,
    createWorker: async ({ workerId }) => {
      const idx = spawnIndex;
      spawnIndex += 1;
      if (spawnFailIndices.has(idx)) {
        throw new Error(`scripted spawn failure #${idx}`);
      }
      const script = scripts[idx] ?? [];
      let task = 0;
      const w = fakeWorker(workerId, {
        now: () => now,
        invoke: async () => {
          const scripted = script[task];
          task += 1;
          if (scripted === "throw") throw new Error("scripted throw");
          return scripted ?? succeed();
        },
      });
      spawned.push(w);
      return w;
    },
    now: () => now,
  });

  return {
    pool,
    spawned,
    advanceTime: (deltaMs: number): void => {
      now += deltaMs;
    },
    triggerSweep: sweep,
    spawnCount: () => spawnIndex,
  };
}

describe("SysboxWorkerPool", () => {
  it("eagerly spawns `min` workers on create", async () => {
    const h = buildPoolHarness({ poolOptions: { min: 2, max: 3 } });
    const pool = await h.pool;
    expect(h.spawnCount()).toBe(2);
    expect(pool.stats()).toMatchObject({ total: 2, idle: 2, busy: 0 });
    await pool.dispose();
  });

  it("rejects invalid sizing", async () => {
    await expect(buildPoolHarness({ poolOptions: { min: 5, max: 2 } }).pool).rejects.toThrow(
      /invalid pool sizing/,
    );
  });

  it("forwards depsCacheVolumeName to every createWorker call", async () => {
    const seen: Array<string | undefined> = [];
    const pool = await poolWith({
      min: 2,
      max: 3,
      depsCacheVolumeName: "cogmo-skills-deps-cache",
      createWorker: async ({ workerId, depsCacheVolumeName }) => {
        seen.push(depsCacheVolumeName);
        return fakeWorker(workerId);
      },
    }).pool;
    expect(seen).toEqual(["cogmo-skills-deps-cache", "cogmo-skills-deps-cache"]);
    await pool.dispose();
  });

  it("forwards depsCacheVolumeName to grow-time spawns (min=0, demand-driven)", async () => {
    // Pin the volume threading on the on-demand spawn path too: min=0 means
    // no workers exist at boot; the first invoke triggers a grow.
    const seen: Array<string | undefined> = [];
    const pool = await poolWith({
      min: 0,
      max: 3,
      depsCacheVolumeName: "cogmo-skills-deps-cache",
      createWorker: async ({ workerId, depsCacheVolumeName }) => {
        seen.push(depsCacheVolumeName);
        return fakeWorker(workerId);
      },
    }).pool;
    expect(seen).toEqual([]); // no workers yet
    await pool.invoke(invokeParams("t-grow"));
    expect(seen).toEqual(["cogmo-skills-deps-cache"]);
    await pool.dispose();
  });

  it("acquires an idle worker on invoke and releases after success", async () => {
    const h = buildPoolHarness({ poolOptions: { min: 1, max: 3 } });
    const pool = await h.pool;
    const result = await pool.invoke(invokeParams("t-1"));
    expect(result.ok).toBe(true);
    expect(pool.stats()).toMatchObject({ total: 1, idle: 1, busy: 0 });
    await pool.dispose();
  });

  it("spawns up to max under concurrent load and queues beyond", async () => {
    // Each task holds its worker until its gate opens, so three stay busy.
    const gates: Array<() => void> = [];
    const spawned: FakeWorker[] = [];
    const pool = await poolWith({
      min: 1,
      max: 3,
      createWorker: async ({ workerId }) => {
        const w = fakeWorker(workerId, {
          invoke: async () => {
            const g = gate();
            gates.push(g.open);
            await g.promise;
            return succeed();
          },
        });
        spawned.push(w);
        return w;
      },
    }).pool;

    // Three concurrent invokes — pool should grow to max=3, none queued.
    const p1 = pool.invoke(invokeParams("t-1"));
    const p2 = pool.invoke(invokeParams("t-2"));
    const p3 = pool.invoke(invokeParams("t-3"));
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    // A fourth invoke should queue.
    const p4 = pool.invoke(invokeParams("t-4"));
    await Promise.resolve();

    expect(spawned).toHaveLength(3);
    expect(pool.stats()).toMatchObject({ total: 3, busy: 3, queued: 1 });

    // Release the first task; the queued p4 should pick up the freed worker.
    gates[0]?.();
    await p1;
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    expect(pool.stats()).toMatchObject({ busy: 3, queued: 0 });

    for (const open of gates.slice(1)) open();
    await Promise.all([p2, p3, p4]);

    expect(pool.stats()).toMatchObject({ busy: 0, idle: 3 });
    await pool.dispose();
    expect(spawned.every((w) => w.state === "disposed")).toBe(true);
  });

  it("recycles a worker after `recycleAfterTasks` invocations", async () => {
    const h = buildPoolHarness({
      poolOptions: { min: 1, max: 1, recycleAfterTasks: 2 },
    });
    const pool = await h.pool;
    expect(h.spawnCount()).toBe(1);

    await pool.invoke(invokeParams("t-1"));
    await pool.invoke(invokeParams("t-2"));
    // After 2 tasks the worker is retired, disposed, and replaced.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.spawnCount()).toBe(2);
    expect(h.spawned[0]?.state).toBe("disposed");
    await pool.dispose();
  });

  it("recycles a worker once its age exceeds `recycleAfterMs`", async () => {
    // Single worker, big task budget so taskCount can't trigger recycle —
    // age is the only path to retirement. Advance the fake clock past the
    // age cap before the next invoke; the post-invoke check should retire
    // and replace the worker even though it ran few tasks.
    const h = buildPoolHarness({
      poolOptions: { min: 1, max: 1, recycleAfterTasks: 1000, recycleAfterMs: 5_000 },
    });
    const pool = await h.pool;
    expect(h.spawnCount()).toBe(1);
    const original = h.spawned[0];

    h.advanceTime(6_000);
    const r = await pool.invoke(invokeParams("t-aged"));
    expect(r.ok).toBe(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(original?.state).toBe("disposed");
    expect(h.spawnCount()).toBe(2);

    await pool.dispose();
  });

  it("recycles a worker that returns a non-reusable result", async () => {
    const h = buildPoolHarness({
      scripts: [[{ ok: false, error: "wall_clock_exceeded", workerReusable: false }]],
      poolOptions: { min: 1, max: 1 },
    });
    const pool = await h.pool;

    const result = await pool.invoke(invokeParams("t-1"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("wall_clock_exceeded");

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.spawnCount()).toBe(2);
    expect(h.spawned[0]?.state).toBe("disposed");
    await pool.dispose();
  });

  it("retires a worker that died while idle and runs the next task on a fresh one", async () => {
    const h = buildPoolHarness({ poolOptions: { min: 1, max: 2 } });
    const pool = await h.pool;
    const dead = expectDefined(h.spawned[0], "eager worker");
    dead.die("supervisor exited");

    const result = await pool.invoke(invokeParams("t-after-death"));

    expect(result.ok).toBe(true);
    expect(dead.state).toBe("disposed");
    expect(h.spawnCount()).toBe(2);
    expect(pool.stats()).toMatchObject({ total: 1, idle: 1, dead: 0 });
    await pool.dispose();
  });

  it("retires a worker the moment it dies while idle and keeps `min` warm", async () => {
    const h = buildPoolHarness({ poolOptions: { min: 1, max: 3 } });
    const pool = await h.pool;
    const dead = expectDefined(h.spawned[0], "eager worker");
    dead.die("supervisor exited");

    await vi.waitFor(() => expect(h.spawnCount()).toBe(2));

    expect(dead.state).toBe("disposed");
    expect(pool.stats()).toMatchObject({ total: 1, idle: 1, dead: 0 });
    await pool.dispose();
  });

  describe("a worker that dies under its task", () => {
    /** A pool whose tasks each wait for `task` to open. */
    function holding(sizing: { min: number; max: number }, task: Promise<void>) {
      const spawned: FakeWorker[] = [];
      const { pool } = poolWith({
        ...sizing,
        createWorker: async ({ workerId }) => {
          const w = fakeWorker(workerId, {
            invoke: async () => {
              await task;
              return {
                ok: false,
                error: "dispatcher_error: worker is dead",
                workerReusable: false,
              };
            },
          });
          spawned.push(w);
          return w;
        },
      });
      return { pool, spawned };
    }

    it("is replaced at once while there is room, and torn down once its task returns", async () => {
      // The supervisor dies while the task holds the worker — during a venv
      // populate, say. Its container must outlive the task's own use of it.
      const task = gate();
      const h = holding({ min: 1, max: 2 }, task.promise);
      const pool = await h.pool;
      const first = expectDefined(h.spawned[0], "eager worker");

      const invoked = pool.invoke(invokeParams("t-dying"));
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
      first.die("supervisor exited");

      await vi.waitFor(() => expect(h.spawned).toHaveLength(2));
      expect(pool.stats()).toMatchObject({ total: 2, idle: 1, dead: 1 });
      expect(first.state).toBe("dead");

      task.open();
      await expect(invoked).resolves.toMatchObject({ ok: false, workerReusable: false });
      await vi.waitFor(() => expect(first.state).toBe("disposed"));
      expect(pool.stats()).toMatchObject({ total: 1, dead: 0 });
      await pool.dispose();
    });

    it("still counts toward `max` until its task returns", async () => {
      const task = gate();
      const h = holding({ min: 1, max: 1 }, task.promise);
      const pool = await h.pool;
      const first = expectDefined(h.spawned[0], "eager worker");

      const invoked = pool.invoke(invokeParams("t-dying"));
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
      first.die("supervisor exited");
      await new Promise<void>((r) => setTimeout(r, 0));

      // Its container is still up, so the pool is at its ceiling.
      expect(h.spawned).toHaveLength(1);
      expect(pool.stats()).toMatchObject({ total: 1, dead: 1 });

      task.open();
      await invoked;
      await vi.waitFor(() => expect(h.spawned).toHaveLength(2));
      expect(first.state).toBe("disposed");
      await pool.dispose();
    });

    it("frees its slot for an acquire queued behind it once its task returns", async () => {
      // With `min` 0 nothing replenishes: only the freed slot serves the queue.
      const task = gate();
      const h = holding({ min: 0, max: 1 }, task.promise);
      const pool = await h.pool;
      const dying = pool.invoke(invokeParams("t-dying"));
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
      const queued = pool.invoke(invokeParams("t-queued"));
      expect(pool.stats().queued).toBe(1);
      expectDefined(h.spawned[0], "first worker").die("supervisor exited");

      task.open();

      await dying;
      await expect(queued).resolves.toMatchObject({ ok: false, workerReusable: false });
      expect(h.spawned).toHaveLength(2);
      await pool.dispose();
    });

    it("is torn down by dispose even while its task runs", async () => {
      const task = gate();
      const h = holding({ min: 1, max: 2 }, task.promise);
      const pool = await h.pool;
      const first = expectDefined(h.spawned[0], "eager worker");
      const invoked = pool.invoke(invokeParams("t-dying"));
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
      first.die("supervisor exited");
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ dead: 1 }));

      await pool.dispose();

      expect(first.state).toBe("disposed");
      task.open();
      await invoked;
    });
  });

  it("hands a replenishing spawn to an acquire that queued behind it", async () => {
    // Every invoke holds its worker until released; the third spawn (the
    // dead worker's replacement) completes only when the test says so.
    const releases: Array<() => void> = [];
    const spawned: FakeWorker[] = [];
    const replacement = gate();
    const pool = await poolWith({
      min: 2,
      max: 2,
      createWorker: async ({ workerId }) => {
        if (spawned.length === 2) await replacement.promise;
        const w = fakeWorker(workerId, {
          invoke: async () => {
            await new Promise<void>((r) => releases.push(r));
            return succeed();
          },
        });
        spawned.push(w);
        return w;
      },
    }).pool;

    const long = pool.invoke(invokeParams("t-long"));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expectDefined(spawned[1], "second worker").die("supervisor exited");
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ total: 1 }));
    // The replacement is in flight and counts toward max, so this queues.
    const queued = pool.invoke(invokeParams("t-queued"));
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ queued: 1 }));

    replacement.open();

    // The queued task starts on the replacement while the long one still runs.
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(pool.stats()).toMatchObject({ total: 2, busy: 2, queued: 0 });
    for (const release of releases) release();
    await expect(queued).resolves.toMatchObject({ ok: true });
    await expect(long).resolves.toMatchObject({ ok: true });
    await pool.dispose();
  });

  it("serves an acquire whose own spawn died before it could lease it", async () => {
    const spawned: FakeWorker[] = [];
    const pool = await poolWith({
      min: 0,
      max: 1,
      createWorker: async ({ workerId }) => {
        const w = fakeWorker(workerId);
        spawned.push(w);
        if (spawned.length === 1) w.die("supervisor exited");
        return w;
      },
    }).pool;

    await expect(pool.invoke(invokeParams("t-1"))).resolves.toMatchObject({ ok: true });
    expect(spawned).toHaveLength(2);
    await pool.dispose();
  });

  it("keeps a queued acquire queued when the worker spawned for it dies first", async () => {
    // The first worker dies under its task; the one spawned for the queued
    // acquire dies before it can take it, and the next one serves it.
    const task = gate();
    const spawned: FakeWorker[] = [];
    const pool = await poolWith({
      min: 0,
      max: 1,
      createWorker: async ({ workerId }) => {
        const w = fakeWorker(workerId, {
          invoke: async () => {
            await task.promise;
            return succeed();
          },
        });
        spawned.push(w);
        if (spawned.length === 2) w.die("supervisor exited");
        return w;
      },
    }).pool;
    const dying = pool.invoke(invokeParams("t-dying"));
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
    const queued = pool.invoke(invokeParams("t-queued"));
    expectDefined(spawned[0], "first worker").die("supervisor exited");

    task.open();

    await dying;
    await expect(queued).resolves.toMatchObject({ ok: true });
    expect(spawned).toHaveLength(3);
    await pool.dispose();
  });

  describe("workers that die before their first task", () => {
    /**
     * A pool whose `n`th spawn dies right after its handshake when `dies(n)`,
     * as on an image whose supervisor cannot run. Tasks wait for `task`.
     */
    function crashing(opts: {
      min: number;
      max: number;
      dies: (n: number) => boolean;
      task?: Promise<void>;
      now?: () => number;
    }) {
      const spawned: FakeWorker[] = [];
      const { pool, sweep } = poolWith({
        min: opts.min,
        max: opts.max,
        ...(opts.now !== undefined && { now: opts.now }),
        createWorker: async ({ workerId }) => {
          await new Promise<void>((r) => setImmediate(r));
          const w = fakeWorker(workerId, {
            ...(opts.now !== undefined && { now: opts.now }),
            invoke: async () => {
              await opts.task;
              return succeed();
            },
          });
          spawned.push(w);
          if (opts.dies(spawned.length)) queueMicrotask(() => w.die("supervisor exited"));
          return w;
        },
      });
      return { pool, sweep, spawned };
    }

    /** Let the deaths and spawns a test set off play out. */
    async function settle(): Promise<void> {
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    it.each([1, 2])(
      "stop being replaced at once from the third in a row, with max %i, and are left to the sweep",
      async (max) => {
        const h = crashing({ min: 1, max, dies: () => true });
        const pool = await h.pool;
        await vi.waitFor(() => expect(h.spawned).toHaveLength(3));
        await settle();
        expect(h.spawned).toHaveLength(3);
        // An acquirer fails rather than waits on an image that cannot run.
        await expect(pool.invoke(invokeParams("t-1"))).rejects.toThrow(
          /keep dying before their first task/,
        );

        const before = h.spawned.length;
        h.sweep();
        await vi.waitFor(() => expect(h.spawned).toHaveLength(before + 1));
        await pool.dispose();
      },
    );

    it("count afresh once a task returns with its worker alive", async () => {
      // Spawns 1–3 die, and the pool stops replacing them. Spawn 4 runs a
      // task; spawn 5 dying is then the first death of a new run, replaced
      // at once.
      const dying = new Set([1, 2, 3, 5]);
      const h = crashing({ min: 2, max: 2, dies: (n) => dying.has(n) });
      const pool = await h.pool;
      await vi.waitFor(() => expect(h.spawned).toHaveLength(4));
      await settle();
      expect(h.spawned).toHaveLength(4);
      await pool.invoke(invokeParams("t-1"));

      h.sweep();

      await vi.waitFor(() => expect(h.spawned).toHaveLength(6));
      await pool.dispose();
    });

    it("count on past a task that returns with its worker dead", async () => {
      // Spawns 1 and 2 die. Spawn 3 dies under its task, which says nothing
      // about the image, so spawn 4 dying is the third early death in a row.
      const task = gate();
      const h = crashing({ min: 1, max: 1, dies: (n) => n !== 3, task: task.promise });
      const pool = await h.pool;
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ idle: 1 }));
      const invoked = pool.invoke(invokeParams("t-1"));
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
      expectDefined(h.spawned[2], "third worker").die("supervisor exited");
      task.open();
      await invoked;

      await vi.waitFor(() => expect(h.spawned).toHaveLength(4));
      await settle();
      expect(h.spawned).toHaveLength(4);
      await pool.dispose();
    });

    it("leave an acquire queued behind a busy worker to wait for it", async () => {
      const task = gate();
      const h = crashing({ min: 1, max: 1, dies: (n) => n <= 3, task: task.promise });
      const pool = await h.pool;
      await vi.waitFor(() => expect(h.spawned).toHaveLength(3));
      await settle();
      h.sweep();
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ idle: 1 }));

      // The first task on the healthy worker has not returned yet.
      const first = pool.invoke(invokeParams("t-1"));
      const second = pool.invoke(invokeParams("t-2"));
      expect(pool.stats().queued).toBe(1);
      task.open();

      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(second).resolves.toMatchObject({ ok: true });
      await pool.dispose();
    });

    it("do not include idle workers killed a minute or more after their handshake", async () => {
      // A Docker restart kills every idle worker at once.
      let now = 0;
      const h = crashing({ min: 3, max: 3, dies: () => false, now: () => now });
      const pool = await h.pool;
      now += 60_000;
      for (const w of h.spawned.slice()) w.die("supervisor exited");

      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ total: 3, idle: 3 }));
      expect(h.spawned).toHaveLength(6);
      await pool.dispose();
    });

    it("do not include workers their first task kills", async () => {
      const spawned: FakeWorker[] = [];
      const pool = await poolWith({
        min: 1,
        max: 1,
        createWorker: async ({ workerId }) => {
          const w: FakeWorker = fakeWorker(workerId, {
            invoke: async () => {
              w.die("supervisor exited");
              return {
                ok: false,
                error: "dispatcher_error: worker is dead",
                workerReusable: false,
              };
            },
          });
          spawned.push(w);
          return w;
        },
      }).pool;
      for (const id of ["t-1", "t-2", "t-3"]) await pool.invoke(invokeParams(id));

      // The third worker's replacement comes up at once, not on the sweep.
      await vi.waitFor(() => expect(spawned).toHaveLength(4));
      await pool.dispose();
    });

    it("do not include workers the pool retires itself", async () => {
      // Four acquires queue behind the one warm worker, and a spawn goes out
      // for each. The warm worker serves them all before the spawns land, so
      // four workers come up idle and are never leased. The sweep retires
      // three of them well inside a minute of their handshake.
      let now = 0;
      let spawns = 0;
      const firstTask = gate();
      const heldSpawns = gate();
      const spawned: FakeWorker[] = [];
      const { pool: created, sweep } = poolWith({
        min: 1,
        max: 5,
        idleShutdownMs: 1000,
        now: () => now,
        createWorker: async ({ workerId }) => {
          spawns += 1;
          if (spawns > 1) await heldSpawns.promise;
          const w = fakeWorker(workerId, {
            now: () => now,
            invoke: async ({ taskId }) => {
              if (taskId === "t-1") await firstTask.promise;
              return succeed();
            },
          });
          spawned.push(w);
          return w;
        },
      });
      const pool = await created;
      const tasks = ["t-1", "t-2", "t-3", "t-4", "t-5"].map((id) => pool.invoke(invokeParams(id)));
      expect(spawns).toBe(5);
      firstTask.open();
      await Promise.all(tasks);
      heldSpawns.open();
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ total: 5, idle: 5 }));

      now += 1500;
      sweep();
      await vi.waitFor(() => expect(pool.stats()).toMatchObject({ total: 1 }));
      // The idle worker left dies right after its handshake: the first
      // death of a run, replaced at once.
      expectDefined(
        spawned.find((s) => s.state === "idle"),
        "idle worker",
      ).die("supervisor exited");

      await vi.waitFor(() => expect(spawns).toBe(6));
      await pool.dispose();
    });
  });

  it("sweeps idle workers above `min` after idleShutdownMs", async () => {
    const h = buildPoolHarness({
      poolOptions: {
        min: 1,
        max: 3,
        idleShutdownMs: 1000,
      },
    });
    const pool = await h.pool;
    const promises = [
      pool.invoke(invokeParams("t-1")),
      pool.invoke(invokeParams("t-2")),
      pool.invoke(invokeParams("t-3")),
    ];
    await Promise.all(promises);
    // All tasks done — workers idle. The pool may or may not have grown to
    // 3; either way the sweep reduces idle workers past the TTL to min=1.
    h.advanceTime(1500);
    h.triggerSweep();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(pool.stats().idle).toBe(1);
    await pool.dispose();
  });

  it("rejects an acquire queued behind a replacement spawn that fails", async () => {
    const replacement = gate();
    const spawned: FakeWorker[] = [];
    const pool = await poolWith({
      min: 1,
      max: 1,
      createWorker: async ({ workerId }) => {
        if (spawned.length === 1) {
          await replacement.promise;
          throw new Error("replacement spawn failed");
        }
        const w = fakeWorker(workerId);
        spawned.push(w);
        return w;
      },
    }).pool;
    expectDefined(spawned[0], "eager worker").die("supervisor exited");
    // The replacement is in flight and fills the pool's one slot, so this queues.
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ total: 0 }));
    const queued = pool.invoke(invokeParams("t-queued"));
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ queued: 1 }));

    replacement.open();

    await expect(queued).rejects.toThrow(/replacement spawn failed/);
    await pool.dispose();
  });

  it("spawns for the next queued acquire after a failed spawn rejects the one ahead of it", async () => {
    const task = gate();
    const spawned: FakeWorker[] = [];
    let spawns = 0;
    const pool = await poolWith({
      min: 0,
      max: 1,
      createWorker: async ({ workerId }) => {
        spawns += 1;
        if (spawns === 2) throw new Error("replacement spawn failed");
        const w = fakeWorker(workerId, {
          invoke: async () => {
            if (spawned.length === 1) await task.promise;
            return succeed();
          },
        });
        spawned.push(w);
        return w;
      },
    }).pool;
    const a = pool.invoke(invokeParams("t-A"));
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
    const b = pool.invoke(invokeParams("t-B"));
    const c = pool.invoke(invokeParams("t-C"));
    expect(pool.stats().queued).toBe(2);

    expectDefined(spawned[0], "first worker").die("supervisor exited");
    task.open();
    await a;

    await expect(b).rejects.toThrow(/replacement spawn failed/);
    await expect(c).resolves.toMatchObject({ ok: true });
    await pool.dispose();
  });

  it("spawns for an acquire queued behind another's own spawn that fails", async () => {
    const spawn = gate();
    let spawns = 0;
    const pool = await poolWith({
      min: 0,
      max: 1,
      createWorker: async ({ workerId }) => {
        spawns += 1;
        if (spawns === 1) {
          await spawn.promise;
          throw new Error("spawn failed");
        }
        return fakeWorker(workerId);
      },
    }).pool;
    const a = pool.invoke(invokeParams("t-A"));
    // The spawn for A fills the pool's one slot, so B waits behind A.
    const b = pool.invoke(invokeParams("t-B"));
    expect(pool.stats().queued).toBe(2);
    expect(spawns).toBe(1);

    spawn.open();

    await expect(a).rejects.toThrow(/spawn failed/);
    await expect(b).resolves.toMatchObject({ ok: true });
    await pool.dispose();
  });

  it("retries a failed replacement spawn on the next sweep", async () => {
    const h = buildPoolHarness({
      scripts: [[{ ok: true, output: null, workerReusable: false }]],
      spawnFails: [1],
      poolOptions: { min: 1, max: 1 },
    });
    const pool = await h.pool;
    await pool.invoke(invokeParams("t-1"));
    // The dead worker's replacement was tried, and failed.
    await vi.waitFor(() => expect(h.spawnCount()).toBe(2));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(pool.stats().total).toBe(0);

    h.triggerSweep();

    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ total: 1, idle: 1 }));
    expect(h.spawnCount()).toBe(3);
    await pool.dispose();
  });

  it("replaces a worker that dies after a failed replacement at once", async () => {
    const h = buildPoolHarness({ spawnFails: [2], poolOptions: { min: 2, max: 2 } });
    const pool = await h.pool;
    expectDefined(h.spawned[0], "first worker").die("supervisor exited");
    // Its replacement was tried, and failed.
    await vi.waitFor(() => expect(h.spawnCount()).toBe(3));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(pool.stats().total).toBe(1);

    expectDefined(h.spawned[1], "second worker").die("supervisor exited");

    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ total: 2, idle: 2 }));
    await pool.dispose();
  });

  it("keeps `min` warm — sweep never drains below it", async () => {
    const h = buildPoolHarness({
      poolOptions: {
        min: 2,
        max: 3,
        idleShutdownMs: 1000,
      },
    });
    const pool = await h.pool;
    h.advanceTime(10_000);
    h.triggerSweep();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(pool.stats().total).toBe(2);
    await pool.dispose();
  });

  it("dispose tears down all workers and rejects queued waiters", async () => {
    // Pool size 1 max so the second invoke queues forever.
    const spawned: FakeWorker[] = [];
    const pool = await poolWith({
      min: 1,
      max: 1,
      createWorker: async ({ workerId }) => {
        const task = gate();
        const w = fakeWorker(workerId, {
          invoke: async () => {
            await task.promise;
            return succeed();
          },
          // Disposal ends the in-flight task; without it the invoke would
          // dangle and the test process would never exit cleanly.
          onDispose: async () => task.open(),
        });
        spawned.push(w);
        return w;
      },
    }).pool;

    const inFlight = pool.invoke(invokeParams("t-1"));
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
    const queued = pool.invoke(invokeParams("t-2"));
    await Promise.resolve();
    expect(pool.stats().queued).toBe(1);

    const disposePromise = pool.dispose();

    await expect(queued).rejects.toThrow(/disposed before worker available/);
    await disposePromise;
    await inFlight;
    expect(spawned.every((w) => w.state === "disposed")).toBe(true);
  });

  it("dispose waits for a container teardown already under way", async () => {
    const teardown = gate();
    let tornDown = false;
    let spawns = 0;
    const pool = await poolWith({
      min: 1,
      max: 1,
      createWorker: async ({ workerId }) => {
        spawns += 1;
        if (spawns > 1) return fakeWorker(workerId);
        return fakeWorker(workerId, {
          invoke: async () => ({ ok: true, output: null, workerReusable: false }),
          onDispose: async () => {
            await teardown.promise;
            tornDown = true;
          },
        });
      },
    }).pool;
    await pool.invoke(invokeParams("t-1"));
    // The first worker's teardown has started, and holds.
    await vi.waitFor(() => expect(spawns).toBe(2));

    let disposed = false;
    const disposing = pool.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(disposed).toBe(false);

    teardown.open();
    await disposing;
    expect(tornDown).toBe(true);
  });

  it("dispose returns to a second caller only once every container is gone", async () => {
    const teardown = gate();
    const pool = await poolWith({
      min: 1,
      max: 1,
      createWorker: async ({ workerId }) =>
        fakeWorker(workerId, { onDispose: () => teardown.promise }),
    }).pool;
    const first = pool.dispose();
    let secondReturned = false;
    const second = pool.dispose().then(() => {
      secondReturned = true;
    });
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(secondReturned).toBe(false);

    teardown.open();
    await Promise.all([first, second]);
  });

  it("dispose is idempotent", async () => {
    const h = buildPoolHarness({ poolOptions: { min: 1, max: 1 } });
    const pool = await h.pool;
    await pool.dispose();
    await pool.dispose();
  });

  it("invoke after dispose throws", async () => {
    const h = buildPoolHarness({ poolOptions: { min: 0, max: 1 } });
    const pool = await h.pool;
    await pool.dispose();
    await expect(pool.invoke(invokeParams("t-1"))).rejects.toThrow(/invoke after dispose/);
  });

  it("recycles when the worker.invoke throws synchronously", async () => {
    const h = buildPoolHarness({
      scripts: [["throw"]],
      poolOptions: { min: 1, max: 1 },
    });
    const pool = await h.pool;
    await expect(pool.invoke(invokeParams("t-1"))).rejects.toThrow(/scripted throw/);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.spawned[0]?.state).toBe("disposed");
    await pool.dispose();
  });

  it("disposes already-spawned workers when an eager spawn fails during create", async () => {
    // Spawn #0 succeeds, spawn #1 fails. Without the cleanup the first
    // worker would leak: `Promise.all` would reject before the caller has
    // any handle to dispose it.
    const spawned: FakeWorker[] = [];
    let spawnIndex = 0;
    await expect(
      poolWith({
        min: 2,
        max: 3,
        createWorker: async ({ workerId }) => {
          const idx = spawnIndex;
          spawnIndex += 1;
          if (idx === 1) {
            throw new Error("scripted second-spawn failure");
          }
          const w = fakeWorker(workerId);
          spawned.push(w);
          return w;
        },
      }).pool,
    ).rejects.toThrow(/scripted second-spawn failure/);

    // The successful spawn (#0) must have been disposed by `create()`'s
    // cleanup path — otherwise its container leaks for the lifetime of the
    // process with no reference for the caller to clean up.
    expect(spawned.length).toBe(1);
    expect(spawned[0]?.state).toBe("disposed");
  });

  it("disposes a worker spawned mid-flight when the pool is disposed during spawn", async () => {
    // Gate the spawn so `dispose()` runs while `createWorker` is still
    // awaiting. Without the guard in `#admit`, the new worker
    // would be pushed into `#workers` *after* dispose spliced it empty,
    // and its container would never be torn down.
    const spawnedWorkers: FakeWorker[] = [];
    const spawn = gate();

    const pool = await poolWith({
      min: 0, // eager spawn off so we control timing precisely
      max: 1,
      createWorker: async ({ workerId }) => {
        await spawn.promise;
        const w = fakeWorker(workerId);
        spawnedWorkers.push(w);
        return w;
      },
    }).pool;

    // Kick a foreground invoke that triggers a spawn (no idle worker).
    const invokePromise = pool.invoke(invokeParams("t-1"));
    await Promise.resolve();
    await Promise.resolve();

    // Race dispose against the spawn: dispose first, then unblock the
    // spawn. The spawn resolves into a disposed pool — its worker must be
    // disposed by `#admit`, not pushed into the (already-empty) `#workers`
    // array.
    const disposePromise = pool.dispose();
    spawn.open();
    await disposePromise;

    await expect(invokePromise).rejects.toThrow(
      /(disposed during worker spawn|disposed before worker available)/,
    );
    if (spawnedWorkers.length > 0) {
      expect(spawnedWorkers[0]?.state).toBe("disposed");
    }
  });

  it("settles an acquire whose own spawn completes into a dispose, whenever it lands", async () => {
    // Sweep the dispose across the microtasks between the spawn resolving
    // and the acquire resuming on it.
    for (let delay = 0; delay <= 20; delay++) {
      const spawn = gate();
      const pool = await poolWith({
        min: 0,
        max: 1,
        createWorker: async ({ workerId }) => {
          await spawn.promise;
          return fakeWorker(workerId);
        },
      }).pool;
      let settled = false;
      const settle = (): void => {
        settled = true;
      };
      void pool.invoke(invokeParams("t-1")).then(settle, settle);
      await new Promise<void>((r) => setImmediate(r));

      spawn.open();
      for (let i = 0; i < delay; i++) await Promise.resolve();
      await pool.dispose();

      await vi.waitFor(() => expect({ delay, settled }).toEqual({ delay, settled: true }), {
        timeout: 200,
      });
    }
  });

  it("rejects the queued waiter when the replacement spawn fails", async () => {
    // Pool at max=1, A busy with a non-reusable result, B queued. The slot
    // the dead worker frees spawns a replacement for the queued waiter; if
    // that spawn fails, the waiter must reject — otherwise B hangs forever.
    const first = gate();
    let spawnIndex = 0;
    const pool = await poolWith({
      min: 1,
      max: 1,
      createWorker: async ({ workerId }) => {
        spawnIndex += 1;
        if (spawnIndex === 2) throw new Error("replacement spawn failed");
        return fakeWorker(workerId, {
          invoke: async () => {
            await first.promise;
            return { ok: false, error: "wall_clock_exceeded", workerReusable: false };
          },
        });
      },
    }).pool;

    const a = pool.invoke(invokeParams("t-A"));
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));
    const b = pool.invoke(invokeParams("t-B"));
    await Promise.resolve();
    expect(pool.stats().queued).toBe(1);

    first.open();
    await a; // resolves with non-reusable result
    await expect(b).rejects.toThrow(/replacement spawn failed/);
    await pool.dispose();
  });

  it("recycle with a queued waiter triggers a fresh spawn for the waiter", async () => {
    // Pool at max=1, a worker is busy with task A. Task B queues. Task A
    // returns a non-reusable result, so its worker dies. The slot its
    // container frees must get a fresh spawn that serves task B.
    const first = gate();
    let spawnIndex = 0;
    const pool = await poolWith({
      min: 1,
      max: 1,
      createWorker: async ({ workerId }) => {
        const idx = spawnIndex;
        spawnIndex += 1;
        return fakeWorker(workerId, {
          invoke: async () => {
            if (idx > 0) return { ok: true, output: { x: idx }, workerReusable: true };
            await first.promise;
            return { ok: false, error: "wall_clock_exceeded", workerReusable: false };
          },
        });
      },
    }).pool;

    expect(spawnIndex).toBe(1);
    const a = pool.invoke(invokeParams("t-A"));
    await vi.waitFor(() => expect(pool.stats()).toMatchObject({ busy: 1 }));

    // Task B queues — pool is at max.
    const b = pool.invoke(invokeParams("t-B"));
    await Promise.resolve();
    expect(pool.stats().queued).toBe(1);

    first.open();
    const aResult = await a;
    expect(aResult.ok).toBe(false);
    const bResult = await b;
    expect(bResult).toMatchObject({ ok: true, output: { x: 1 } });
    expect(spawnIndex).toBe(2);

    await pool.dispose();
  });

  // A worker dies after its task, no waiter is queued, but the pool dropped
  // below min so a *background* replacement spawn is kicked. If that spawn
  // fails, the catch logs a warning and the pool stays below min until the
  // next sweep or invoke spawns again — the failure must NOT propagate to
  // the original invoke's result (which already completed successfully).
  it("background replacement spawn failure leaves pool below min without breaking the completed invoke", async () => {
    const h = buildPoolHarness({
      scripts: [[{ ok: true, output: { done: true }, workerReusable: false }]],
      spawnFails: [1],
      poolOptions: { min: 1, max: 1 },
    });
    const pool = await h.pool;

    const result = await pool.invoke(invokeParams("t-1"));
    expect(result).toMatchObject({ ok: true, output: { done: true } });

    await new Promise<void>((r) => setTimeout(r, 0));

    expect(h.spawnCount()).toBeGreaterThanOrEqual(2);
    expect(pool.stats().total).toBe(0);

    await pool.dispose();
  });

  it("dispose aborts the signal every worker was created with, spawning ones included", async () => {
    const signals: AbortSignal[] = [];
    const spawn = gate();
    const pool = await poolWith({
      min: 1,
      max: 2,
      createWorker: async ({ workerId, signal }) => {
        signals.push(signal);
        if (signals.length === 2) await spawn.promise;
        return fakeWorker(workerId);
      },
    }).pool;
    const first = pool.invoke(invokeParams("t-first"));
    // The eager worker is busy, so this one spawns a second.
    const second = pool.invoke(invokeParams("t-second"));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    // Disposal fails the acquire waiting on that spawn.
    const secondFails = expect(second).rejects.toThrow(/disposed before worker available/);

    const disposed = pool.dispose();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    spawn.open();
    await disposed;
    await first;
    await secondFails;
  });
});

describe("SysboxWorkerPool under random deaths and spawn failures", () => {
  async function ticks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
  }

  async function microtasks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  /**
   * Run one seeded schedule against a pool and return every invariant it
   * broke. Tasks arrive over time while workers die (idle, under a task,
   * or right after their handshake), spawns fail and sweeps run. Some
   * schedules pass through a crash loop, every new worker dying at once,
   * and recover from it. Some dispose the pool midway, a few microtasks
   * after a spawn or a task completes. Workers honour the pool's signal as
   * the real one does.
   */
  async function fuzzPool(seed: number): Promise<ReadonlyArray<string>> {
    const random = seededRandom(seed);
    const chance = (p: number): boolean => random() < p;
    const upTo = (n: number): number => Math.floor(random() * (n + 1));
    const max = 1 + upTo(3);
    const min = upTo(max);
    const tasks = 5 + upTo(15);
    const crashFrom = chance(0.3) ? upTo(tasks - 1) : tasks;
    const crashTo = crashFrom + upTo(4);
    const disposeAt = chance(0.5) ? upTo(tasks - 1) : tasks;
    const violations: string[] = [];
    const workers: FakeWorker[] = [];
    const running = new Set<FakeWorker>();
    /** Workers whose teardown has finished: their container is gone. */
    const gone = new Set<FakeWorker>();
    let creating = 0;
    let booted = false;
    let crashLoop = false;
    let now = 0;
    let pool: SysboxWorkerPool | undefined;
    let disposeCalled = false;
    let disposing: Promise<void> | undefined;
    /** Microtasks from the next spawn or task completion to the midway dispose. */
    let armed: number | undefined;
    const fireDispose = (): void => {
      if (armed === undefined) return;
      const delay = armed;
      armed = undefined;
      void microtasks(delay).then(() => {
        disposeCalled = true;
        disposing = pool?.dispose();
      });
    };

    const { pool: created, sweep } = poolWith({
      min,
      max,
      recycleAfterTasks: 1 + upTo(3),
      idleShutdownMs: 1000,
      now: () => now,
      createWorker: async ({ workerId, signal }) => {
        const open = workers.filter((w) => w.state !== "disposed").length;
        if (open + creating >= max) {
          violations.push(`created a worker with ${open} open and ${creating} creating`);
        }
        creating += 1;
        try {
          await ticks(upTo(2));
          signal.throwIfAborted();
          if (booted && chance(0.15)) throw new Error("spawn failed");
          const w: FakeWorker = fakeWorker(workerId, {
            now: () => now,
            invoke: async () => {
              running.add(w);
              try {
                await ticks(upTo(3));
                if (chance(0.1)) w.die("supervisor exited");
                return chance(0.1)
                  ? { ok: false, error: "wall_clock_exceeded", workerReusable: false }
                  : succeed();
              } finally {
                running.delete(w);
                fireDispose();
              }
            },
            onDispose: async () => {
              if (running.has(w) && !disposeCalled)
                violations.push(`${workerId} torn down under its task`);
              await ticks(upTo(2));
              gone.add(w);
            },
          });
          workers.push(w);
          signal.addEventListener("abort", () => w.retire(), { once: true });
          if (booted && (crashLoop || chance(0.1))) {
            queueMicrotask(() => w.die("supervisor exited"));
          }
          fireDispose();
          return w;
        } finally {
          creating -= 1;
        }
      },
    });
    pool = await created;
    booted = true;

    const settled: boolean[] = [];
    for (let i = 0; i < tasks; i++) {
      crashLoop = i >= crashFrom && i < crashTo;
      if (i === disposeAt) armed = upTo(12);
      settled.push(false);
      const settle = (): void => {
        settled[i] = true;
      };
      void pool.invoke(invokeParams(`t-${i}`)).then(settle, settle);
      for (let k = upTo(3); k > 0; k--) {
        await ticks(1);
        now += chance(0.05) ? 61_000 : 100;
        if (chance(0.1)) workers[upTo(workers.length - 1)]?.die("supervisor exited");
        if (chance(0.1)) {
          now += 1500;
          sweep();
        }
      }
    }
    crashLoop = false;
    // Every task settles on its own: none waits on a sweep.
    for (let i = 0; i < 1000 && settled.includes(false); i++) await ticks(1);
    const hung = settled.filter((s) => !s).length;
    if (hung > 0) violations.push(`${hung} task(s) never settled; ${JSON.stringify(pool.stats())}`);

    // A second caller of `dispose()` waits for the first one's teardowns.
    disposeCalled = true;
    disposing ??= pool.dispose();
    await pool.dispose();
    const leaked = workers.filter((w) => !gone.has(w)).length;
    if (leaked > 0) violations.push(`${leaked} container(s) outlived dispose`);
    await disposing;
    return violations.map((v) => `seed ${seed} (min ${min}, max ${max}): ${v}`);
  }

  it("settles every task, never creates past `max` and leaks no container", async () => {
    const violations: string[] = [];
    for (let seed = 1; seed <= 1000; seed++) violations.push(...(await fuzzPool(seed)));
    expect(violations).toEqual([]);
  });
});
