/**
 * Auto-repair cooldown curve and predicates. See
 * `design/agent-resilience.md` → Cooldown curve.
 */

import type { CooldownState } from "./store/schema.js";

/** Seconds. First cooldown after a fresh failure. */
export const COOLDOWN_BASE_SECONDS = 60;
/** Seconds. Upper bound regardless of consecutive-failure count. */
export const COOLDOWN_CAP_SECONDS = 3600;
/** Doubling factor per consecutive failure. */
export const COOLDOWN_MULTIPLIER = 2;

/**
 * Compute the cooldown blob to write for the next failure. Reads the
 * prior blob (if any), doubles its `cooldownSeconds` (capped at 1h), and
 * increments `consecutiveFailures`. A fresh failure (`prior === null`)
 * starts the curve at the base.
 */
export function nextCooldownState(prior: CooldownState | null, now: Date): CooldownState {
  if (prior === null) {
    return {
      lastErroredAt: now.toISOString(),
      cooldownSeconds: COOLDOWN_BASE_SECONDS,
      consecutiveFailures: 1,
    };
  }
  return {
    lastErroredAt: now.toISOString(),
    cooldownSeconds: Math.min(prior.cooldownSeconds * COOLDOWN_MULTIPLIER, COOLDOWN_CAP_SECONDS),
    consecutiveFailures: prior.consecutiveFailures + 1,
  };
}

/**
 * `true` when the conversation is in the Open state — an inbound should
 * skip `handle-message`'s main flow and get a terse in-cooldown reply.
 * Once the cooldown elapses (Half-open), the predicate returns `false`
 * and the next inbound runs as a normal probe turn.
 */
export function isInCooldown(state: CooldownState | null, now: Date): boolean {
  if (state === null) return false;
  return now.getTime() < cooldownEndsAt(state).getTime();
}

/** Absolute time at which the cooldown window closes. */
export function cooldownEndsAt(state: CooldownState): Date {
  return new Date(Date.parse(state.lastErroredAt) + state.cooldownSeconds * 1000);
}

/**
 * Coarse human-readable estimate of remaining cooldown for the
 * in-cooldown reply. Rounds to seconds under a minute, minutes under
 * an hour, hours otherwise. Stale by the time the user reads it —
 * accepted by design (the doc treats this as an order-of-magnitude
 * hint, not a stopwatch).
 *
 * Returns `"a moment"` for any non-positive remainder so the surrounding
 * sentence stays grammatical when `now` slipped past `endsAt` between
 * the predicate check and the reply build.
 */
export function formatRemainingCooldown(state: CooldownState, now: Date): string {
  const remainingMs = cooldownEndsAt(state).getTime() - now.getTime();
  if (remainingMs <= 0) return "a moment";
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The text the in-cooldown entry guard delivers when an inbound arrives
 * during the Open state. Hand-built, no LLM call.
 */
export function buildInCooldownReply(state: CooldownState, now: Date): string {
  return `I hit an error on the last message and I'm waiting before trying again. Try again in ${formatRemainingCooldown(state, now)}.`;
}
