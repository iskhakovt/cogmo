import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { SandboxClient } from "../../sandbox/index.js";
import type { CtxHandler } from "../dispatcher.js";
import type { RunTaskOnSessionParams, RunTaskOnSessionResult } from "./host.js";
import { DEFAULT_POOL_OPTIONS, SysboxWorkerPool, type WorkerHandle } from "./pool.js";

interface FakeWorkerScript {
  /**
   * Behaviour for each invoke call, in order. If the array runs out, the
   * default is `{ ok: true, output: { i }, workerReusable: true }`.
   */
  invokes?: Array<RunTaskOnSessionResult | "throw">;
  /** When true, dispose throws — surface error path. */
  disposeFails?: boolean;
}

function makeFakeWorker(
  workerId: string,
  script: FakeWorkerScript = {},
  now: () => number = Date.now,
): WorkerHandle {
  let state: WorkerHandle["state"] = "idle";
  let taskCount = 0;
  const createdAt = now();
  let lastUsed = createdAt;
  let invokeIndex = 0;

  const handle: WorkerHandle = {
    workerId,
    get state() {
      return state;
    },
    get taskCount() {
      return taskCount;
    },
    idleMs: (now: number) => Math.max(0, now - lastUsed),
    ageMs: (now: number) => Math.max(0, now - createdAt),
    tryAcquire: () => {
      if (state !== "idle") return false;
      state = "busy";
      return true;
    },
    release: () => {
      if (state === "busy") state = "idle";
    },
    markPoisoned: () => {
      if (state !== "disposed") state = "draining";
    },
    invoke: async () => {
      const scripted = script.invokes?.[invokeIndex];
      invokeIndex += 1;
      taskCount += 1;
      lastUsed = Date.now();
      if (scripted === "throw") {
        state = "draining";
        throw new Error("scripted throw");
      }
      const result: RunTaskOnSessionResult = scripted ?? {
        ok: true,
        output: { taskCount },
        workerReusable: true,
      };
      if (!result.workerReusable) {
        state = "draining";
      }
      lastUsed = now();
      return result;
    },
    dispose: async () => {
      if (script.disposeFails) {
        state = "disposed";
        throw new Error("dispose failed");
      }
      state = "disposed";
    },
  };

  return handle;
}

const noopCtx: CtxHandler = { handle: async () => null };

function invokeParams(taskId: string): RunTaskOnSessionParams & { ctxHandler: CtxHandler } {
  return {
    taskId,
    skillName: "test",
    body: "async def run(inputs, ctx): return {}",
    inputs: {},
    ctxHandler: noopCtx,
  };
}

/**
 * Build a pool with deterministic scripted workers. Each spawn pulls the
 * next script entry; if the array runs out, defaults are used. The fake
 * `setInterval` runs nothing — tests trigger sweeps manually via
 * `triggerSweep` (returned in the harness).
 */
