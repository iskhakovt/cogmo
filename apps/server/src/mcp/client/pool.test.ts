import { getEventListeners } from "node:events";
import type { Result } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import type { McpServer } from "../config.js";
import type { McpPoolError } from "../errors.js";
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
  /** `onClose` subscriptions not yet released, whether or not the connection has closed. */
  openSubscriptions(): number;
}

/** `closed` starts it closed: `onClose` then calls back at once, as the contract allows. */
function fakeConnection(opts: { closed?: boolean } = {}): FakeConnection {
  const closeListeners = new Set<() => void>();
  let closed = opts.closed ?? false;
  let subscriptions = 0;
  const fireClose = () => {
    closed = true;
    for (const cb of closeListeners) cb();
    closeListeners.clear();
  };
  return {
    callTool: vi.fn(),
    listTools: vi.fn(),
    onToolsChanged: vi.fn(() => () => {}),
    onClose(cb: () => void) {
      subscriptions++;
      let released = false;
      if (closed) cb();
      else closeListeners.add(cb);
      return () => {
        if (released) return;
        released = true;
        subscriptions--;
        closeListeners.delete(cb);
      };
    },
    async close() {
      fireClose();
    },
    triggerClose: fireClose,
    openSubscriptions: () => subscriptions,
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

/** The connection `getConnection` yields; fails the test on an error. */
async function connected(pool: McpConnectionPool, serverId: string): Promise<McpConnection> {
  const result = await pool.getConnection(serverId);
  if (result.isErr()) throw new Error(`expected a connection, got ${result.error.code}`);
  return result.value;
}

/** Why `getConnection` yielded no connection; fails the test on a connection. */
async function failure(
  outcome: Promise<Result<McpConnection, McpPoolError>>,
): Promise<McpPoolError> {
  const result = await outcome;
  if (result.isOk()) throw new Error("expected getConnection to fail");
  return result.error;
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

    const a = await connected(pool, "s1");
    const b = await connected(pool, "s1");
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

    const p1 = connected(pool, "s1");
    const p2 = connected(pool, "s1");
    resolveSpawn(conn);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(conn);
    expect(b).toBe(conn);
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("fails with server_not_found for an unknown id, spending no attempt on it", async () => {
    const runner: Runner = { spawn: vi.fn() };
    const store = makeStore([]);
    const pool = makePool(runner, store);
    for (let call = 0; call < 3; call++) {
      expect(await failure(pool.getConnection("missing"))).toEqual({ code: "server_not_found" });
    }
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(store.recordLastError).not.toHaveBeenCalled();
  });

  it("spends no attempt on a server lookup that fails", async () => {
    const runner: Runner = { spawn: vi.fn() };
    const store = makeStore([makeServer("s1")]);
    vi.mocked(store.getServerById).mockRejectedValue(new Error("db down"));
    const pool = makePool(runner, store);
    for (let call = 0; call < 3; call++) {
      expect(await failure(pool.getConnection("s1"))).toEqual({
        code: "connect_failed",
        error: new Error("db down"),
      });
    }
    expect(pool.__getEntryState("s1")).toBeUndefined();
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(store.recordLastError).not.toHaveBeenCalled();
  });

  it("flips entry to 'closed' when transport closes mid-session", async () => {
    const conn = fakeConnection();
    const runner: Runner = { spawn: vi.fn(async () => conn) };
    const pool = makePool(runner);

    await connected(pool, "s1");
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

    await connected(pool, "s1");
    conn1.triggerClose();
    const reconnect = await connected(pool, "s1");
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

    await connected(pool, "s1");
    conn1.triggerClose();
    expect(await failure(pool.getConnection("s1"))).toMatchObject({
      error: new Error("boom-1"),
    });
    expect(await failure(pool.getConnection("s1"))).toMatchObject({
      error: new Error("boom-2"),
    });
    expect(pool.__getEntryState("s1")?.kind).toBe("unhealthy");
    // Subsequent calls fail fast — no further spawn attempt.
    spawn.mockClear();
    expect(await failure(pool.getConnection("s1"))).toEqual({
      code: "server_unhealthy",
      lastError: "boom-2",
    });
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

    await failure(pool.getConnection("s1"));
    await failure(pool.getConnection("s1"));
    expect(pool.__getEntryState("s1")?.kind).toBe("unhealthy");
    pool.reset("s1");
    await connected(pool, "s1");
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
    const c = await connected(pool, "s1");
    expect(c).toBe(conn);
    expect(pool.__getEntryState("s1")?.kind).toBe("live");
    await pool.close();
  });

  it("reset is a no-op on a live entry — does not orphan the connection", async () => {
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn: vi.fn(async () => conn) });
    await connected(pool, "s1");
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
    await failure(pool.getConnection("s1"));
    await failure(pool.getConnection("s1"));
    expect(pool.__getEntryState("s1")?.kind).toBe("unhealthy");
    pool.reset("s1");
    expect(pool.__getEntryState("s1")).toBeUndefined();
    await pool.close();
  });

  it("records last_connected_at on success and last_error on failure", async () => {
    const conn = fakeConnection();
    const store = makeStore([makeServer("s1")]);
    const pool = makePool({ spawn: vi.fn(async () => conn) }, store);
    await connected(pool, "s1");
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
    await failure(failingPool.getConnection("s1"));
    expect(store.recordLastError).toHaveBeenCalledWith(expect.anything(), "s1", "nope");
    await failingPool.close();
  });
});

