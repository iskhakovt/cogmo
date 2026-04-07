import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../llm/types.js";
import {
  mockAdapter,
  mockStreamHandle,
  mockStreamingAdapter,
  mockTransportStore,
} from "../test/factories.js";
import { createDeliveryRouter } from "./delivery-router.js";

const textDelta: StreamEvent = { type: "text_delta", text: "hello" };

function session(id: string, channelId: string) {
  return {
    id,
    channelId,
    platformAddress: `addr-${id}`,
    conversationId: "conv-1",
    status: "active",
    receive: "routed",
  };
}

describe("createDeliveryRouter", () => {
  it("fans out push/finish to streaming adapters", async () => {
    const handle = mockStreamHandle();
    const streaming = mockStreamingAdapter({ openStream: vi.fn().mockResolvedValue(handle) });
    const adapters = new Map([["ch-1", streaming]]);
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare("conv-1", "run-1");

    await delivery.push(textDelta);
    await delivery.finish();

    expect(handle.push).toHaveBeenCalledWith(textDelta);
    expect(handle.finish).toHaveBeenCalled();
  });

  it("delivers batch to non-streaming adapters", async () => {
    const batch = mockAdapter();
    const adapters = new Map([["ch-1", batch]]);
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare("conv-1", "run-1");

    await delivery.deliverBatch("full response");

    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", "full response");
  });

  it("partitions mixed adapters correctly", async () => {
    const handle = mockStreamHandle();
    const streaming = mockStreamingAdapter({ openStream: vi.fn().mockResolvedValue(handle) });
    const batch = mockAdapter();
    const adapters = new Map<string, any>([
      ["ch-stream", streaming],
      ["ch-batch", batch],
    ]);
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi
        .fn()
        .mockResolvedValue([session("s1", "ch-stream"), session("s2", "ch-batch")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare("conv-1", "run-1");

    await delivery.push(textDelta);
    await delivery.deliverBatch("full response");

    // Streaming adapter got push, not deliver
    expect(handle.push).toHaveBeenCalledWith(textDelta);
    expect(streaming.stop).not.toHaveBeenCalled();

    // Batch adapter got deliver, not push
    expect(batch.deliver).toHaveBeenCalledWith("addr-s2", "full response");
  });

  it("handles no sessions gracefully", async () => {
    const adapters = new Map();
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare("conv-1", "run-1");

    // All methods are no-ops
    await delivery.push(textDelta);
    await delivery.finish();
    await delivery.abort("error");
    await delivery.deliverBatch("content");
  });

  it("calls abort on all stream handles on error", async () => {
    const handle1 = mockStreamHandle();
    const handle2 = mockStreamHandle();
    const s1 = mockStreamingAdapter({ openStream: vi.fn().mockResolvedValue(handle1) });
    const s2 = mockStreamingAdapter({ openStream: vi.fn().mockResolvedValue(handle2) });
    const adapters = new Map<string, any>([
      ["ch-1", s1],
      ["ch-2", s2],
    ]);
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi
        .fn()
        .mockResolvedValue([session("s1", "ch-1"), session("s2", "ch-2")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare("conv-1", "run-1");

    await delivery.abort("LLM failed");

    expect(handle1.abort).toHaveBeenCalledWith("LLM failed");
    expect(handle2.abort).toHaveBeenCalledWith("LLM failed");
  });

  it("passes runId to openStream for retry dedup", async () => {
    const streaming = mockStreamingAdapter();
    const adapters = new Map([["ch-1", streaming]]);
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    await router.prepare("conv-1", "run-abc");

    expect(streaming.openStream).toHaveBeenCalledWith("addr-s1", "run-abc");
  });

  it("skips sessions with unknown channel adapter", async () => {
    const adapters = new Map(); // empty — no adapters registered
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([session("s1", "ch-unknown")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare("conv-1", "run-1");

    // No errors, just no-ops
    await delivery.push(textDelta);
    await delivery.finish();
    await delivery.deliverBatch("content");
  });
});