function buildPoolHarness(opts: {
  scripts?: FakeWorkerScript[];
  poolOptions?: Partial<typeof DEFAULT_POOL_OPTIONS>;
  spawnFails?: number[];
}) {
  const scripts = opts.scripts ?? [];
  const spawnFailIndices = new Set(opts.spawnFails ?? []);
  const spawned: WorkerHandle[] = [];
  let spawnIndex = 0;
  let now = 1_000_000;
  const sweepCallbacks: Array<() => void> = [];

  const sandbox = mock<SandboxClient>();

  const pool = SysboxWorkerPool.create({
    sandbox,
    image: "fake:test",
    ...DEFAULT_POOL_OPTIONS,
    ...opts.poolOptions,
    createWorker: async ({ workerId }) => {
      const idx = spawnIndex;
      spawnIndex += 1;
      if (spawnFailIndices.has(idx)) {
        throw new Error(`scripted spawn failure #${idx}`);
      }
      const w = makeFakeWorker(workerId, scripts[idx] ?? {}, () => now);
      spawned.push(w);
      return w;
    },
    setInterval: (cb: () => void): unknown => {
      sweepCallbacks.push(cb);
      return { __fake: true };
    },
    clearInterval: () => {},
    now: () => now,
  });

  return {
    pool,
    spawned,
    advanceTime: (deltaMs: number): void => {
      now += deltaMs;
    },
    triggerSweep: (): void => {
      for (const cb of sweepCallbacks) cb();
    },
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

  it("acquires an idle worker on invoke and releases after success", async () => {
    const h = buildPoolHarness({ poolOptions: { min: 1, max: 3 } });
    const pool = await h.pool;
    const result = await pool.invoke(invokeParams("t-1"));
    expect(result.ok).toBe(true);
    expect(pool.stats()).toMatchObject({ total: 1, idle: 1, busy: 0 });
    await pool.dispose();
  });

  it("spawns up to max under concurrent load and queues beyond", async () => {
    // Workers take a real "tick" via a manual gate so we can hold three busy
    // simultaneously. Each scripted invoke result is the default (ok+reusable).
    const gates: Array<{ resolve: () => void; promise: Promise<void> }> = [];
    const scripts: FakeWorkerScript[] = [];
    // Fake worker whose invoke awaits an external gate before resolving.
    function gatedWorker(_id: string): WorkerHandle {
      let state: WorkerHandle["state"] = "idle";
      const createdAt = Date.now();
      let lastUsed = createdAt;
      let count = 0;
      return {
        workerId: _id,
        get state() {
          return state;
        },
        get taskCount() {
          return count;
        },
        idleMs: (n) => Math.max(0, n - lastUsed),
        ageMs: (n) => Math.max(0, n - createdAt),
        tryAcquire: () => {
          if (state !== "idle") return false;
          state = "busy";
          return true;
        },
        release: () => {
          if (state === "busy") state = "idle";
        },
        markPoisoned: () => {
          if (state !== "disposed") state = "draining";
        },
        invoke: async () => {
          let resolveFn: () => void = () => {};
          const promise = new Promise<void>((r) => {
            resolveFn = r;
          });
          gates.push({ resolve: resolveFn, promise });
          await promise;
          count += 1;
          lastUsed = Date.now();
          return { ok: true, output: null, workerReusable: true };
        },
        dispose: async () => {
          state = "disposed";
        },
      };
    }

    // The buildPoolHarness wiring isn't reused — this test builds its own
    // pool from scratch with gated workers. Reference unused `scripts` to
    // keep the closure pattern consistent with other tests.
    void scripts;
    const sandbox = mock<SandboxClient>();
    const spawned: WorkerHandle[] = [];
    let count = 0;
    const pool = await SysboxWorkerPool.create({
      sandbox,
      image: "fake:test",
      ...DEFAULT_POOL_OPTIONS,
      min: 1,
      max: 3,
      createWorker: async ({ workerId }) => {
        const w = gatedWorker(workerId);
        spawned.push(w);
        count += 1;
        return w;
      },
      setInterval: (): unknown => ({}),
      clearInterval: () => {},
      now: Date.now,
    });

    // Three concurrent invokes — pool should grow to max=3, none queued.
    const p1 = pool.invoke(invokeParams("t-1"));
    const p2 = pool.invoke(invokeParams("t-2"));
    const p3 = pool.invoke(invokeParams("t-3"));
    // Settle one microtask cycle so the spawns + acquires resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // A fourth invoke should queue.
    const p4 = pool.invoke(invokeParams("t-4"));
    await Promise.resolve();

    expect(count).toBe(3);
    expect(pool.stats().total).toBe(3);
    expect(pool.stats().busy).toBe(3);
    expect(pool.stats().queued).toBe(1);

    // Release the first task; the queued p4 should pick up the freed worker.
    gates[0]?.resolve();
    await p1;
    // Allow the queue handover to process.
    await Promise.resolve();
    expect(pool.stats().busy).toBe(3); // p4 took p1's worker
    expect(pool.stats().queued).toBe(0);

    gates[1]?.resolve();
    gates[2]?.resolve();
    gates[3]?.resolve();
    await Promise.all([p2, p3, p4]);

    expect(pool.stats().busy).toBe(0);
    expect(pool.stats().idle).toBe(3);
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
    // After 2 tasks, the worker should have been recycled — disposed and a
    // replacement spawned lazily.
    // Allow the lazy replacement spawn to settle.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.spawnCount()).toBe(2);
    expect(h.spawned[0]?.state).toBe("disposed");
    await pool.dispose();
  });

  it("recycles a worker that returns a non-reusable result", async () => {
    const h = buildPoolHarness({
      scripts: [
        { invokes: [{ ok: false, error: "wall_clock_exceeded", workerReusable: false }] },
        {},
      ],
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

  it("sweeps idle workers above `min` after idleShutdownMs", async () => {
    const h = buildPoolHarness({
      poolOptions: {
        min: 1,
        max: 3,
        idleShutdownMs: 1000,
      },
    });
    const pool = await h.pool;
    // Force pool growth to 3 by running 3 tasks back-to-back. Each completes
    // before the next; so we end up with 1 worker that ran 3 tasks. Force
    // growth instead by calling invoke concurrently.
    const promises = [
      pool.invoke(invokeParams("t-1")),
      pool.invoke(invokeParams("t-2")),
      pool.invoke(invokeParams("t-3")),
    ];
    await Promise.all(promises);
    // All tasks done — workers idle.
    // (Note: pool may have grown to 3 concurrently; with the fake's instant
    // resolution the second/third invoke might land on an already-idle
    // worker before another spawn. Either way, the assertion holds:
    // sweep should reduce idle to min=1 if any are idle past TTL.)
    h.advanceTime(1500);
    h.triggerSweep();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(pool.stats().idle).toBeGreaterThanOrEqual(1);
    expect(pool.stats().idle).toBeLessThanOrEqual(1);
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
    const sandbox = mock<SandboxClient>();
    const spawned: WorkerHandle[] = [];
    function gated(id: string): WorkerHandle {
      let state: WorkerHandle["state"] = "idle";
      let resolveFn: () => void = () => {};
      const gate = new Promise<void>((r) => {
        resolveFn = r;
      });
      return {
        workerId: id,
        get state() {
          return state;
        },
        get taskCount() {
          return 0;
        },
        idleMs: () => 0,
        ageMs: () => 0,
        tryAcquire: () => {
          if (state !== "idle") return false;
          state = "busy";
          return true;
        },
        release: () => {
          state = "idle";
        },
        markPoisoned: () => {
          state = "draining";
        },
        invoke: async () => {
          await gate;
          return { ok: true, output: null, workerReusable: true };
        },
        dispose: async () => {
          state = "disposed";
          // Releasing the gate so the in-flight invoke can finish — without
          // this the invoke promise would dangle forever and the test
          // process would never exit cleanly.
          resolveFn();
        },
      };
    }
    const pool = await SysboxWorkerPool.create({
      sandbox,
      image: "fake:test",
      ...DEFAULT_POOL_OPTIONS,
      min: 1,
      max: 1,
      createWorker: async ({ workerId }) => {
        const w = gated(workerId);
        spawned.push(w);
        return w;
      },
      setInterval: (): unknown => ({}),
      clearInterval: () => {},
      now: Date.now,
    });

    const inFlight = pool.invoke(invokeParams("t-1"));
    // microtask-cycle so the in-flight starts.
    await Promise.resolve();
    const queued = pool.invoke(invokeParams("t-2"));
    await Promise.resolve();
    expect(pool.stats().queued).toBe(1);

    const disposePromise = pool.dispose();

    await expect(queued).rejects.toThrow(/disposed before worker available/);
    await disposePromise;
    // The in-flight invoke also resolves (fake gate released by dispose).
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
      scripts: [{ invokes: ["throw"] }, {}],
      poolOptions: { min: 1, max: 1 },
    });
    const pool = await h.pool;
    await expect(pool.invoke(invokeParams("t-1"))).rejects.toThrow(/scripted throw/);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.spawned[0]?.state).toBe("disposed");
    await pool.dispose();
  });
});
