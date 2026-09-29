import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import type { McpServer } from "../config.js";
import { McpPoolError } from "../errors.js";
import type { McpStore } from "../store/index.js";
import type { McpConnection } from "./client.js";
import { McpConnectionPool } from "./pool.js";
import type { Runner } from "./runner.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

// --- Fakes ---

function makeServer(id: string, name = "github"): McpServer {
  return {
    id,
    name,
    config: { transport: "stdio", command: "npx", args: [], env: {} },
    enabled: true,
    approvalStatus: "approved",
    lastConnectedAt: null,
    lastError: null,
    createdAt: new Date(),
  };
}

interface FakeConnection extends McpConnection {
  triggerClose(): void;
  closeListenerCount(): number;
}

function fakeConnection(): FakeConnection {
  const closeListeners = new Set<() => void>();
  let closed = false;
  return {
    callTool: vi.fn(),
    listTools: vi.fn(),
    onToolsChanged: vi.fn(() => () => {}),
    onClose(cb: () => void) {
      if (closed) {
        cb();
        return () => {};
      }
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    async close() {
      closed = true;
      for (const cb of closeListeners) cb();
      closeListeners.clear();
    },
    triggerClose() {
      closed = true;
      for (const cb of closeListeners) cb();
      closeListeners.clear();
    },
    closeListenerCount: () => closeListeners.size,
  };
}

/** Whether `promise` has settled yet, readable synchronously. */
function settledFlag(promise: Promise<void>): { promise: Promise<void>; settled: boolean } {
  const flag = { promise, settled: false };
  void promise.finally(() => {
    flag.settled = true;
  });
  return flag;
}

/** Let every pending promise callback run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeStore(servers: McpServer[]): McpStore {
  const byId = new Map(servers.map((s) => [s.id, s]));
  return {
    getServerById: vi.fn(async (_tx: unknown, id: string) => byId.get(id)),
    recordLastConnected: vi.fn(async () => {}),
    recordLastError: vi.fn(async () => {}),
    // Other methods unused by the pool — left as undefined casts.
  } as unknown as McpStore;
}

const dummySecrets = {} as SecretsStore;

function makePool(
  runner: Runner,
  store: McpStore = makeStore([makeServer("s1")]),
  idleEvictionMs = 60_000,
): McpConnectionPool {
  return new McpConnectionPool({
    store,
    secrets: dummySecrets,
    runInTx: fakeRunInTx,
    runner,
    idleEvictionMs,
  });
}

// --- Tests ---

afterEach(() => {
  vi.useRealTimers();
});

describe("McpConnectionPool.getConnection", () => {
  it("lazy-spawns on first call, reuses on second", async () => {
    const conn = fakeConnection();
    const runner: Runner = { spawn: vi.fn(async () => conn) };
    const pool = makePool(runner);

    const a = await pool.getConnection("s1");
    const b = await pool.getConnection("s1");
    expect(a).toBe(b);
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("dedupes concurrent connect attempts via per-server mutex", async () => {
    let resolveSpawn!: (c: McpConnection) => void;
    const spawnPromise = new Promise<McpConnection>((r) => {
      resolveSpawn = r;
    });
    const conn = fakeConnection();
    const runner: Runner = { spawn: vi.fn(() => spawnPromise) };

    const pool = makePool(runner);

    const p1 = pool.getConnection("s1");
    const p2 = pool.getConnection("s1");
    resolveSpawn(conn);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(conn);
    expect(b).toBe(conn);
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("throws server_not_found for an unknown id", async () => {
    const runner: Runner = { spawn: vi.fn() };
    const pool = makePool(runner, makeStore([]));
    await expect(pool.getConnection("missing")).rejects.toBeInstanceOf(McpPoolError);
    await expect(pool.getConnection("missing")).rejects.toMatchObject({ code: "server_not_found" });
  });

  it("flips entry to 'closed' when transport closes mid-session", async () => {
    const conn = fakeConnection();
    const runner: Runner = { spawn: vi.fn(async () => conn) };
    const pool = makePool(runner);

    await pool.getConnection("s1");
    conn.triggerClose();
    expect(pool.__getEntryState("s1")).toEqual({ kind: "closed", failedAttempts: 0 });
    await pool.close();
  });

  it("attempts one reconnect after a transport close", async () => {
    const conn1 = fakeConnection();
    const conn2 = fakeConnection();
    const spawn = vi
      .fn<Runner["spawn"]>()
      .mockResolvedValueOnce(conn1)
      .mockResolvedValueOnce(conn2);
    const pool = makePool({ spawn });

    await pool.getConnection("s1");
    conn1.triggerClose();
    const reconnect = await pool.getConnection("s1");
    expect(reconnect).toBe(conn2);
    expect(spawn).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("marks the server unhealthy after a second consecutive spawn failure", async () => {
    const conn1 = fakeConnection();
    const spawn = vi
      .fn<Runner["spawn"]>()
      .mockResolvedValueOnce(conn1)
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockRejectedValueOnce(new Error("boom-2"));
    const pool = makePool({ spawn });

    await pool.getConnection("s1");
    conn1.triggerClose();
    await expect(pool.getConnection("s1")).rejects.toThrow("boom-1");
    await expect(pool.getConnection("s1")).rejects.toThrow("boom-2");
    expect(pool.__getEntryState("s1")?.kind).toBe("unhealthy");
    // Subsequent calls fail fast — no further spawn attempt.
    spawn.mockClear();
    await expect(pool.getConnection("s1")).rejects.toMatchObject({ code: "server_unhealthy" });
    expect(spawn).not.toHaveBeenCalled();
    await pool.close();
  });

  it("reset() clears unhealthy state", async () => {
    const spawn = vi
      .fn<Runner["spawn"]>()
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockRejectedValueOnce(new Error("boom-2"))
      .mockResolvedValueOnce(fakeConnection());
    const pool = makePool({ spawn });

    await expect(pool.getConnection("s1")).rejects.toThrow();
    await expect(pool.getConnection("s1")).rejects.toThrow();
    expect(pool.__getEntryState("s1")?.kind).toBe("unhealthy");
    pool.reset("s1");
    await expect(pool.getConnection("s1")).resolves.toBeDefined();
    await pool.close();
  });

  it("does not abandon a live connection when recordLastConnected fails", async () => {
    const conn = fakeConnection();
    // Store throws on the persistence call but the connection itself is healthy.
    const store = {
      getServerById: vi.fn(async () => makeServer("s1")),
      recordLastConnected: vi.fn(async () => {
        throw new Error("db down");
      }),
      recordLastError: vi.fn(async () => {}),
    } as unknown as McpStore;
    const pool = makePool({ spawn: vi.fn(async () => conn) }, store);
    const c = await pool.getConnection("s1");
    expect(c).toBe(conn);
    expect(pool.__getEntryState("s1")?.kind).toBe("live");
    await pool.close();
  });

  it("reset is a no-op on a live entry — does not orphan the connection", async () => {
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn: vi.fn(async () => conn) });
    await pool.getConnection("s1");
    pool.reset("s1");
    // Live entry preserved; subprocess not orphaned.
    expect(pool.__getEntryState("s1")?.kind).toBe("live");
    expect(closeSpy).not.toHaveBeenCalled();
    await pool.close();
  });

  it("reset clears an unhealthy entry only", async () => {
    const spawn = vi
      .fn<Runner["spawn"]>()
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockRejectedValueOnce(new Error("boom-2"));
    const pool = makePool({ spawn });
    await expect(pool.getConnection("s1")).rejects.toThrow();
    await expect(pool.getConnection("s1")).rejects.toThrow();
    expect(pool.__getEntryState("s1")?.kind).toBe("unhealthy");
    pool.reset("s1");
    expect(pool.__getEntryState("s1")).toBeUndefined();
    await pool.close();
  });

  it("records last_connected_at on success and last_error on failure", async () => {
    const conn = fakeConnection();
    const store = makeStore([makeServer("s1")]);
    const pool = makePool({ spawn: vi.fn(async () => conn) }, store);
    await pool.getConnection("s1");
    expect(store.recordLastConnected).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      expect.any(Date),
    );
    await pool.close();

    const failingPool = makePool(
      {
        spawn: vi.fn(async () => {
          throw new Error("nope");
        }),
      },
      store,
    );
    await expect(failingPool.getConnection("s1")).rejects.toThrow();
    expect(store.recordLastError).toHaveBeenCalledWith(expect.anything(), "s1", "nope");
    await failingPool.close();
  });
});

describe("McpConnectionPool.evict / close", () => {
  it("evict closes a live connection and forgets the entry", async () => {
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn: vi.fn(async () => conn) });
    await pool.getConnection("s1");
    await pool.evict("s1");
    expect(closeSpy).toHaveBeenCalled();
    expect(pool.__getEntryState("s1")).toBeUndefined();
    await pool.close();
  });

  it("evict during a spawn fails the waiting call and closes the connection when it arrives", async () => {
    const spawned = Promise.withResolvers<McpConnection>();
    const spawn = vi.fn<Runner["spawn"]>(() => spawned.promise);
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn });
    const pending = pool.getConnection("s1");
    const outcome = pending.then(
      () => "connected",
      (e: unknown) => e,
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    const evicted = pool.evict("s1");
    spawned.resolve(conn);
    await evicted;

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pool.__getEntryState("s1")).toBeUndefined();
    expect(await outcome).toMatchObject({ code: "evicted" });
  });

  it("evict aborts an in-flight spawn and waits for the connection it still yields", async () => {
    const spawned = Promise.withResolvers<McpConnection>();
    const spawn = vi.fn<Runner["spawn"]>(() => spawned.promise);
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn });
    const pending = pool.getConnection("s1");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    const evicted = settledFlag(pool.evict("s1"));
    await flush();
    expect(evicted.settled).toBe(false);
    expect(expectDefined(spawn.mock.calls[0], "spawn call")[3].aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "evicted" });

    spawned.resolve(conn);
    await evicted.promise;
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("close waits for an in-flight connect and closes the connection it yields", async () => {
    const spawned = Promise.withResolvers<McpConnection>();
    const spawn = vi.fn<Runner["spawn"]>(() => spawned.promise);
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn });
    const pending = pool.getConnection("s1");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    const closing = settledFlag(pool.close());
    await flush();
    expect(closing.settled).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: "pool_closed" });

    spawned.resolve(conn);
    await closing.promise;
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pool.__getEntryState("s1")).toBeUndefined();
  });

  it("stops listening for a connection's close once it leaves the pool, even when closing it fails", async () => {
    const conn = fakeConnection();
    vi.spyOn(conn, "close").mockRejectedValue(new Error("close failed"));
    const pool = makePool({ spawn: vi.fn(async () => conn) });
    await pool.getConnection("s1");
    expect(conn.closeListenerCount()).toBe(1);

    await pool.evict("s1");
    expect(conn.closeListenerCount()).toBe(0);
    await pool.close();
  });

  it("close throws on subsequent getConnection", async () => {
    const pool = makePool({ spawn: vi.fn(async () => fakeConnection()) });
    await pool.close();
    await expect(pool.getConnection("s1")).rejects.toMatchObject({ code: "pool_closed" });
  });
});

describe("McpConnectionPool idle eviction", () => {
  const IDLE_MS = 1_000;

  it("closes a live connection once it has gone the idle period unused", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn: vi.fn(async () => conn) }, undefined, IDLE_MS);
    await pool.getConnection("s1");

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(pool.__getEntryState("s1")?.kind).toBe("live");
    await vi.advanceTimersByTimeAsync(1);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pool.__getEntryState("s1")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the idle period from the last use", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn: vi.fn(async () => conn) }, undefined, IDLE_MS);
    await pool.getConnection("s1");
    await vi.advanceTimersByTimeAsync(600);
    await pool.getConnection("s1");

    // The first timer fires 400ms after the last use and re-arms for the rest.
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(closeSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pool.__getEntryState("s1")).toBeUndefined();
  });

  it("disarms the idle timer when the connection leaves the pool", async () => {
    vi.useFakeTimers();
    const closing = fakeConnection();
    const dropping = fakeConnection();
    const pool = makePool(
      {
        spawn: vi
          .fn<Runner["spawn"]>()
          .mockResolvedValueOnce(closing)
          .mockResolvedValueOnce(dropping),
      },
      makeStore([makeServer("s1"), makeServer("s2")]),
      IDLE_MS,
    );
    await pool.getConnection("s1");
    await pool.getConnection("s2");
    expect(vi.getTimerCount()).toBe(2);

    await pool.evict("s1");
    expect(vi.getTimerCount()).toBe(1);
    dropping.triggerClose();
    expect(vi.getTimerCount()).toBe(0);
    await pool.close();
  });
});
