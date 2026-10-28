import { afterEach, describe, expect, it, vi } from "vitest";
import { debounceWaitMs } from "../../metrics.js";
import { expectDefined } from "../../test/assertions.js";
import { fakeDurable } from "../../test/fake-durable.js";
import { emitNativeReady } from "./emit-native-ready.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const inbound = { conversationId: "conv-1", inboundMessageId: "inbound-1" };

describe("emitNativeReady", () => {
  it("emits one inbound/ready for the burst's last inbound, then records its age", async () => {
    const record = vi.spyOn(debounceWaitMs, "record");
    const step = fakeDurable();

    const result = await emitNativeReady(step, { ...inbound, triggeredAt: Date.now() - 2500 });

    expect(result).toEqual({ mode: "native", triggerInboundId: "inbound-1" });
    expect(step.planned()).toEqual([
      {
        kind: "sendEvent",
        id: "ready",
        events: [
          expect.objectContaining({
            name: "inbound/ready",
            data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
          }),
        ],
      },
      { kind: "run", id: "record-wait" },
    ]);
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.any(Number), { kind: "native" });
    const [recordedMs] = expectDefined(record.mock.calls[0], "record call");
    expect(recordedMs).toBeGreaterThanOrEqual(2500);
  });

  it("plans no record step when the trigger event carries no timestamp", async () => {
    const record = vi.spyOn(debounceWaitMs, "record");
    const step = fakeDurable();

    await emitNativeReady(step, { ...inbound, triggeredAt: undefined });

    expect(step.stepIds()).toEqual(["ready"]);
    expect(record).not.toHaveBeenCalled();
  });
});
