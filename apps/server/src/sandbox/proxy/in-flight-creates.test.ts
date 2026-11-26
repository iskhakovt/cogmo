import { afterEach, describe, expect, it, vi } from "vitest";
import { expectOk } from "../../test/assertions.js";
import { InFlightCreates } from "./in-flight-creates.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Admit a create on `creates` and run `work` under it. */
function runAdmitted(creates: InFlightCreates, work: Promise<void>): Promise<void> {
  return expectOk(creates.admit()).run(() => work);
}

/** Whether `promise` has settled once timers and microtasks up to `ms` have run. */
async function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

describe("InFlightCreates", () => {
  it("is settled at once with no create admitted", async () => {
    vi.useFakeTimers();

    expect(await settledWithin(new InFlightCreates().settled(30_000), 0)).toBe(true);
  });

  it("counts a create from its admission until its work settles", async () => {
    const creates = new InFlightCreates();
    const work = Promise.withResolvers<void>();
    const admission = expectOk(creates.admit());
    expect(creates.admittedBeyond(new Set())).toBe(1);

    const ran = admission.run(() => work.promise);
    work.resolve();
    await ran;

    expect(creates.admittedBeyond(new Set())).toBe(0);
  });

  it("stops counting a create once its named child is among the rows counted", () => {
    const creates = new InFlightCreates();
    const named = expectOk(creates.admit());
    expectOk(creates.admit());

    named.named("child-a");

    expect(creates.admittedBeyond(new Set())).toBe(2);
    expect(creates.admittedBeyond(new Set(["child-a"]))).toBe(1);
    expect(creates.admittedBeyond(new Set(["child-b"]))).toBe(2);
  });

  it("ends an admission whose work rejects, and passes the rejection on", async () => {
    const creates = new InFlightCreates();

    await expect(
      expectOk(creates.admit()).run(async () => {
        throw new Error("a bug in the forward");
      }),
    ).rejects.toThrow("a bug in the forward");
    expect(creates.admittedBeyond(new Set())).toBe(0);
  });

  it("is settled once every create admitted has settled", async () => {
    vi.useFakeTimers();
    const creates = new InFlightCreates();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    void runAdmitted(creates, first.promise);
    void runAdmitted(creates, second.promise);
    const settled = creates.settled(30_000);

    first.resolve();
    expect(await settledWithin(settled, 0)).toBe(false);
    second.resolve();

    expect(await settledWithin(settled, 0)).toBe(true);
  });

  it("waits for an admission whose work has not started yet", async () => {
    vi.useFakeTimers();
    const creates = new InFlightCreates();
    expectOk(creates.admit());

    expect(await settledWithin(creates.settled(30_000), 29_999)).toBe(false);
  });

  it("stops waiting for a create still in flight after the given time", async () => {
    vi.useFakeTimers();
    const creates = new InFlightCreates();
    void runAdmitted(creates, new Promise<void>(() => {}));
    const settled = creates.settled(30_000);

    expect(await settledWithin(settled, 29_999)).toBe(false);
    expect(await settledWithin(settled, 1)).toBe(true);
  });

  it("stops waiting once the creates are aborted", async () => {
    vi.useFakeTimers();
    const creates = new InFlightCreates();
    void runAdmitted(creates, new Promise<void>(() => {}));
    const settled = creates.settled(30_000);
    expect(await settledWithin(settled, 0)).toBe(false);

    creates.abort(new Error("proxy is closed"));

    expect(await settledWithin(settled, 0)).toBe(true);
  });

  it("admits nothing once teardown has begun", () => {
    const creates = new InFlightCreates();

    creates.stopAdmitting();

    const admitted = creates.admit();
    expect(admitted.isErr() && admitted.error.kind).toBe("unavailable");
    expect(creates.admittedBeyond(new Set())).toBe(0);
  });

  it("aborts its signal with the reason given", () => {
    const creates = new InFlightCreates();
    const reason = new Error("task socket unregistered");

    creates.abort(reason);

    expect(creates.signal.aborted).toBe(true);
    expect(creates.signal.reason).toBe(reason);
  });
});
