/**
 * Settle with `work`, or reject with `signal`'s reason once it aborts,
 * whichever comes first. For calls that take no signal, or honour it only
 * partly: the abandoned call keeps running, and its outcome is dropped.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolveWork, rejectWork) => {
    const onAbort = () => rejectWork(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveWork(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectWork(err);
      },
    );
  });
}
