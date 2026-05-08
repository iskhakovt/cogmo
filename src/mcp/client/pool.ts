import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { McpStore } from "../store/index.js";
import type { McpConnection } from "./client.js";
import type { Runner } from "./runner.js";

export type McpPoolErrorCode = "server_not_found" | "server_unhealthy" | "pool_closed";

export class McpPoolError extends Error {
  readonly code: McpPoolErrorCode;
  constructor(code: McpPoolErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "McpPoolError";
  }
}

type EntryState =
  | { kind: "live"; connection: McpConnection; lastUsedAt: number }
  | { kind: "closed"; reconnectAttempts: number }
  | { kind: "unhealthy"; lastError: string };

export interface McpConnectionPoolOptions {
  store: McpStore;
  secrets: SecretsStore;
  runInTx: Transactor;
  runner: Runner;
  /** ms; live connections idle longer than this are evicted on the next sweep. */
  idleEvictionMs: number;
  /** ms; how often the idle sweep runs. Set to 0 to disable. */
  evictionIntervalMs: number;
  /** Clock injection — tests pass a fake now. */
  now?: () => number;
}

/**
 * Process-singleton connection pool for MCP servers.
 *
 * - **Lazy connect.** A subprocess is spawned only on the first `getConnection`.
 * - **Reconnect-once.** When a transport closes mid-session, the next
 *   `getConnection` attempts a single reconnect. A second consecutive failure
 *   parks the entry in `unhealthy`; subsequent calls fail fast until the
 *   operator runs `reset(serverId)`.
 * - **Per-server connect mutex.** Concurrent `getConnection` calls for the
 *   same server share the in-flight spawn; only one subprocess starts.
 * - **Idle eviction.** A periodic sweep closes connections whose
 *   `lastUsedAt` is older than `idleEvictionMs`.
 */
