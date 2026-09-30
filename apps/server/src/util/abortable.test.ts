import { describe, expect, it } from "vitest";
import { abortable } from "./abortable.js";

describe("abortable", () => {
  it("settles with the work when the signal doesn't abort", async () => {
    const { signal } = new AbortController();

    await expect(abortable(Promise.resolve(7), signal)).resolves.toBe(7);
    await expect(abortable(Promise.reject(new Error("work failed")), signal)).rejects.toThrow(
      "work failed",
    );
  });

  it("rejects with the reason once the signal aborts, dropping the work's later outcome", async () => {
    const controller = new AbortController();
    const work = Promise.withResolvers<number>();
    const reason = new Error("deadline");

    const settled = abortable(work.promise, controller.signal);
    controller.abort(reason);

    await expect(settled).rejects.toBe(reason);
    work.reject(new Error("late failure"));
  });

  it("rejects at once for a signal that has already aborted", async () => {
    const reason = new Error("deadline");
    const work = Promise.withResolvers<number>();

    await expect(abortable(work.promise, AbortSignal.abort(reason))).rejects.toBe(reason);
    work.reject(new Error("late failure"));
  });
});
