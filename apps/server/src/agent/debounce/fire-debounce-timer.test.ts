import { afterEach, describe, expect, it, vi } from "vitest";
import { debounceWaitMs } from "../../metrics.js";
import { fakeDurable } from "../../test/fake-durable.js";
import { fireDebounceTimer } from "./fire-debounce-timer.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fireDebounceTimer", () => {
  it.each(["idle" as const, "maxwait" as const])(
    "sleeps, then emits inbound/ready, then records the %s wait",
    async (kind) => {
      const record = vi.spyOn(debounceWaitMs, "record");
      const step = fakeDurable();

      await fireDebounceTimer(step, {
        kind,
        conversationId: "conv-1",
        inboundMessageId: "inbound-1",
        timeoutMs: 3000,
      });

      expect(step.planned()).toEqual([
        { kind: "sleep", id: "wait", duration: "3000ms" },
        {
          kind: "sendEvent",
          id: "fire",
          events: [
            expect.objectContaining({
              name: "inbound/ready",
              data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
            }),
          ],
        },
        { kind: "run", id: "record-wait" },
      ]);
      expect(record).toHaveBeenCalledExactlyOnceWith(3000, { kind });
    },
  );

  it("sleeps and records the quantised wait, not the requested one", async () => {
    const record = vi.spyOn(debounceWaitMs, "record");
    const step = fakeDurable();

    await fireDebounceTimer(step, {
      kind: "idle",
      conversationId: "conv-1",
      inboundMessageId: "inbound-1",
      timeoutMs: 2500,
    });

    expect(step.planned()[0]).toEqual({ kind: "sleep", id: "wait", duration: "2000ms" });
    expect(record).toHaveBeenCalledExactlyOnceWith(2000, { kind: "idle" });
  });
});
