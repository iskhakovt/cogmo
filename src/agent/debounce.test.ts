import { describe, expect, it, vi } from "vitest";
import { createDebounceFunctions } from "./debounce.js";

describe("debounce-router", () => {
  const baseEvent = {
    data: { conversationId: "conv-1", inboundMessageId: "inbound-1" },
  };

  it("emits debounce/idle and debounce/maxwait when both configured", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });

    const step = { sendEvent: vi.fn(), run: vi.fn((_, fn) => fn()) };
    await (router as any).fn({ event: baseEvent, step });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "route",
      expect.arrayContaining([
        expect.objectContaining({ name: "debounce/idle" }),
        expect.objectContaining({ name: "debounce/maxwait" }),
      ]),
    );
    // Should NOT contain inbound/ready (debounce is active)
    const events = step.sendEvent.mock.calls[0][1];
    expect(events.every((e: any) => e.name !== "inbound/ready")).toBe(true);
  });

  it("emits inbound/ready directly when both timeouts are 0", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 0,
      maxWaitMs: 0,
      resumePolicy: "debounce",
    });

    const step = { sendEvent: vi.fn(), run: vi.fn((_, fn) => fn()) };
    await (router as any).fn({ event: baseEvent, step });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "route",
      expect.arrayContaining([expect.objectContaining({ name: "inbound/ready" })]),
    );
  });

  it("emits only debounce/idle when maxwait is 0", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 3000,
      maxWaitMs: 0,
      resumePolicy: "debounce",
    });

    const step = { sendEvent: vi.fn(), run: vi.fn((_, fn) => fn()) };
    await (router as any).fn({ event: baseEvent, step });

    const events = step.sendEvent.mock.calls[0][1];
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("debounce/idle");
  });

  it("emits only debounce/maxwait when idle is 0", async () => {
    const [router] = createDebounceFunctions({
      idleTimeoutMs: 0,
      maxWaitMs: 30000,
      resumePolicy: "debounce",
    });

    const step = { sendEvent: vi.fn(), run: vi.fn((_, fn) => fn()) };
    await (router as any).fn({ event: baseEvent, step });

    const events = step.sendEvent.mock.calls[0][1];
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("debounce/maxwait");
  });
});
