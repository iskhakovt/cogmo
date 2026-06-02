// biome-ignore-all lint/correctness/useExhaustiveDependencies: useResource takes a caller-controlled deps list; the fetcher is re-created each render by design.
import { type DependencyList, useEffect, useState } from "react";

/** A one-shot async read: loading, a friendly error message, or the data. */
export type ResourceState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

/**
 * Run `fetcher` on mount (and when `deps` change), tracking loading/error/ready.
 * oRPC throws its `TRANSPORT_ERROR` (carrying the `TransportError` union as
 * `data`) on a failed `Result`; `errorMessage` surfaces the `code`.
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: DependencyList): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetcher().then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

/** Extract a display message: the transport `code` when present, else the error text. */
export function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    if (
      "data" in err &&
      typeof err.data === "object" &&
      err.data !== null &&
      "code" in err.data &&
      typeof err.data.code === "string"
    ) {
      return err.data.code;
    }
    if ("message" in err && typeof err.message === "string") return err.message;
  }
  return "Request failed.";
}
