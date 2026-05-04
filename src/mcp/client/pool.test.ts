import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { McpServer } from "../config.js";
import type { McpStore } from "../store/index.js";
import type { McpConnection } from "./client.js";
import { McpConnectionPool, McpPoolError } from "./pool.js";
import type { Runner } from "./runner.js";

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
  };
}

function makeStore(servers: McpServer[]): McpStore {
  const byId = new Map(servers.map((s) => [s.id, s]));
  return {
    getServerById: vi.fn(async (id: string) => byId.get(id)),
    recordLastConnected: vi.fn(async () => {}),
    recordLastError: vi.fn(async () => {}),
    // Other methods unused by the pool — left as undefined casts.
  } as unknown as McpStore;
}

const dummySecrets = {} as SecretsStore;

// --- Tests ---

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("McpConnectionPool.getConnection", () => {
  it("lazy-spawns on first call, reuses on second", async () => {
    const conn = fakeConnection();
    const runner: Runner = { spawn: vi.fn(async () => conn) };
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner,
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });

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

    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner,
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });

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
    const pool = new McpConnectionPool({
      store: makeStore([]),
      secrets: dummySecrets,
      runner,
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });
    await expect(pool.getConnection("missing")).rejects.toBeInstanceOf(McpPoolError);
    await expect(pool.getConnection("missing")).rejects.toMatchObject({ code: "server_not_found" });
  });

  it("flips entry to 'closed' when transport closes mid-session", async () => {
    const conn = fakeConnection();
    const runner: Runner = { spawn: vi.fn(async () => conn) };
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner,
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });

    await pool.getConnection("s1");
    conn.triggerClose();
    expect(pool.__getEntryState("s1")).toEqual({ kind: "closed", reconnectAttempts: 0 });
    await pool.close();
  });

  it("attempts one reconnect after a transport close", async () => {
    const conn1 = fakeConnection();
    const conn2 = fakeConnection();
    const spawn = vi
      .fn<Runner["spawn"]>()
      .mockResolvedValueOnce(conn1)
      .mockResolvedValueOnce(conn2);
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner: { spawn },
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });

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
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner: { spawn },
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });

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
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner: { spawn },
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });

    await expect(pool.getConnection("s1")).rejects.toThrow();
    await expect(pool.getConnection("s1")).rejects.toThrow();
    expect(pool.__getEntryState("s1")?.kind).toBe("unhealthy");
    pool.reset("s1");
    await expect(pool.getConnection("s1")).resolves.toBeDefined();
    await pool.close();
  });

  it("records last_connected_at on success and last_error on failure", async () => {
    const conn = fakeConnection();
    const store = makeStore([makeServer("s1")]);
    const pool = new McpConnectionPool({
      store,
      secrets: dummySecrets,
      runner: { spawn: vi.fn(async () => conn) },
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });
    await pool.getConnection("s1");
    expect(store.recordLastConnected).toHaveBeenCalledWith("s1", expect.any(Date));
    await pool.close();

    const failingPool = new McpConnectionPool({
      store,
      secrets: dummySecrets,
      runner: {
        spawn: vi.fn(async () => {
          throw new Error("nope");
        }),
      },
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });
    await expect(failingPool.getConnection("s1")).rejects.toThrow();
    expect(store.recordLastError).toHaveBeenCalledWith("s1", "nope");
    await failingPool.close();
  });
});

describe("McpConnectionPool.evict / close", () => {
  it("evict closes a live connection and forgets the entry", async () => {
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner: { spawn: vi.fn(async () => conn) },
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });
    await pool.getConnection("s1");
    await pool.evict("s1");
    expect(closeSpy).toHaveBeenCalled();
    expect(pool.__getEntryState("s1")).toBeUndefined();
    await pool.close();
  });

  it("close throws on subsequent getConnection", async () => {
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner: { spawn: vi.fn(async () => fakeConnection()) },
      idleEvictionMs: 60_000,
      evictionIntervalMs: 0,
      now: () => now,
    });
    await pool.close();
    await expect(pool.getConnection("s1")).rejects.toMatchObject({ code: "pool_closed" });
  });
});

describe("McpConnectionPool idle eviction", () => {
  it("evicts a live connection whose lastUsedAt is older than the threshold", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner: { spawn: vi.fn(async () => conn) },
      idleEvictionMs: 1_000,
      evictionIntervalMs: 100,
      now: () => now,
    });

    await pool.getConnection("s1");
    expect(pool.__getEntryState("s1")?.kind).toBe("live");

    // Advance the injected clock past the eviction threshold.
    now += 2_000;
    vi.advanceTimersByTime(150);
    // close() runs async via .catch fallthrough; flush microtasks
    await Promise.resolve();
    expect(closeSpy).toHaveBeenCalled();
    expect(pool.__getEntryState("s1")).toBeUndefined();

    await pool.close();
  });

  it("leaves a recently-used connection alone", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    const closeSpy = vi.spyOn(conn, "close");
    const pool = new McpConnectionPool({
      store: makeStore([makeServer("s1")]),
      secrets: dummySecrets,
      runner: { spawn: vi.fn(async () => conn) },
      idleEvictionMs: 1_000,
      evictionIntervalMs: 100,
      now: () => now,
    });

    await pool.getConnection("s1");
    now += 500;
    await pool.getConnection("s1"); // refreshes lastUsedAt
    now += 700; // total since first call: 1200ms; since last touch: 700ms
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    expect(closeSpy).not.toHaveBeenCalled();

    await pool.close();
  });
});
