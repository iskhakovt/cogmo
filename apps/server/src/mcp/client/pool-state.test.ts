import * as R from "remeda";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { McpPoolError } from "../errors.js";
import type { McpConnection } from "./client.js";
import {
  type EntryKind,
  type EntryState,
  type PoolEffect,
  type PoolEvent,
  type Transition,
  transition,
  type Waiter,
} from "./pool-state.js";

/** The entry's own connect. */
const OWN = new AbortController();
/** An abandoned connect. */
const STALE = new AbortController();
/** The watch on the entry's live connection. */
const WATCH = new AbortController();
/** The entry's live connection. */
const LIVE = mock<McpConnection>();
/** What a connect yields. */
const ARRIVING = mock<McpConnection>();
const WAITING: Waiter = () => {};
const CALLER: Waiter = () => {};
const BOOM = new Error("boom");
const NOT_FOUND = new McpPoolError("server_not_found");
const USED_AT = 1_000;

const STATES = {
  none: undefined,
  connecting: { kind: "connecting", abort: OWN, attempt: 1, waiters: [WAITING] },
  reconnecting: { kind: "connecting", abort: OWN, attempt: 2, waiters: [WAITING] },
  live: { kind: "live", connection: LIVE, watch: WATCH, lastUsedAt: USED_AT },
  closed: { kind: "closed", failedAttempts: 0 },
  failed_once: { kind: "closed", failedAttempts: 1 },
  unhealthy: { kind: "unhealthy", lastError: "boom" },
} satisfies Record<string, EntryState | undefined>;

const EVENTS = {
  get: { type: "get", waiter: CALLER, at: USED_AT + 50 },
  spawned_own: { type: "spawned", signal: OWN.signal, connection: ARRIVING, at: USED_AT + 50 },
  spawned_stale: { type: "spawned", signal: STALE.signal, connection: ARRIVING, at: USED_AT + 50 },
  failed_own: { type: "spawn_failed", signal: OWN.signal, error: BOOM, spent: true },
  failed_own_unspent: { type: "spawn_failed", signal: OWN.signal, error: NOT_FOUND, spent: false },
  failed_stale: { type: "spawn_failed", signal: STALE.signal, error: BOOM, spent: true },
  transport_closed_own: { type: "transport_closed", connection: LIVE },
  transport_closed_other: { type: "transport_closed", connection: ARRIVING },
  evict: { type: "evict" },
  reset: { type: "reset" },
  idle_expired: { type: "idle", connection: LIVE, cutoff: USED_AT },
  idle_used: { type: "idle", connection: LIVE, cutoff: USED_AT - 100 },
  idle_other: { type: "idle", connection: ARRIVING, cutoff: USED_AT },
  pool_closed: { type: "pool_closed" },
} satisfies Record<string, PoolEvent>;

type StateName = keyof typeof STATES;
type EventName = keyof typeof EVENTS;

/** Compiles only when every event type has a fixture — checked by typecheck, not at runtime. */
type Uncovered = Exclude<PoolEvent["type"], (typeof EVENTS)[EventName]["type"]>;
const EVERY_EVENT_COVERED: [Uncovered] extends [never] ? true : never = true;

type EffectType = PoolEffect["type"];
/** The next entry's kind (`none` for no entry) and the effects, in order. */
type Row = readonly [next: EntryKind | "none", effects: ReadonlyArray<EffectType>];

const STAY_NONE: Row = ["none", []];
const ABANDONED: ReadonlyArray<EffectType> = ["close", "log"];

