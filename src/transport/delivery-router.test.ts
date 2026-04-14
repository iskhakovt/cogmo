import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../llm/types.js";
import {
  mockAdapter,
  mockStreamHandle,
  mockStreamingAdapter,
  mockTransportStore,
} from "../test/factories.js";
import { createDeliveryRouter, type RoutingContext } from "./delivery-router.js";

const textDelta: StreamEvent = { type: "text_delta", text: "hello" };

function session(id: string, channelId: string, receive = "routed") {
  return {
    id,
    channelId,
    platformAddress: `addr-${id}`,
    conversationId: "conv-1",
    status: "active",
    receive,
  };
}

function ctx(overrides?: Partial<RoutingContext>): RoutingContext {
  return {
    conversationId: "conv-1",
    runId: "run-1",
    isPrivate: true,
    maxInboundId: "inb-1",
    prevCursor: null,
    ...overrides,
  };
}

describe("createDeliveryRouter", () => {
  it("fans out push/finish to streaming adapters", async () => {
    const handle = mockStreamHandle();
    const streaming = mockStreamingAdapter({ openStream: vi.fn().mockResolvedValue(handle) });
    const adapters = new Map([["ch-1", { adapter: streaming }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    await delivery.push(textDelta);
    await delivery.finish();

    expect(handle.push).toHaveBeenCalledWith(textDelta);
    expect(handle.finish).toHaveBeenCalled();
  });

  it("delivers batch to non-streaming adapters", async () => {
    const batch = mockAdapter();
    const adapters = new Map([["ch-1", { adapter: batch }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    await delivery.deliverBatch("full response");

    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", "full response");
  });

  it("partitions mixed adapters correctly", async () => {
    const handle = mockStreamHandle();
    const streaming = mockStreamingAdapter({ openStream: vi.fn().mockResolvedValue(handle) });
    const batch = mockAdapter();
    const adapters = new Map<string, any>([
      ["ch-stream", { adapter: streaming }],
      ["ch-batch", { adapter: batch }],
    ]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi
        .fn()
        .mockResolvedValue([session("s1", "ch-stream"), session("s2", "ch-batch")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

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
    const transportStore = mockTransportStore();

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

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
      ["ch-1", { adapter: s1 }],
      ["ch-2", { adapter: s2 }],
    ]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1"), session("s2", "ch-2")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    await delivery.abort("LLM failed");

    expect(handle1.abort).toHaveBeenCalledWith("LLM failed");
    expect(handle2.abort).toHaveBeenCalledWith("LLM failed");
  });

  it("passes runId to openStream for retry dedup", async () => {
    const streaming = mockStreamingAdapter();
    const adapters = new Map([["ch-1", { adapter: streaming }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    await router.prepare(ctx({ runId: "run-abc" }));

    expect(streaming.openStream).toHaveBeenCalledWith("addr-s1", "run-abc");
  });

  it("skips sessions with unknown channel adapter", async () => {
    const adapters = new Map(); // empty — no adapters registered
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-unknown")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    // No errors, just no-ops
    await delivery.push(textDelta);
    await delivery.finish();
    await delivery.deliverBatch("content");
  });

  it("passes routing params to getSourceSessions", async () => {
    const transportStore = mockTransportStore();
    const router = createDeliveryRouter({ adapters: new Map(), transportStore });

    await router.prepare(ctx({ maxInboundId: "inb-5", prevCursor: "inb-2" }));

    expect(transportStore.getSourceSessions).toHaveBeenCalledWith({
      conversationId: "conv-1",
      prevCursor: "inb-2",
      maxInboundId: "inb-5",
    });
  });

  it("merges source + receive-all sessions for private conversations", async () => {
    const handle = mockStreamHandle();
    const streaming = mockStreamingAdapter({ openStream: vi.fn().mockResolvedValue(handle) });
    const batch = mockAdapter();
    const adapters = new Map<string, any>([
      ["ch-stream", { adapter: streaming }],
      ["ch-batch", { adapter: batch }],
    ]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-stream")]),
      getReceiveAllSessions: vi.fn().mockResolvedValue([session("s2", "ch-batch", "all")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx({ isPrivate: true }));

    await delivery.push(textDelta);
    await delivery.deliverBatch("response");

    expect(handle.push).toHaveBeenCalledWith(textDelta);
    expect(batch.deliver).toHaveBeenCalledWith("addr-s2", "response");
  });

  it("skips receive-all for non-private conversations", async () => {
    const batch = mockAdapter();
    const adapters = new Map<string, any>([
      ["ch-source", { adapter: batch }],
      ["ch-webui", { adapter: mockAdapter() }],
    ]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-source")]),
      getReceiveAllSessions: vi.fn().mockResolvedValue([session("s2", "ch-webui", "all")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx({ isPrivate: false }));

    await delivery.deliverBatch("response");

    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", "response");
    // getReceiveAllSessions should not even be called
    expect(transportStore.getReceiveAllSessions).not.toHaveBeenCalled();
  });

  it("deduplicates when a session appears in both source and receive-all", async () => {
    const batch = mockAdapter();
    const adapters = new Map<string, any>([["ch-1", { adapter: batch }]]);
    // Same session ID in both lists
    const shared = session("s1", "ch-1", "all");
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([shared]),
      getReceiveAllSessions: vi.fn().mockResolvedValue([shared]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx({ isPrivate: true }));

    await delivery.deliverBatch("response");

    // Should deliver once, not twice
    expect(batch.deliver).toHaveBeenCalledTimes(1);
  });
});
