const MS_PER_SECOND = 1000;

/**
 * Whole seconds `step.sleep` will really wait for a requested duration.
 *
 * Inngest's durable waits have a one-second resolution. `step.sleep` runs its
 * argument through the SDK's `timeStr`, which decomposes the duration into
 * whole `w`/`d`/`h`/`m`/`s` units — there is no millisecond unit to carry a
 * remainder. So a positive duration below one second rounds up to one second,
 * and anything longer keeps only its whole seconds: a request for `"2500ms"`
 * is a two-second wait on the wire.
 */
export function durableSleepSeconds(requestedMs: number): number {
  return Math.max(1, Math.floor(requestedMs / MS_PER_SECOND));
}

/**
 * The wait `step.sleep` will actually perform for a requested duration,
 * quantised to the resolution described on {@link durableSleepSeconds}.
 *
 * Timer handlers sleep for this value and record it on the histogram, so the
 * durable wait and the observed sample are the same number. Passing the raw
 * request through instead would leave the histogram claiming a precision the
 * platform cannot hold — a sub-second hold that never happened, or a
 * fractional-second tail that was dropped before the op left the SDK.
 *
 * Non-positive values pass through untouched: the resolution applies to
 * positive durations only, and a timeout of zero or less means the timer isn't
 * scheduled at all.
 */
export function durableSleepMs(requestedMs: number): number {
  if (requestedMs <= 0) return requestedMs;
  return durableSleepSeconds(requestedMs) * MS_PER_SECOND;
}
