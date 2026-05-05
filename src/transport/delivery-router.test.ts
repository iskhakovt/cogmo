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

  it("calls renderOutput before deliver when present", async () => {
    const batch = mockAdapter();
    const renderOutput = vi.fn().mockReturnValue({ text: "<b>rendered</b>", parseMode: "HTML" });
    const adapters = new Map([["ch-1", { adapter: batch, renderOutput }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    await delivery.deliverBatch("**rendered**");

    expect(renderOutput).toHaveBeenCalledWith("**rendered**");
    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", {
      text: "<b>rendered</b>",
      parseMode: "HTML",
    });
  });

  it("passes raw markdown when renderOutput is not set", async () => {
    const batch = mockAdapter();
    const adapters = new Map([["ch-1", { adapter: batch }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    await delivery.deliverBatch("plain markdown");

    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", "plain markdown");
  });

  it("hasBatchTargets() returns false when all sessions are streaming", async () => {
    const streaming = mockStreamingAdapter();
    const adapters = new Map([["ch-1", { adapter: streaming }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    expect(delivery.hasBatchTargets()).toBe(false);
  });

  it("hasBatchTargets() returns true when any session uses a batch adapter", async () => {
    const batch = mockAdapter();
    const streaming = mockStreamingAdapter();
    const adapters = new Map<string, any>([
      ["ch-1", { adapter: streaming }],
      ["ch-2", { adapter: batch }],
    ]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1"), session("s2", "ch-2")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    expect(delivery.hasBatchTargets()).toBe(true);
  });

  it("hasBatchTargets() returns false when there are no sessions at all", async () => {
    const transportStore = mockTransportStore();
    const router = createDeliveryRouter({ adapters: new Map(), transportStore });
    const delivery = await router.prepare(ctx());

    expect(delivery.hasBatchTargets()).toBe(false);
  });

  it("forwards images to adapter when renderOutput is present", async () => {
    const batch = mockAdapter();
    const renderOutput = vi.fn().mockReturnValue({ text: "<b>text</b>", parseMode: "HTML" });
    const adapters = new Map([["ch-1", { adapter: batch, renderOutput }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    const images = [{ data: Buffer.from([1, 2]), mediaType: "image/png" }];
    await delivery.deliverBatch("text", images);

    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", {
      text: "<b>text</b>",
      parseMode: "HTML",
      images,
    });
  });

  it("wraps content in RenderedMessage when images present but no renderOutput", async () => {
    const batch = mockAdapter();
    const adapters = new Map([["ch-1", { adapter: batch }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    const images = [{ data: Buffer.from([1, 2]), mediaType: "image/png" }];
    await delivery.deliverBatch("plain text", images);

    // No renderOutput → normally raw string, but images require a RenderedMessage wrapper
    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", {
      text: "plain text",
      images,
    });
  });

  it("still passes raw string when no images and no renderOutput", async () => {
    const batch = mockAdapter();
    const adapters = new Map([["ch-1", { adapter: batch }]]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    await delivery.deliverBatch("plain text");

    expect(batch.deliver).toHaveBeenCalledWith("addr-s1", "plain text");
  });

  // notifyConversation — used by handle-message's onFailure handler. Reaches
  // every active session on the conversation regardless of source-routing,
  // since failure notification has no inbound cursor to anchor against.
  describe("notifyConversation", () => {
    it("delivers to every active session on the conversation", async () => {
      const batch1 = mockAdapter();
      const batch2 = mockAdapter();
      const adapters = new Map<string, any>([
        ["ch-1", { adapter: batch1 }],
        ["ch-2", { adapter: batch2 }],
      ]);
      const transportStore = mockTransportStore({
        getActiveSessionsForConversation: vi
          .fn()
          .mockResolvedValue([session("s1", "ch-1"), session("s2", "ch-2")]),
      });

      const router = createDeliveryRouter({ adapters, transportStore });
      await router.notifyConversation("conv-1", "we hit an error");

      expect(batch1.deliver).toHaveBeenCalledWith("addr-s1", "we hit an error");
      expect(batch2.deliver).toHaveBeenCalledWith("addr-s2", "we hit an error");
    });

    it("passes the text through renderOutput when present", async () => {
      const batch = mockAdapter();
      const renderOutput = vi.fn().mockReturnValue({ text: "<b>err</b>", parseMode: "HTML" });
      const adapters = new Map([["ch-1", { adapter: batch, renderOutput }]]);
      const transportStore = mockTransportStore({
        getActiveSessionsForConversation: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
      });

      const router = createDeliveryRouter({ adapters, transportStore });
      await router.notifyConversation("conv-1", "**err**");

      expect(renderOutput).toHaveBeenCalledWith("**err**");
      expect(batch.deliver).toHaveBeenCalledWith("addr-s1", {
        text: "<b>err</b>",
        parseMode: "HTML",
      });
    });

    it("skips pure StreamingAdapter sessions (no deliver method, no live stream)", async () => {
      const streamingOnly = mockStreamingAdapter();
      const adapters = new Map([["ch-1", { adapter: streamingOnly }]]);
      const transportStore = mockTransportStore({
        getActiveSessionsForConversation: vi.fn().mockResolvedValue([session("s1", "ch-1")]),
      });

      const router = createDeliveryRouter({ adapters, transportStore });
      // Should not throw — streaming-only adapters are skipped.
      await router.notifyConversation("conv-1", "we hit an error");
    });

    it("swallows per-adapter deliver errors so one bad session doesn't block the rest", async () => {
      const failing = mockAdapter({ deliver: vi.fn().mockRejectedValue(new Error("offline")) });
      const ok = mockAdapter();
      const adapters = new Map<string, any>([
        ["ch-fail", { adapter: failing }],
        ["ch-ok", { adapter: ok }],
      ]);
      const transportStore = mockTransportStore({
        getActiveSessionsForConversation: vi
          .fn()
          .mockResolvedValue([session("s1", "ch-fail"), session("s2", "ch-ok")]),
      });

      const router = createDeliveryRouter({ adapters, transportStore });
      await router.notifyConversation("conv-1", "we hit an error");

      expect(ok.deliver).toHaveBeenCalledWith("addr-s2", "we hit an error");
    });

    it("is a no-op when there are no active sessions", async () => {
      const transportStore = mockTransportStore({
        getActiveSessionsForConversation: vi.fn().mockResolvedValue([]),
      });
      const router = createDeliveryRouter({ adapters: new Map(), transportStore });
      await router.notifyConversation("conv-1", "we hit an error");
    });
  });

  it("renders per-adapter independently in multi-channel delivery", async () => {
    const telegramAdapter = mockAdapter();
    const directAdapter = mockAdapter();
    const renderHtml = vi.fn().mockReturnValue({ text: "<b>hi</b>", parseMode: "HTML" });
    const adapters = new Map<string, any>([
      ["ch-tg", { adapter: telegramAdapter, renderOutput: renderHtml }],
      ["ch-direct", { adapter: directAdapter }],
    ]);
    const transportStore = mockTransportStore({
      getSourceSessions: vi
        .fn()
        .mockResolvedValue([session("s1", "ch-tg"), session("s2", "ch-direct")]),
    });

    const router = createDeliveryRouter({ adapters, transportStore });
    const delivery = await router.prepare(ctx());

    await delivery.deliverBatch("**hi**");

    // Telegram gets rendered HTML
    expect(telegramAdapter.deliver).toHaveBeenCalledWith("addr-s1", {
      text: "<b>hi</b>",
      parseMode: "HTML",
    });
    // Direct gets raw markdown
    expect(directAdapter.deliver).toHaveBeenCalledWith("addr-s2", "**hi**");
  });
});
