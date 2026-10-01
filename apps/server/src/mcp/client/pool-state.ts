import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { describeMcpPoolError, type McpPoolError } from "../errors.js";
import type { McpConnection } from "./client.js";

/**
 * One MCP server's entry in the connection pool, as a pure state machine.
 * `transition` takes every event in every state and returns the next entry
 * and the effects to carry out; `McpConnectionPool` feeds it, supplying the
 * controller a connect runs under, and carries them out. No entry
 * (`undefined`) is a server with nothing open. See
 * `design/integrations/mcp.md` → Connection pool.
 *
 * ```
 *  (none) ─get─► connecting ─spawned─► live ─transport_closed─► closed
 *                 ▲    │                                           │
 *                 │    └─spawn_failed─► closed, or unhealthy       │
 *                 │                     on the last attempt        │
 *                 └──────────────────────get───────────────────────┘
 *  connecting · live ─evict · pool_closed─► (none)
 *  live ─idle─► (none)       unhealthy ─reset─► (none)
 * ```
 *
 * Invariants the table enforces:
 *  - only `get` starts a connect, from no entry or `closed`, so a server has
 *    at most one in flight;
 *  - a connection a connect yields becomes the entry's live connection, or is
 *    closed on arrival;
 *  - a live connection is closed as it leaves the entry, unless its own
 *    transport closing is why it left;
 *  - every waiter is settled exactly once;
 *  - the entry's controller is aborted exactly when a connect in flight or a
 *    live connection leaves it.
 */

/** Connects in a row before a server is `unhealthy`: the first, and one reconnect. */
export const MAX_CONNECT_ATTEMPTS = 2;

/** A `getConnection` call waiting for its outcome. */
export type Waiter = (result: Result<McpConnection, McpPoolError>) => void;

export type EntryState =
  /**
   * A connect is in flight; `attempt` counts it among the connects in a row.
   * Aborting `abort` abandons it.
   */
  | { kind: "connecting"; abort: AbortController; attempt: number; waiters: ReadonlyArray<Waiter> }
  /**
   * `abort` is the controller its connect ran under, which the runner ignores
   * once it has yielded the connection. Aborting it ends the watch on
   * `connection`: its close subscription and idle timer.
   */
  | { kind: "live"; connection: McpConnection; abort: AbortController; lastUsedAt: number }
  /** The transport closed, or the last `failedAttempts` connects failed. */
  | { kind: "closed"; failedAttempts: number }
  /** `MAX_CONNECT_ATTEMPTS` connects in a row failed: every `get` fails fast until a `reset`. */
  | { kind: "unhealthy"; lastError: string };

export type EntryKind = EntryState["kind"];

/** Any entry, or none: the fallback arm of a transition that only one entry acts on. */
const ANY_ENTRY = P.union(undefined, {
  kind: P.union("connecting", "live", "closed", "unhealthy"),
});

export type PoolEvent =
  /**
   * A caller wants the connection; `at` is when, in epoch ms. `abort` is a
   * fresh controller for the connect this call starts, if it starts one.
   */
  | { type: "get"; waiter: Waiter; at: number; abort: AbortController }
  /** The connect running under `signal` yielded `connection`. */
  | { type: "spawned"; signal: AbortSignal; connection: McpConnection; at: number }
  /**
   * The connect running under `signal` failed. `spent` when it reached the
   * runner: one that failed looking up the server spawned nothing.
   */
  | { type: "spawn_failed"; signal: AbortSignal; failure: McpPoolError; spent: boolean }
  | { type: "transport_closed"; connection: McpConnection }
  /** The server was removed. */
  | { type: "evict" }
  /** The operator asked to retry an unhealthy server. */
  | { type: "reset" }
  /** `connection`'s idle timer fired: it has idled out if last used at or before `cutoff`. */
  | { type: "idle"; connection: McpConnection; cutoff: number }
  | { type: "pool_closed" };

