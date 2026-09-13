/**
 * Readable text for a thrown value.
 *
 * Node's `fetch` reports a network failure as `TypeError("fetch failed")` and
 * keeps the actual reason — ECONNREFUSED, ENOTFOUND, a TLS error — in
 * `cause`, so the cause's message (or its code, when the message is empty, as
 * with an `AggregateError`) is appended.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (!(cause instanceof Error)) return err.message;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const detail = cause.message !== "" ? cause.message : code;
  return detail === undefined ? err.message : `${err.message} (${detail})`;
}