describe("McpConnectionPool.evict / close", () => {
  it("evict closes a live connection and forgets the entry", async () => {
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn: vi.fn(async () => conn) });
    await connected(pool, "s1");
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
    const outcome = failure(pool.getConnection("s1"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    const evicted = pool.evict("s1");
    spawned.resolve(conn);
    await evicted;

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pool.__getEntryState("s1")).toBeUndefined();
    expect(await outcome).toEqual({ code: "evicted" });
  });

  it("evict aborts an in-flight spawn and waits for the connection it still yields", async () => {
    const spawned = Promise.withResolvers<McpConnection>();
    const spawn = vi.fn<Runner["spawn"]>(() => spawned.promise);
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn });
    const pending = failure(pool.getConnection("s1"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    const evicted = settledFlag(pool.evict("s1"));
    expect(await pending).toEqual({ code: "evicted" });
    await flush();
    expect(evicted.settled).toBe(false);
    expect(expectDefined(spawn.mock.calls[0], "spawn call")[3].aborted).toBe(true);

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
    const pending = failure(pool.getConnection("s1"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    const closing = settledFlag(pool.close());
    expect(await pending).toEqual({ code: "pool_closed" });
    await flush();
    expect(closing.settled).toBe(false);

    spawned.resolve(conn);
    await closing.promise;
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pool.__getEntryState("s1")).toBeUndefined();
  });

  it("stops listening for a connection's close once it leaves the pool, even when closing it fails", async () => {
    const conn = fakeConnection();
    vi.spyOn(conn, "close").mockRejectedValue(new Error("close failed"));
    const pool = makePool({ spawn: vi.fn(async () => conn) });
    await connected(pool, "s1");
    expect(conn.openSubscriptions()).toBe(1);

    await pool.evict("s1");
    expect(conn.openSubscriptions()).toBe(0);
    await pool.close();
  });

  it("evict waits for an abandoned spawn to reject", async () => {
    // As `HostRunner` does: on abort it closes what it started, and rejects once that is done.
    const exited = Promise.withResolvers<void>();
    const spawn = vi.fn<Runner["spawn"]>(
      (_server, _secrets, _runInTx, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            void exited.promise.then(() => reject(signal.reason));
          });
        }),
    );
    const pool = makePool({ spawn });
    const failed = failure(pool.getConnection("s1"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    const evicted = settledFlag(pool.evict("s1"));
    expect(await failed).toEqual({ code: "evicted" });
    await flush();
    expect(evicted.settled).toBe(false);

    exited.resolve();
    await evicted.promise;
  });

  it("starts no spawn for a connect evicted during its server lookup", async () => {
    const lookup = Promise.withResolvers<McpServer | undefined>();
    const store = makeStore([]);
    vi.mocked(store.getServerById).mockReturnValueOnce(lookup.promise);
    const spawn = vi.fn<Runner["spawn"]>();
    const pool = makePool({ spawn }, store);
    const failed = failure(pool.getConnection("s1"));
    await vi.waitFor(() => expect(store.getServerById).toHaveBeenCalledOnce());

    const evicted = pool.evict("s1");
    expect(await failed).toEqual({ code: "evicted" });
    lookup.resolve(makeServer("s1"));
    await evicted;
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails every getConnection after close with pool_closed", async () => {
    const pool = makePool({ spawn: vi.fn(async () => fakeConnection()) });
    await pool.close();
    expect(await failure(pool.getConnection("s1"))).toEqual({ code: "pool_closed" });
  });
});

