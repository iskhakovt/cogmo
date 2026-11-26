import { afterEach, describe, expect, it, vi } from "vitest";
import { InFlightCreates } from "./in-flight-creates.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("InFlightCreates", () => {
  it("is settled at once with no create in flight", async () => {
    vi.useFakeTimers();
    let settled = false;
    void new InFlightCreates().settled(30_000).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
  });

  it("is settled once every create tracked has settled", async () => {
    vi.useFakeTimers();
    const creates = new InFlightCreates();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    creates.track(first.promise);
    creates.track(second.promise);
    let settled = false;
    void creates.settled(30_000).then(() => {
      settled = true;
    });

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
  });

  it("stops waiting for a create still in flight after the given time", async () => {
    vi.useFakeTimers();
    const creates = new InFlightCreates();
    creates.track(new Promise<void>(() => {}));
    let settled = false;
    void creates.settled(30_000).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
  });

  it("forgets a settled create, so a later wait has nothing to wait for", async () => {
    vi.useFakeTimers();
    const creates = new InFlightCreates();
    creates.track(Promise.resolve());
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void creates.settled(30_000).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
  });

  it("aborts its signal with the reason given", () => {
    const creates = new InFlightCreates();
    const reason = new Error("task socket unregistered");

    creates.abort(reason);

    expect(creates.signal.aborted).toBe(true);
    expect(creates.signal.reason).toBe(reason);
  });
});
