/**
 * Readable text for a thrown value, never empty for an `Error`.
 *
 * Node's `fetch` reports a network failure as `TypeError("fetch failed")` and
 * keeps the actual reason — ECONNREFUSED, ENOTFOUND, a TLS error — in
 * `cause`, so the cause's description is appended. A connection refused on
 * every address of a dual-stack host surfaces as an `AggregateError` with an
 * empty message, sometimes thrown directly (the AWS SDK does), so an empty
 * message falls back to the first inner error's message, then the error
 * code, then the error's name.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const own = ownDescription(err);
  const cause = err.cause instanceof Error ? ownDescription(err.cause) : "";
  if (own === "") return cause !== "" ? cause : err.name;
  return cause === "" ? own : `${own} (${cause})`;
}

function ownDescription(err: Error): string {
  if (err.message !== "") return err.message;
  if (err instanceof AggregateError) {
    const inner = err.errors.find(
      (candidate): candidate is Error => candidate instanceof Error && candidate.message !== "",
    );
    if (inner !== undefined) return inner.message;
  }
  if ("code" in err && typeof err.code === "string") return err.code;
  return "";
}
