import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { SandboxClient } from "../../sandbox/index.js";
import { expectDefined } from "../../test/assertions.js";
import type { CtxHandler } from "../dispatcher.js";
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
  const dead = Promise.withResolvers<string>();
  const disposable = Promise.withResolvers<void>();

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
      if (status !== "idle") return false;
      status = "busy";
      held = true;
      return true;
    },
    release: () => {
      if (!held) return false;
      held = false;
      if (status === "busy") status = "idle";
      else disposable.resolve();
      return true;
    },
    die: (reason) => {
      if (status === "dead" || status === "disposed") return;
      status = "dead";
      dead.resolve(reason);
      if (!held) disposable.resolve();
    },
    retire: () => worker.die("retired"),
    invoke: async (params) => {
      taskCount += 1;
      const result = await (opts.invoke ?? succeed)(params);
      lastUsed = now();
      if (!result.workerReusable) worker.die("not reusable");
      return result;
    },
    dispose: async () => {
      worker.die("disposed");
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
    function holding(max: number, task: Promise<void>) {
      const spawned: FakeWorker[] = [];
      const { pool } = poolWith({
        min: 1,
        max,
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
      const h = holding(2, task.promise);
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
      const h = holding(1, task.promise);
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

    it("is torn down by dispose even while its task runs", async () => {
      const task = gate();
      const h = holding(2, task.promise);
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
    // awaiting. Without the guard inside `#runSpawn`, the new worker
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
    // disposed by `#runSpawn`'s post-await guard, not pushed into the
    // (already-empty) `#workers` array.
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

  it("rejects the queued waiter when the replacement spawn fails", async () => {
    // Pool at max=1, A busy with a non-reusable result, B queued. The
    // recycle path tries to spawn a replacement for the queued waiter; if
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

    const disposed = pool.dispose();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    spawn.open();
    await disposed;
    await first;
    await expect(second).rejects.toThrow(/disposed during worker spawn/);
  });
});
