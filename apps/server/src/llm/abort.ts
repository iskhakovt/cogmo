/**
 * What an aborted call throws: `signal.reason`, in place of whatever the
 * SDK threw. Both SDKs reject an aborted request with their own
 * `APIUserAbortError`; `ChatOptions.signal` promises the caller's reason.
 */
export function abortReasonOr(err: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted ? signal.reason : err;
}