export class McpConnectionPool {
  #store: McpStore;
  #secrets: SecretsStore;
  #runInTx: Transactor;
  #runner: Runner;
  #idleEvictionMs: number;
  #now: () => number;
  #entries = new Map<string, EntryState>();
  #connecting = new Map<string, Promise<McpConnection>>();
  #evictionTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(opts: McpConnectionPoolOptions) {
    this.#store = opts.store;
    this.#secrets = opts.secrets;
    this.#runInTx = opts.runInTx;
    this.#runner = opts.runner;
    this.#idleEvictionMs = opts.idleEvictionMs;
    this.#now = opts.now ?? Date.now;
    if (opts.evictionIntervalMs > 0) {
      this.#evictionTimer = setInterval(() => this.#sweepIdle(), opts.evictionIntervalMs);
      // Don't keep the process alive just for this sweep timer.
      this.#evictionTimer.unref?.();
    }
  }

  async getConnection(serverId: string): Promise<McpConnection> {
    if (this.#closed) throw new McpPoolError("pool_closed");

    const state = this.#entries.get(serverId);
    if (state?.kind === "live") {
      state.lastUsedAt = this.#now();
      return state.connection;
    }
    if (state?.kind === "unhealthy") {
      throw new McpPoolError("server_unhealthy", state.lastError);
    }

    let pending = this.#connecting.get(serverId);
    if (!pending) {
      pending = this.#doConnect(serverId, state);
      this.#connecting.set(serverId, pending);
      // Eviction from the in-flight map happens regardless of success.
      // The `.catch(() => {})` is on the chained promise so the cleanup
      // chain doesn't surface an unhandled rejection — the caller awaits
      // `pending` directly and handles the original rejection there.
      pending
        .finally(() => {
          if (this.#connecting.get(serverId) === pending) {
            this.#connecting.delete(serverId);
          }
        })
        .catch(() => {});
    }
    return pending;
  }

  async #doConnect(serverId: string, prev: EntryState | undefined): Promise<McpConnection> {
    const server = await this.#runInTx((tx) => this.#store.getServerById(tx, serverId));
    if (!server) throw new McpPoolError("server_not_found");

    try {
      const connection = await this.#runner.spawn(server, this.#secrets, this.#runInTx);

      // The pool may have been closed *during* this spawn. If so, tear down
      // the just-spawned connection rather than stuffing it into the now-empty
      // entry map (where nothing would ever close it).
      if (this.#closed) {
        await connection.close().catch(() => {});
        throw new McpPoolError("pool_closed");
      }

      // Wire transport-close to flip our state — but only if THIS connection is
      // still the one the entry references (don't downgrade a fresh reconnect).
      connection.onClose(() => {
        const cur = this.#entries.get(serverId);
        if (cur?.kind === "live" && cur.connection === connection) {
          this.#entries.set(serverId, { kind: "closed", reconnectAttempts: 0 });
        }
      });
      this.#entries.set(serverId, { kind: "live", connection, lastUsedAt: this.#now() });
      // Persistence failure here must not abandon the connection: it's already
      // live in the map, will be returned to the caller, and is recoverable.
      // Log and move on instead of rejecting (which would leak the entry).
      try {
        await this.#runInTx((tx) => this.#store.recordLastConnected(tx, serverId, new Date()));
      } catch (err) {
        logger.warn(
          { err, serverId },
          "MCP pool: recordLastConnected failed; connection still live",
        );
      }
      return connection;
    } catch (err) {
      // Pool was closed during spawn — propagate the failure without
      // repopulating the entry map (the close already cleared it).
      if (this.#closed) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // `recordLastError` is best-effort observability — don't let a DB
      // blip mask the original spawn error or skip the reconnect-state
      // bookkeeping below. Log and continue.
      try {
        await this.#runInTx((tx) => this.#store.recordLastError(tx, serverId, message));
      } catch (recordErr) {
        logger.warn(
          { err: recordErr, serverId },
          "failed to record mcp connection error — continuing with reconnect bookkeeping",
        );
      }
      // Reconnect counter invariant: only the failed-spawn path increments
      // `reconnectAttempts`. A successful spawn writes `live` (no counter),
      // and the transport-close handler writes `closed` with attempts=0 —
      // so a healthy reconnect after a transport drop sees prev.kind ===
      // "closed" with attempts=0 and starts at 1, while a second-attempt
      // failure sees attempts=1 and goes unhealthy. Live → closed → live
      // implicitly resets the counter because the success-path overwrites
      // the entry without reading the prior value.
      const attempts = prev?.kind === "closed" ? prev.reconnectAttempts + 1 : 1;
      if (attempts >= 2) {
        this.#entries.set(serverId, { kind: "unhealthy", lastError: message });
      } else {
        this.#entries.set(serverId, { kind: "closed", reconnectAttempts: attempts });
      }
      throw err;
    }
  }

  /** Close any live connection and forget the entry. Used on remove / config-change. */
  async evict(serverId: string): Promise<void> {
    const state = this.#entries.get(serverId);
    this.#entries.delete(serverId);
    if (state?.kind === "live") {
      try {
        await state.connection.close();
      } catch (err) {
        logger.warn({ err, serverId }, "MCP pool: close on evict failed");
      }
    }
  }

  /**
   * Clear an `unhealthy` entry so the next `getConnection` retries from
   * scratch. Live entries are deliberately left alone — dropping the map
   * reference without `close()`-ing would orphan the running subprocess.
   * Closed entries are also left alone; the next `getConnection` already
   * retries them via the reconnect-once policy. Use `evict(id)` to
   * forcefully tear down a live connection.
   */
  reset(serverId: string): void {
    const state = this.#entries.get(serverId);
    if (state?.kind === "unhealthy") {
      this.#entries.delete(serverId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#evictionTimer) {
      clearInterval(this.#evictionTimer);
      this.#evictionTimer = null;
    }
    const live = [...this.#entries.values()].filter(
      (s): s is Extract<EntryState, { kind: "live" }> => s.kind === "live",
    );
    await Promise.allSettled(live.map((s) => s.connection.close()));
    this.#entries.clear();
  }

  #sweepIdle(): void {
    if (this.#closed) return;
    const cutoff = this.#now() - this.#idleEvictionMs;
    for (const [id, state] of this.#entries) {
      if (state.kind === "live" && state.lastUsedAt < cutoff) {
        this.#entries.delete(id);
        state.connection.close().catch((err) => {
          logger.warn({ err, serverId: id }, "MCP pool: close on idle eviction failed");
        });
      }
    }
  }

  /** Test seam — inspect entry state without exposing it as part of the public API. */
  __getEntryState(serverId: string): EntryState | undefined {
    return this.#entries.get(serverId);
  }
}
