/**
 * What the SDK adapters add to the SDKs' own abort handling to meet
 * `ChatOptions.signal`. Both SDKs abort the request when the signal fires,
 * but they throw their own error for it, end a stream quietly as if it had
 * finished, and sleep through a retry's backoff before noticing the signal.
 */

/**
 * `call`, settled with `signal.reason` as soon as `signal` fires. The SDK
 * checks the signal again before its next attempt, so no request follows
 * the abort; this only stops the caller waiting out the backoff, which a
 * `retry-after` header can stretch to a minute or more.
 */
export async function abortable<T>(call: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return call;
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    // The race subscribes to `call`, so its rejection after an abort is handled.
    return await Promise.race([aborted.promise, call]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** What an aborted call throws: `signal.reason`, in place of whatever the SDK threw. */
export function abortReasonOr(err: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted ? signal.reason : err;
}
