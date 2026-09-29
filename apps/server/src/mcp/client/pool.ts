import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transaction, Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { describeError } from "../../util/describe-error.js";
import type { McpServer } from "../config.js";
import { McpPoolError } from "../errors.js";
import type { McpStore } from "../store/index.js";
import type { McpConnection } from "./client.js";
import { type EntryState, type PoolEffect, type PoolEvent, transition } from "./pool-state.js";
import type { Runner } from "./runner.js";

const log = logger.child({ component: "mcp.pool" });

/** Node's timer ceiling; a longer delay would fire at once. An idle timer re-arms past it. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface McpConnectionPoolOptions {
  store: McpStore;
  secrets: SecretsStore;
  runInTx: Transactor;
  runner: Runner;
  /** ms; a live connection unused this long is closed. */
  idleEvictionMs: number;
}

/** Why a connect produced no connection, and whether it spent an attempt. */
interface ConnectFailure {
  error: Error;
  spent: boolean;
}

/**
 * Process-singleton connection pool for MCP servers. Each server's entry is
 * the machine in `pool-state.ts`; the pool feeds it events and carries out
 * the effects it returns.
 *
 * - **Lazy connect.** A server is spawned on the first `getConnection`, and
 *   concurrent calls share the one connect.
 * - **Reconnect once.** After the transport closes, the next call reconnects;
 *   a second failed connect in a row leaves the server unhealthy, failing
 *   fast until `reset`.
 * - **Idle eviction.** Each live connection has a timer, closing it once it
 *   has gone `idleEvictionMs` unused.
 * - **Teardown.** `evict` and `close` abort an in-flight connect, close what
 *   it still yields, and resolve once the connections are closed.
 */
export class McpConnectionPool {
  #store: McpStore;
  #secrets: SecretsStore;
  #runInTx: Transactor;
  #runner: Runner;
  #idleEvictionMs: number;
  #entries = new Map<string, EntryState>();
  /** Effects still running per server: connects, closes and store writes. */
  #work = new Map<string, Set<Promise<void>>>();
  #closed = false;

  constructor(opts: McpConnectionPoolOptions) {
    this.#store = opts.store;
    this.#secrets = opts.secrets;
    this.#runInTx = opts.runInTx;
    this.#runner = opts.runner;
    this.#idleEvictionMs = opts.idleEvictionMs;
  }