/** Every (state, event) pair. */
const TABLE: Record<StateName, Record<EventName, Row>> = {
  none: {
    get: ["connecting", ["connect"]],
    spawned_own: ["none", ABANDONED],
    spawned_stale: ["none", ABANDONED],
    failed_own: STAY_NONE,
    failed_own_unspent: STAY_NONE,
    failed_stale: STAY_NONE,
    transport_closed_own: STAY_NONE,
    transport_closed_other: STAY_NONE,
    evict: STAY_NONE,
    reset: STAY_NONE,
    idle_expired: STAY_NONE,
    idle_used: STAY_NONE,
    idle_other: STAY_NONE,
    pool_closed: STAY_NONE,
  },
  connecting: {
    get: ["connecting", []],
    spawned_own: ["live", ["settle", "watch", "record_connected"]],
    spawned_stale: ["connecting", ABANDONED],
    failed_own: ["closed", ["settle", "record_error"]],
    failed_own_unspent: ["none", ["settle"]],
    failed_stale: ["connecting", []],
    transport_closed_own: ["connecting", []],
    transport_closed_other: ["connecting", []],
    evict: ["none", ["abort", "settle"]],
    reset: ["connecting", []],
    idle_expired: ["connecting", []],
    idle_used: ["connecting", []],
    idle_other: ["connecting", []],
    pool_closed: ["none", ["abort", "settle"]],
  },
  reconnecting: {
    get: ["connecting", []],
    spawned_own: ["live", ["settle", "watch", "record_connected"]],
    spawned_stale: ["connecting", ABANDONED],
    failed_own: ["unhealthy", ["settle", "record_error"]],
    failed_own_unspent: ["closed", ["settle"]],
    failed_stale: ["connecting", []],
    transport_closed_own: ["connecting", []],
    transport_closed_other: ["connecting", []],
    evict: ["none", ["abort", "settle"]],
    reset: ["connecting", []],
    idle_expired: ["connecting", []],
    idle_used: ["connecting", []],
    idle_other: ["connecting", []],
    pool_closed: ["none", ["abort", "settle"]],
  },
  live: {
    get: ["live", ["settle"]],
    spawned_own: ["live", ABANDONED],
    spawned_stale: ["live", ABANDONED],
    failed_own: ["live", []],
    failed_own_unspent: ["live", []],
    failed_stale: ["live", []],
    transport_closed_own: ["closed", ["abort"]],
    transport_closed_other: ["live", []],
    evict: ["none", ["abort", "close"]],
    reset: ["live", []],
    idle_expired: ["none", ["abort", "close", "log"]],
    idle_used: ["live", ["arm_idle"]],
    idle_other: ["live", []],
    pool_closed: ["none", ["abort", "close"]],
  },
  closed: {
    get: ["connecting", ["connect"]],
    spawned_own: ["closed", ABANDONED],
    spawned_stale: ["closed", ABANDONED],
    failed_own: ["closed", []],
    failed_own_unspent: ["closed", []],
    failed_stale: ["closed", []],
    transport_closed_own: ["closed", []],
    transport_closed_other: ["closed", []],
    evict: STAY_NONE,
    reset: ["closed", []],
    idle_expired: ["closed", []],
    idle_used: ["closed", []],
    idle_other: ["closed", []],
    pool_closed: STAY_NONE,
  },
  failed_once: {
    get: ["connecting", ["connect"]],
    spawned_own: ["closed", ABANDONED],
    spawned_stale: ["closed", ABANDONED],
    failed_own: ["closed", []],
    failed_own_unspent: ["closed", []],
    failed_stale: ["closed", []],
    transport_closed_own: ["closed", []],
    transport_closed_other: ["closed", []],
    evict: STAY_NONE,
    reset: ["closed", []],
    idle_expired: ["closed", []],
    idle_used: ["closed", []],
    idle_other: ["closed", []],
    pool_closed: STAY_NONE,
  },
  unhealthy: {
    get: ["unhealthy", ["settle"]],
    spawned_own: ["unhealthy", ABANDONED],
    spawned_stale: ["unhealthy", ABANDONED],
    failed_own: ["unhealthy", []],
    failed_own_unspent: ["unhealthy", []],
    failed_stale: ["unhealthy", []],
    transport_closed_own: ["unhealthy", []],
    transport_closed_other: ["unhealthy", []],
    evict: STAY_NONE,
    reset: STAY_NONE,
    idle_expired: ["unhealthy", []],
    idle_used: ["unhealthy", []],
    idle_other: ["unhealthy", []],
    pool_closed: STAY_NONE,
  },
};

interface Pair {
  stateName: StateName;
  eventName: EventName;
  before: EntryState | undefined;
  after: Transition;
}

const PAIRS: Pair[] = R.keys(STATES).flatMap((stateName) =>
  R.keys(EVENTS).map((eventName) => ({
    stateName,
    eventName,
    before: STATES[stateName],
    after: transition(STATES[stateName], EVENTS[eventName]),
  })),
);

function pairsWhere(predicate: (pair: Pair) => boolean): Array<[StateName, EventName]> {
  return PAIRS.filter(predicate).map((p) => [p.stateName, p.eventName]);
}

