import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { abortable, abortReasonOr } from "./abort.js";

describe("abortable", () => {
  it("settles with the call when there is no signal", async () => {
    await expect(abortable(Promise.resolve("ok"), undefined)).resolves.toBe("ok");
  });

  it("settles with the call when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve("ok"), controller.signal)).resolves.toBe("ok");
    await expect(abortable(Promise.reject(new Error("boom")), controller.signal)).rejects.toThrow(
      "boom",
    );
  });

  it("rejects with the reason as soon as the signal fires, without waiting for the call", async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise(() => {}), controller.signal);
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("rejects with the reason of a signal that fired before the call", async () => {
    const reason = new Error("cancelled");
    await expect(abortable(Promise.resolve("ok"), AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  it("handles the call's rejection once the abort has won", async () => {
    // The SDK rejects its own promise after the abort; nothing awaits it any more.
    const controller = new AbortController();
    const { promise, reject } = Promise.withResolvers<never>();
    const pending = abortable(promise, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      reject(new Error("request aborted"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("removes its abort listener once settled", async () => {
    const controller = new AbortController();
    await abortable(Promise.resolve("ok"), controller.signal);
    await abortable(Promise.reject(new Error("boom")), controller.signal).catch(() => {});
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });
});

describe("abortReasonOr", () => {
  it("passes the error through while the signal has not fired", () => {
    const err = new Error("boom");
    expect(abortReasonOr(err, undefined)).toBe(err);
    expect(abortReasonOr(err, new AbortController().signal)).toBe(err);
  });

  it("substitutes the reason once the signal has fired", () => {
    const reason = new Error("cancelled");
    expect(abortReasonOr(new Error("APIUserAbortError"), AbortSignal.abort(reason))).toBe(reason);
  });
});
