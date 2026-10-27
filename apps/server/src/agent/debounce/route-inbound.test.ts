import { describe, expect, it } from "vitest";
import { fakeDurable } from "../../test/fake-durable.js";
import { routeInbound } from "./route-inbound.js";

const inbound = { conversationId: "conv-1", inboundMessageId: "inbound-1" };

/** The event names and payloads `routeInbound` emitted under its one `route` step. */
async function route(timing: { idleTimeoutMs: number; maxWaitMs: number }) {
  const step = fakeDurable();
  const result = await routeInbound(step, { ...inbound, ...timing });
  return { result, planned: step.planned() };
}

describe("routeInbound", () => {
  it("starts both timers in one route step when both are configured", async () => {
    const { result, planned } = await route({ idleTimeoutMs: 500, maxWaitMs: 5000 });

    expect(planned).toEqual([
      {
        kind: "sendEvent",
        id: "route",
        events: [
          expect.objectContaining({
            name: "debounce/idle",
            data: { ...inbound, timeoutMs: 500 },
          }),
          expect.objectContaining({
            name: "debounce/maxwait",
            data: { ...inbound, timeoutMs: 5000 },
          }),
        ],
      },
    ]);
    expect(result).toEqual({ mode: "legacy", emitted: ["debounce/idle", "debounce/maxwait"] });
  });

  it("starts only the maxwait timer when idle is 0", async () => {
    const { result } = await route({ idleTimeoutMs: 0, maxWaitMs: 30000 });
    expect(result.emitted).toEqual(["debounce/maxwait"]);
  });

  it("starts only the idle timer when maxwait is 0", async () => {
    const { result } = await route({ idleTimeoutMs: 500, maxWaitMs: 0 });
    expect(result.emitted).toEqual(["debounce/idle"]);
  });

  it("emits inbound/ready at once when neither timer is configured", async () => {
    const { result, planned } = await route({ idleTimeoutMs: 0, maxWaitMs: 0 });

    expect(planned).toEqual([
      {
        kind: "sendEvent",
        id: "route",
        events: [
          expect.objectContaining({
            name: "inbound/ready",
            data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
          }),
        ],
      },
    ]);
    expect(result).toEqual({ mode: "legacy", emitted: ["inbound/ready"] });
  });
});
