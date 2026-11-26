/**
 * The polling supervisor's state, and what reads it without moving it: how a
 * run's exit reads, the wait after a 409, and the liveness projection
 * (design/transport/telegram.md → Polling Supervision, design/liveness.md →
 * Telegram receive loop). `TelegramAdapter` holds the state and moves it.
 */

import { GrammyError } from "grammy";
import { match, P } from "ts-pattern";
import type { ChannelError, ChannelLiveness, LoopState, RetryCause } from "../../types.js";

/** The ceiling of the wait after a first 409. */
const CONFLICT_BACKOFF_FIRST_MS = 5_000;
const CONFLICT_BACKOFF_MAX_MS = 5 * 60_000;
/** A run this long resets the 409 streak; twice the cap, so two pollers taking turns never do. */
export const HEALTHY_RUN_MS = 10 * 60_000;

/** The verdict's thresholds (design/liveness.md → Verdict and thresholds). */
const STALE_AFTER_MS = 90_000;
const WEDGED_AFTER_MS = 5 * 60_000;

/** Where a run's `getUpdates` loop is. */
type ReceiveState =
  /** `bot.start()`'s setup, until `getUpdates` returns a batch. */
  | { kind: "starting" }
  | { kind: "receiving" }
  | {
      kind: "retrying";
      since: number;
      cause: Exclude<RetryCause, "conflict">;
      error: ChannelError;
    };

/** One `bot.start()`, from the call until its exit is handled. */
export interface PollingRun {
  kind: "polling";
  /** Settles once the run's exit has moved the state on. */
  run: Promise<void>;
  /** `performance.now()` at the `bot.start()` call. */
  startedAt: number;
  /** Consecutive 409s before this run. */
  conflicts: number;
  /** Written in place, since the supervisor finds the run by identity. */
  receive: ReceiveState;
}

/** Where polling is. Times are `performance.now()`. */
export type PollingState =
  | { kind: "idle" }
  | PollingRun
  | {
      kind: "backoff";
      timer: NodeJS.Timeout;
      /** The streak, this 409 included. */
      conflicts: number;
      since: number;
      error: ChannelError;
    }
  | { kind: "failed"; reason: "unauthorized" | "rejected" | "ended"; error: ChannelError | null }
  | { kind: "stopped"; drained: Promise<void> };

/** How a `bot.start()` ended. */
export type PollingExit =
  /** The way `bot.stop()` ends it: resolved, or a setup retry's wait cut short. */
  | { kind: "ended" }
  | { kind: "conflict"; err: GrammyError }
  | { kind: "unauthorized"; err: GrammyError }
  | { kind: "rejected"; err: unknown };

/** What `bot.start()` rejects with. */
export function classifyRejection(err: unknown): PollingExit {
  return match(err)
    .returnType<PollingExit>()
    .with(P.intersection(P.instanceOf(GrammyError), { error_code: 409 }), (e) => ({
      kind: "conflict",
      err: e,
    }))
    .with(P.intersection(P.instanceOf(GrammyError), { error_code: 401 }), (e) => ({
      kind: "unauthorized",
      err: e,
    }))
    .with(P.intersection(P.instanceOf(Error), { message: "Aborted delay" }), () => ({
      kind: "ended",
    }))
    .otherwise(() => ({ kind: "rejected", err }));
}

/**
 * The wait before the restart that follows the `conflicts`-th 409 in a row: a
 * random point in the upper half of a ceiling that doubles from 5 s to 5 min.
 */
export function conflictBackoffMs(conflicts: number): number {
  const ceiling = Math.min(
    CONFLICT_BACKOFF_MAX_MS,
    CONFLICT_BACKOFF_FIRST_MS * 2 ** (conflicts - 1),
  );
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

/** What the projection reads beside the state; both span runs. */
interface Progress {
  /** The last valid batch or finished update. */
  progressAt: number;
  handlingSince: number | null;
}

/** `polling` as a `ChannelLiveness`, at `now`. */
export function projectLiveness(
  polling: PollingState,
  { progressAt, handlingSince }: Progress,
  now: number,
): ChannelLiveness {
  const loop = match(polling)
    .returnType<{ state: LoopState; progressAt: number; conflicts: number }>()
    .with({ kind: "idle" }, () => ({ state: { kind: "starting" }, progressAt, conflicts: 0 }))
    .with({ kind: "polling" }, (run) => ({
      state: { ...run.receive },
      progressAt: Math.max(progressAt, run.startedAt),
      // Zero once a 409 would start the streak over.
      conflicts: now - run.startedAt < HEALTHY_RUN_MS ? run.conflicts : 0,
    }))
    .with({ kind: "backoff" }, ({ since, conflicts, error }) => ({
      state: { kind: "retrying", since, cause: "conflict", error },
      // A 409 is an answer, so the poll it ended was not stalled.
      progressAt: Math.max(progressAt, since),
      conflicts,
    }))
    .with({ kind: "failed" }, ({ reason, error }) => ({
      state: { kind: "failed", reason, error },
      progressAt,
      conflicts: 0,
    }))
    .with({ kind: "stopped" }, () => ({ state: { kind: "stopped" }, progressAt, conflicts: 0 }))
    .exhaustive();
  return {
    ...loop,
    handlingSince,
    thresholds: { staleAfterMs: STALE_AFTER_MS, wedgedAfterMs: WEDGED_AFTER_MS },
  };
}