export type PoolEffect =
  /** Connect under `signal`; the outcome comes back as `spawned` or `spawn_failed`. */
  | { type: "connect"; signal: AbortSignal }
  /** Abandon a connect, or end a live connection's watch. */
  | { type: "abort"; controller: AbortController }
  | { type: "settle"; waiters: ReadonlyArray<Waiter>; result: Result<McpConnection, McpPoolError> }
  | { type: "close"; connection: McpConnection }
  /**
   * Until `signal` aborts, report `connection`'s transport closing, and arm
   * its idle timer for the full idle period.
   */
  | { type: "watch"; connection: McpConnection; signal: AbortSignal }
  /** Re-arm `connection`'s idle timer for `delayMs`, until `signal` aborts. */
  | { type: "arm_idle"; connection: McpConnection; signal: AbortSignal; delayMs: number }
  | { type: "record_connected" }
  | { type: "record_error"; message: string }
  /** A debug log line. */
  | { type: "log"; message: string };

export interface Transition {
  entry: EntryState | undefined;
  effects: ReadonlyArray<PoolEffect>;
}

/** Take in an event: the next entry and its effects. */
export function transition(entry: EntryState | undefined, event: PoolEvent): Transition {
  return match<PoolEvent, Transition>(event)
    .with({ type: "get" }, (e) => onGet(entry, e))
    .with({ type: "spawned" }, (e) => onSpawned(entry, e))
    .with({ type: "spawn_failed" }, (e) => onSpawnFailed(entry, e))
    .with({ type: "transport_closed" }, ({ connection }) => onTransportClosed(entry, connection))
    .with({ type: "evict" }, () => end(entry, "evicted"))
    .with({ type: "reset" }, () => onReset(entry))
    .with({ type: "idle" }, ({ connection, cutoff }) => onIdle(entry, connection, cutoff))
    .with({ type: "pool_closed" }, () => end(entry, "pool_closed"))
    .exhaustive();
}

function onGet(
  entry: EntryState | undefined,
  { waiter, at, abort }: Extract<PoolEvent, { type: "get" }>,
): Transition {
  return match<EntryState | undefined, Transition>(entry)
    .with(undefined, () => connect(abort, 1, waiter))
    .with({ kind: "closed" }, (s) => connect(abort, s.failedAttempts + 1, waiter))
    .with({ kind: "connecting" }, (s) => step({ ...s, waiters: [...s.waiters, waiter] }, []))
    .with({ kind: "live" }, (s) =>
      step({ ...s, lastUsedAt: at }, [settle([waiter], ok(s.connection))]),
    )
    .with({ kind: "unhealthy" }, (s) =>
      step(s, [settle([waiter], err({ code: "server_unhealthy", lastError: s.lastError }))]),
    )
    .exhaustive();
}

/** A connection from any connect but the entry's own was abandoned: close it. */
function onSpawned(
  entry: EntryState | undefined,
  { signal, connection, at }: Extract<PoolEvent, { type: "spawned" }>,
): Transition {
  return match<EntryState | undefined, Transition>(entry)
    .with(
      { kind: "connecting" },
      (s) => s.abort.signal === signal,
      (s) =>
        step({ kind: "live", connection, abort: s.abort, lastUsedAt: at }, [
          settle(s.waiters, ok(connection)),
          { type: "watch", connection, signal },
          { type: "record_connected" },
        ]),
    )
    .with(ANY_ENTRY, (s) =>
      step(s, [
        { type: "close", connection },
        logEffect("closing a connection from an abandoned connect"),
      ]),
    )
    .exhaustive();
}

/**
 * The entry's own connect failed. One that never reached the runner spends
 * no attempt; the last attempt failing makes the server unhealthy. An
 * abandoned connect's failure changes nothing.
 */