  async getConnection(serverId: string): Promise<McpConnection> {
    if (this.#closed) throw new McpPoolError("pool_closed");
    const outcome = Promise.withResolvers<Result<McpConnection, Error>>();
    this.#feed(serverId, {
      type: "get",
      waiter: outcome.resolve,
      at: Date.now(),
      abort: new AbortController(),
    });
    const result = await outcome.promise;
    if (result.isErr()) throw result.error;
    return result.value;
  }

  /**
   * Forget a removed server: close its live connection, or abort its connect,
   * whose waiters fail with `evicted` and whose connection is closed if it
   * still arrives. Resolves once they are closed.
   */
  async evict(serverId: string): Promise<void> {
    const running = [...(this.#work.get(serverId) ?? [])];
    await Promise.all([...this.#feed(serverId, { type: "evict" }), ...running]);
  }

  /** Let an unhealthy server's next `getConnection` connect afresh. Any other entry is untouched. */
  reset(serverId: string): void {
    this.#feed(serverId, { type: "reset" });
  }

  /** Close every connection, including those in-flight connects still yield, and wait for it. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const serverId of [...this.#entries.keys()]) {
      this.#feed(serverId, { type: "pool_closed" });
    }
    while (this.#work.size > 0) {
      await Promise.all([...this.#work.values()].flatMap((running) => [...running]));
    }
  }

  /** Test seam — inspect entry state without exposing it as part of the public API. */
  __getEntryState(serverId: string): EntryState | undefined {
    return this.#entries.get(serverId);
  }

  /** Move the server's entry on `event` and carry out the effects; resolves with the ones still running. */
  #feed(serverId: string, event: PoolEvent): ReadonlyArray<Promise<void>> {
    const next = transition(this.#entries.get(serverId), event);
    if (next.entry === undefined) this.#entries.delete(serverId);
    else this.#entries.set(serverId, next.entry);
    return next.effects.flatMap((effect) => this.#execute(serverId, effect));
  }

  #execute(serverId: string, effect: PoolEffect): ReadonlyArray<Promise<void>> {
    return match(effect)
      .returnType<ReadonlyArray<Promise<void>>>()
      .with({ type: "connect" }, ({ signal }) => [
        this.#track(serverId, this.#connect(serverId, signal)),
      ])
      .with({ type: "abort" }, ({ controller }) => {
        controller.abort();
        return [];
      })
      .with({ type: "settle" }, ({ waiters, result }) => {
        for (const waiter of waiters) waiter(result);
        return [];
      })
      .with({ type: "close" }, ({ connection }) => [
        this.#track(serverId, this.#closeConnection(serverId, connection)),
      ])
      .with({ type: "watch" }, ({ connection, signal }) => {
        this.#watch(serverId, connection, signal);
        return [];
      })
      .with({ type: "arm_idle" }, ({ connection, signal, delayMs }) => {
        this.#armIdle(serverId, connection, signal, delayMs);
        return [];
      })
      .with({ type: "record_connected" }, () => [
        this.#track(
          serverId,
          this.#record(serverId, "recordLastConnected", (tx) =>
            this.#store.recordLastConnected(tx, serverId, new Date()),
          ),
        ),
      ])
      .with({ type: "record_error" }, ({ message }) => [
        this.#track(
          serverId,
          this.#record(serverId, "recordLastError", (tx) =>
            this.#store.recordLastError(tx, serverId, message),
          ),
        ),
      ])
      .with({ type: "log" }, ({ message }) => {
        log.debug({ serverId }, message);
        return [];
      })
      .exhaustive();
  }

  /** Resolves once its outcome is fed and the effects that set off are done. */
  async #connect(serverId: string, signal: AbortSignal): Promise<void> {
    const spawned = await this.#spawn(serverId, signal);
    const event = spawned.match<PoolEvent>(
      (connection) => ({ type: "spawned", signal, connection, at: Date.now() }),
      ({ error, spent }) => ({ type: "spawn_failed", signal, error, spent }),
    );
    await Promise.all(this.#feed(serverId, event));
  }

  async #spawn(
    serverId: string,
    signal: AbortSignal,
  ): Promise<Result<McpConnection, ConnectFailure>> {
    const found: Result<McpServer, Error> = await this.#runInTx((tx) =>
      this.#store.getServerById(tx, serverId),
    ).then(
      (server) => (server ? ok(server) : err(new McpPoolError("server_not_found"))),
      (e: unknown) => err(asError(e)),
    );
    if (found.isErr()) return err({ error: found.error, spent: false });
    try {
      signal.throwIfAborted();
      return ok(await this.#runner.spawn(found.value, this.#secrets, this.#runInTx, signal));
    } catch (e) {
      return err({ error: asError(e), spent: true });
    }
  }

  /** Until `signal` aborts: feed the transport closing, and arm the idle timer. */
  #watch(serverId: string, connection: McpConnection, signal: AbortSignal): void {
    const unsubscribe = connection.onClose(() => {
      this.#feed(serverId, { type: "transport_closed", connection });
    });
    if (signal.aborted) unsubscribe();
    else signal.addEventListener("abort", unsubscribe, { once: true });
    this.#armIdle(serverId, connection, signal, this.#idleEvictionMs);
  }

  #armIdle(
    serverId: string,
    connection: McpConnection,
    signal: AbortSignal,
    delayMs: number,
  ): void {
    if (signal.aborted) return;
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", disarm);
        this.#feed(serverId, {
          type: "idle",
          connection,
          cutoff: Date.now() - this.#idleEvictionMs,
        });
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS),
    );
    timer.unref();
    const disarm = () => clearTimeout(timer);
    signal.addEventListener("abort", disarm, { once: true });
  }

  async #closeConnection(serverId: string, connection: McpConnection): Promise<void> {
    try {
      await connection.close();
    } catch (e) {
      log.warn({ err: e, serverId }, "closing an MCP connection failed");
    }
  }

  /** Best-effort bookkeeping: a failed write is logged and changes nothing. */
  async #record(
    serverId: string,
    what: string,
    write: (tx: Transaction) => Promise<unknown>,
  ): Promise<void> {
    try {
      await this.#runInTx(write);
    } catch (e) {
      log.warn({ err: e, serverId }, `${what} failed`);
    }
  }

  /** Effects catch their own failures, so a tracked one never rejects. */
  #track(serverId: string, work: Promise<void>): Promise<void> {
    const running = this.#work.get(serverId) ?? new Set();
    this.#work.set(serverId, running);
    running.add(work);
    void work.finally(() => {
      running.delete(work);
      if (running.size === 0) this.#work.delete(serverId);
    });
    return work;
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(describeError(e));
}