describe("McpConnectionPool transport close", () => {
  it("takes a connection that closed before the pool watched it as closed, and reconnects", async () => {
    vi.useFakeTimers();
    const dead = fakeConnection({ closed: true });
    const fresh = fakeConnection();
    const spawn = vi.fn<Runner["spawn"]>().mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);
    const pool = makePool({ spawn });

    await connected(pool, "s1");
    expect(pool.__getEntryState("s1")).toEqual({ kind: "closed", failedAttempts: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(dead.openSubscriptions()).toBe(0);

    expect(await connected(pool, "s1")).toBe(fresh);
    expect(spawn).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("releases its close subscription when the transport closes", async () => {
    const conn = fakeConnection();
    const pool = makePool({ spawn: vi.fn(async () => conn) });
    await connected(pool, "s1");
    conn.triggerClose();
    expect(conn.openSubscriptions()).toBe(0);
    await pool.close();
  });
});

describe("McpConnectionPool idle eviction", () => {
  const IDLE_MS = 1_000;

  it("closes a live connection once it has gone the idle period unused", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = makePool({ spawn: vi.fn(async () => conn) }, undefined, IDLE_MS);
    await connected(pool, "s1");

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
    await connected(pool, "s1");
    await vi.advanceTimersByTimeAsync(600);
    await connected(pool, "s1");

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
    await connected(pool, "s1");
    await connected(pool, "s2");
    expect(vi.getTimerCount()).toBe(2);

    await pool.evict("s1");
    expect(vi.getTimerCount()).toBe(1);
    dropping.triggerClose();
    expect(vi.getTimerCount()).toBe(0);
    await pool.close();
  });

  it("keeps one abort listener per timer across re-arms", async () => {
    vi.useFakeTimers();
    const pool = makePool({ spawn: vi.fn(async () => fakeConnection()) }, undefined, IDLE_MS);
    await connected(pool, "s1");
    const signal = liveSignal(pool, "s1");
    const listeners = getEventListeners(signal, "abort").length;

    // Used 1ms before each check, so each check re-arms for all but 1ms of the period.
    let untilCheck = IDLE_MS;
    for (let check = 0; check < 3; check++) {
      await vi.advanceTimersByTimeAsync(untilCheck - 1);
      await connected(pool, "s1");
      await vi.advanceTimersByTimeAsync(1);
      untilCheck = IDLE_MS - 1;
    }
    expect(pool.__getEntryState("s1")?.kind).toBe("live");
    expect(getEventListeners(signal, "abort")).toHaveLength(listeners);
    await pool.close();
  });

  it("waits out an idle period beyond the timer ceiling instead of checking at once", async () => {
    vi.useFakeTimers();
    const pool = makePool({ spawn: vi.fn(async () => fakeConnection()) }, undefined, 2 ** 31);
    const start = Date.now();
    await connected(pool, "s1");

    await vi.advanceTimersByTimeAsync(1);
    expect(pool.__getEntryState("s1")?.kind).toBe("live");
    // Node fires a longer delay after 1ms; the timer is capped at the ceiling and re-arms from there.
    vi.advanceTimersToNextTimer();
    expect(Date.now() - start).toBe(2 ** 31 - 1);
    expect(pool.__getEntryState("s1")?.kind).toBe("live");
    await pool.close();
  });
});

/** The signal a live entry's watch runs under. */
function liveSignal(pool: McpConnectionPool, serverId: string): AbortSignal {
  const entry = pool.__getEntryState(serverId);
  if (entry?.kind !== "live") throw new Error(`expected ${serverId} live, got ${entry?.kind}`);
  return entry.abort.signal;
}