function onSpawnFailed(
  entry: EntryState | undefined,
  { signal, failure, spent }: Extract<PoolEvent, { type: "spawn_failed" }>,
): Transition {
  return match<EntryState | undefined, Transition>(entry)
    .with(
      { kind: "connecting" },
      (s) => s.abort.signal === signal,
      (s) => {
        const failed = settle(s.waiters, err(failure));
        if (!spent) return step(closedAfter(s.attempt - 1), [failed]);
        const message = describeMcpPoolError(failure);
        const next: EntryState =
          s.attempt >= MAX_CONNECT_ATTEMPTS
            ? { kind: "unhealthy", lastError: message }
            : { kind: "closed", failedAttempts: s.attempt };
        return step(next, [failed, { type: "record_error", message }]);
      },
    )
    .with(ANY_ENTRY, (s) => step(s, []))
    .exhaustive();
}

/** Only the live connection's own transport closing counts. */
function onTransportClosed(entry: EntryState | undefined, connection: McpConnection): Transition {
  return match<EntryState | undefined, Transition>(entry)
    .with(
      { kind: "live" },
      (s) => s.connection === connection,
      (s) => step({ kind: "closed", failedAttempts: 0 }, [abortEffect(s.abort)]),
    )
    .with(ANY_ENTRY, (s) => step(s, []))
    .exhaustive();
}

function onReset(entry: EntryState | undefined): Transition {
  return match<EntryState | undefined, Transition>(entry)
    .with({ kind: "unhealthy" }, () => step(undefined, []))
    .with(P.union(undefined, { kind: P.union("connecting", "live", "closed") }), (s) => step(s, []))
    .exhaustive();
}

/**
 * The live connection's idle timer fired. Used since `cutoff`, it re-arms
 * for the rest of its idle period; a timer for any other connection is stale.
 */
function onIdle(
  entry: EntryState | undefined,
  connection: McpConnection,
  cutoff: number,
): Transition {
  return match<EntryState | undefined, Transition>(entry)
    .with(
      { kind: "live" },
      (s) => s.connection === connection,
      (s) =>
        s.lastUsedAt <= cutoff
          ? step(undefined, [
              abortEffect(s.abort),
              { type: "close", connection },
              logEffect("closing an idle MCP connection"),
            ])
          : step(s, [
              {
                type: "arm_idle",
                connection,
                signal: s.abort.signal,
                delayMs: s.lastUsedAt - cutoff,
              },
            ]),
    )
    .with(ANY_ENTRY, (s) => step(s, []))
    .exhaustive();
}

/**
 * Forget the entry: an in-flight connect is aborted and its waiters fail
 * with `code`; a live connection is closed.
 */
function end(entry: EntryState | undefined, code: "evicted" | "pool_closed"): Transition {
  return match<EntryState | undefined, Transition>(entry)
    .with({ kind: "connecting" }, (s) =>
      step(undefined, [abortEffect(s.abort), settle(s.waiters, err({ code }))]),
    )
    .with({ kind: "live" }, (s) =>
      step(undefined, [abortEffect(s.abort), { type: "close", connection: s.connection }]),
    )
    .with(P.union(undefined, { kind: P.union("closed", "unhealthy") }), () => step(undefined, []))
    .exhaustive();
}

// --- helpers ---

function connect(abort: AbortController, attempt: number, waiter: Waiter): Transition {
  return step({ kind: "connecting", abort, attempt, waiters: [waiter] }, [
    { type: "connect", signal: abort.signal },
  ]);
}

/** No entry is `closed` with no failures: a fresh server. */
function closedAfter(failedAttempts: number): EntryState | undefined {
  return failedAttempts === 0 ? undefined : { kind: "closed", failedAttempts };
}

function settle(
  waiters: ReadonlyArray<Waiter>,
  result: Result<McpConnection, McpPoolError>,
): PoolEffect {
  return { type: "settle", waiters, result };
}

function abortEffect(controller: AbortController): PoolEffect {
  return { type: "abort", controller };
}

function logEffect(message: string): PoolEffect {
  return { type: "log", message };
}

function step(entry: EntryState | undefined, effects: ReadonlyArray<PoolEffect>): Transition {
  return { entry, effects };
}
