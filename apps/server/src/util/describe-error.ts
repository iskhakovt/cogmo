/**
 * Readable, non-empty text for a thrown `Error`: its message, else an
 * `AggregateError`'s first inner message, its code or its name, with the
 * `cause` appended — undici's `fetch failed` keeps the network reason there.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const own = ownDescription(err);
  const cause = err.cause instanceof Error ? ownDescription(err.cause) : "";
  if (own === "") return cause !== "" ? cause : err.name || "Error";
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
