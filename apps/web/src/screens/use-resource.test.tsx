import { describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { errorMessage, useResource } from "./use-resource.js";

describe("useResource", () => {
  it("starts loading, then resolves to ready with the data", async () => {
    // A deferred fetch so the loading state is observable before it settles.
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((r) => {
      resolve = r;
    });
    const { result } = await renderHook(() => useResource(() => pending, []));
    expect(result.current.status).toBe("loading");

    resolve("hi");
    await expect.poll(() => result.current.status).toBe("ready");
    const state = result.current;
    if (state.status !== "ready") throw new Error("expected ready");
    expect(state.data).toBe("hi");
  });

  it("resolves to an error carrying the transport code", async () => {
    const { result } = await renderHook(() =>
      useResource(() => Promise.reject({ data: { code: "forbidden" } }), []),
    );
    await expect.poll(() => result.current.status).toBe("error");
    const state = result.current;
    if (state.status !== "error") throw new Error("expected error");
    expect(state.message).toBe("forbidden");
  });

  it("re-runs the fetcher when deps change", async () => {
    const fetcher = vi.fn((n: number) => Promise.resolve(`v${n}`));
    const { result, rerender } = await renderHook(
      ({ dep }: { dep: number } = { dep: 1 }) => useResource(() => fetcher(dep), [dep]),
      { initialProps: { dep: 1 } },
    );
    await expect
      .poll(() => result.current.status === "ready" && result.current.data === "v1")
      .toBe(true);

    await rerender({ dep: 2 });
    await expect
      .poll(() => result.current.status === "ready" && result.current.data === "v2")
      .toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("errorMessage", () => {
  it("returns the bare code when no context fields ride along", () => {
    expect(errorMessage({ data: { code: "not_found" } })).toBe("not_found");
  });

  it("appends contextual fields after the code", () => {
    const message = errorMessage({
      data: { code: "mcp_connection_failed", serverId: "srv", reason: "timeout" },
    });
    expect(message).toBe("mcp_connection_failed (serverId: srv, reason: timeout)");
  });

  it("falls back to a plain message when there is no transport code", () => {
    expect(errorMessage({ message: "boom" })).toBe("boom");
  });

  it("returns a generic message for an opaque error", () => {
    expect(errorMessage("nope")).toBe("Request failed.");
  });
});