function effectsOf<T extends EffectType>(
  pair: Pair,
  type: T,
): Array<Extract<PoolEffect, { type: T }>> {
  return pair.after.effects.filter((e): e is Extract<PoolEffect, { type: T }> => e.type === type);
}

function kindOf(entry: EntryState | undefined): EntryKind | "none" {
  return entry?.kind ?? "none";
}

/** The controller an entry holds: its connect's, or its live connection's watch. */
function controllerOf(entry: EntryState | undefined): AbortController | undefined {
  if (entry?.kind === "connecting") return entry.abort;
  if (entry?.kind === "live") return entry.watch;
  return undefined;
}

describe("the pool entry machine", () => {
  it("has a fixture for every event type", () => {
    // `EVERY_EVENT_COVERED` fails typecheck, not this assertion, when an event type has no fixture.
    expect(EVERY_EVENT_COVERED).toBe(true);
  });

  it.each(PAIRS)("$stateName × $eventName", ({ stateName, eventName, after }) => {
    const [next, effects] = TABLE[stateName][eventName];
    expect(kindOf(after.entry)).toBe(next);
    expect(after.effects.map((e) => e.type)).toEqual(effects);
  });

  describe("invariants over every pair", () => {
    it("starts a connect only on get, from no entry or closed, counting the failures before it", () => {
      expect(pairsWhere((p) => effectsOf(p, "connect").length > 0)).toEqual([
        ["none", "get"],
        ["closed", "get"],
        ["failed_once", "get"],
      ]);
      const attempts = R.mapValues(
        { none: STATES.none, closed: STATES.closed, failed_once: STATES.failed_once },
        (state) => {
          const { entry, effects } = transition(state, EVENTS.get);
          if (entry?.kind !== "connecting") throw new Error("expected a connect");
          expect(effects).toEqual([{ type: "connect", signal: entry.abort.signal }]);
          expect(entry.waiters).toEqual([CALLER]);
          return entry.attempt;
        },
      );
      expect(attempts).toEqual({ none: 1, closed: 1, failed_once: 2 });
    });

    it("makes an arriving connection the live one, or closes it", () => {
      for (const p of PAIRS.filter((pair) => pair.eventName.startsWith("spawned"))) {
        const kept = p.after.entry?.kind === "live" && p.after.entry.connection === ARRIVING;
        const closed = effectsOf(p, "close").some((e) => e.connection === ARRIVING);
        expect(kept !== closed, `${p.stateName} × ${p.eventName}`).toBe(true);
      }
      expect(
        pairsWhere((p) => kindOf(p.before) !== "live" && kindOf(p.after.entry) === "live"),
      ).toEqual([
        ["connecting", "spawned_own"],
        ["reconnecting", "spawned_own"],
      ]);
    });

    it("closes a live connection that leaves the entry, unless its own transport closed", () => {
      const leaving = PAIRS.filter(
        (p) =>
          p.before?.kind === "live" &&
          !(p.after.entry?.kind === "live" && p.after.entry.connection === LIVE),
      );
      expect(leaving.map((p) => p.eventName)).toEqual([
        "transport_closed_own",
        "evict",
        "idle_expired",
        "pool_closed",
      ]);
      for (const p of leaving) {
        const closesIt = effectsOf(p, "close").some((e) => e.connection === LIVE);
        expect(closesIt, p.eventName).toBe(p.eventName !== "transport_closed_own");
      }
    });

    it("aborts a connect only to abandon it, and a live connection's watch when it leaves", () => {
      expect(pairsWhere((p) => effectsOf(p, "abort").length > 0)).toEqual([
        ["connecting", "evict"],
        ["connecting", "pool_closed"],
        ["reconnecting", "evict"],
        ["reconnecting", "pool_closed"],
        ["live", "transport_closed_own"],
        ["live", "evict"],
        ["live", "idle_expired"],
        ["live", "pool_closed"],
      ]);
      for (const p of PAIRS.filter((pair) => effectsOf(pair, "abort").length > 0)) {
        expect(effectsOf(p, "abort"), `${p.stateName} × ${p.eventName}`).toEqual([
          { type: "abort", controller: controllerOf(p.before) },
        ]);
        expect(p.after.entry?.kind, `${p.stateName} × ${p.eventName}`).not.toBe(p.before?.kind);
      }
    });

    it("settles every waiter exactly once", () => {
      for (const p of PAIRS) {
        const waiting = p.before?.kind === "connecting" ? p.before.waiters : [];
        const stillWaiting = p.after.entry?.kind === "connecting" ? p.after.entry.waiters : [];
        const settled = effectsOf(p, "settle").flatMap((e) => e.waiters);
        const joined = p.eventName === "get" ? [CALLER] : [];
        // Every waiter before, and the caller joining, is either still waiting or settled — never both.
        expect(
          R.sortBy([...stillWaiting, ...settled], (w) => (w === WAITING ? 0 : 1)),
          `${p.stateName} × ${p.eventName}`,
        ).toEqual([...waiting, ...joined]);
      }
    });

    it("fails an ended connect's waiters with the reason it ended", () => {
      for (const [stateName, eventName, code] of [
        ["connecting", "evict", "evicted"],
        ["connecting", "pool_closed", "pool_closed"],
        ["reconnecting", "evict", "evicted"],
      ] as const) {
        const [settled] = transition(STATES[stateName], EVENTS[eventName]).effects.filter(
          (e) => e.type === "settle",
        );
        expect(settled).toMatchObject({ waiters: [WAITING] });
        const result = settled?.type === "settle" ? settled.result : undefined;
        expect(result?._unsafeUnwrapErr()).toMatchObject({ code });
      }
    });

    it("makes a server unhealthy only when its last attempt fails at the runner", () => {
      expect(
        pairsWhere(
          (p) => kindOf(p.before) !== "unhealthy" && kindOf(p.after.entry) === "unhealthy",
        ),
      ).toEqual([["reconnecting", "failed_own"]]);
      expect(transition(STATES.reconnecting, EVENTS.failed_own).entry).toEqual({
        kind: "unhealthy",
        lastError: "boom",
      });
    });

    it("spends no attempt on a connect that never reached the runner", () => {
      expect(transition(STATES.connecting, EVENTS.failed_own_unspent).entry).toBeUndefined();
      expect(transition(STATES.reconnecting, EVENTS.failed_own_unspent).entry).toEqual({
        kind: "closed",
        failedAttempts: 1,
      });
      expect(transition(STATES.connecting, EVENTS.failed_own).entry).toEqual({
        kind: "closed",
        failedAttempts: 1,
      });
    });

    it("records a failure only when it spent an attempt", () => {
      expect(pairsWhere((p) => effectsOf(p, "record_error").length > 0)).toEqual([
        ["connecting", "failed_own"],
        ["reconnecting", "failed_own"],
      ]);
    });

    it("forgets every entry on evict and pool_closed", () => {
      expect(
        pairsWhere(
          (p) =>
            (p.eventName === "evict" || p.eventName === "pool_closed") &&
            p.after.entry !== undefined,
        ),
      ).toEqual([]);
    });
  });

  describe("single transitions", () => {
    it("hands a live connection to a caller and marks it used", () => {
      const { entry, effects } = transition(STATES.live, EVENTS.get);
      expect(entry).toEqual({ ...STATES.live, lastUsedAt: EVENTS.get.at });
      expect(effects).toEqual([
        { type: "settle", waiters: [CALLER], result: expect.objectContaining({ value: LIVE }) },
      ]);
    });

    it("fails a caller fast on an unhealthy server", () => {
      const [settled] = transition(STATES.unhealthy, EVENTS.get).effects;
      const result = settled?.type === "settle" ? settled.result : undefined;
      expect(result?._unsafeUnwrapErr()).toMatchObject({
        code: "server_unhealthy",
        message: "boom",
      });
    });

    it("goes live on its own connect's connection and watches it under a new controller", () => {
      const { entry, effects } = transition(STATES.connecting, EVENTS.spawned_own);
      if (entry?.kind !== "live") throw new Error("expected live");
      expect(entry).toMatchObject({ connection: ARRIVING, lastUsedAt: EVENTS.spawned_own.at });
      expect(entry.watch).not.toBe(OWN);
      expect(effects).toContainEqual({
        type: "watch",
        connection: ARRIVING,
        signal: entry.watch.signal,
      });
    });

    it("re-arms the idle timer for the rest of the idle period of a connection used since", () => {
      expect(transition(STATES.live, EVENTS.idle_used).effects).toEqual([
        { type: "arm_idle", connection: LIVE, signal: WATCH.signal, delayMs: 100 },
      ]);
    });
  });
});
