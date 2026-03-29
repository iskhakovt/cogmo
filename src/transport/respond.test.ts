import { describe, expect, it, vi } from "vitest";
import { mockAgentStore, mockStep, mockTransportStore } from "../test/factories.js";
import { createRespond } from "./respond.js";

const activeSession = {
  id: "session-1",
  channelId: "ch-1",
  platformAddress: "addr-1",
  conversationId: "conv-1",
  status: "active",
  receive: "routed",
};

describe("createRespond", () => {
  it("delivers message to active sessions for the channel", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const agentStore = mockAgentStore({
      getMessage: vi.fn().mockResolvedValue({ id: "msg-1", role: "assistant", content: "hello" }),
    });
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([activeSession]),
    });

    const fn = createRespond({
      id: "test-respond",
      channelId: "ch-1",
      agentStore,
      transportStore,
      deliver,
    });

    await (fn as any).fn({
      event: { data: { conversationId: "conv-1", messageId: "msg-1" } },
      step: mockStep(),
    });

    expect(deliver).toHaveBeenCalledWith("addr-1", "hello");
  });

  it("skips delivery when message not found", async () => {
    const deliver = vi.fn();
    const fn = createRespond({
      id: "test-respond",
      channelId: "ch-1",
      agentStore: mockAgentStore({ getMessage: vi.fn().mockResolvedValue(null) }),
      transportStore: mockTransportStore(),
      deliver,
    });

    await (fn as any).fn({
      event: { data: { conversationId: "conv-1", messageId: "msg-1" } },
      step: mockStep(),
    });

    expect(deliver).not.toHaveBeenCalled();
  });

  it("skips delivery when no sessions match the channel", async () => {
    const deliver = vi.fn();
    const otherChannelSession = { ...activeSession, channelId: "other-ch" };
    const fn = createRespond({
      id: "test-respond",
      channelId: "ch-1",
      agentStore: mockAgentStore(),
      transportStore: mockTransportStore({
        getActiveSessionsForConversation: vi.fn().mockResolvedValue([otherChannelSession]),
      }),
      deliver,
    });

    await (fn as any).fn({
      event: { data: { conversationId: "conv-1", messageId: "msg-1" } },
      step: mockStep(),
    });

    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers to multiple sessions", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const session2 = { ...activeSession, id: "session-2", platformAddress: "addr-2" };
    const fn = createRespond({
      id: "test-respond",
      channelId: "ch-1",
      agentStore: mockAgentStore(),
      transportStore: mockTransportStore({
        getActiveSessionsForConversation: vi.fn().mockResolvedValue([activeSession, session2]),
      }),
      deliver,
    });

    await (fn as any).fn({
      event: { data: { conversationId: "conv-1", messageId: "msg-1" } },
      step: mockStep(),
    });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith("addr-1", "test");
    expect(deliver).toHaveBeenCalledWith("addr-2", "test");
  });

  it("JSON-stringifies non-string content", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fn = createRespond({
      id: "test-respond",
      channelId: "ch-1",
      agentStore: mockAgentStore({
        getMessage: vi
          .fn()
          .mockResolvedValue({ id: "msg-1", role: "assistant", content: { key: "val" } }),
      }),
      transportStore: mockTransportStore({
        getActiveSessionsForConversation: vi.fn().mockResolvedValue([activeSession]),
      }),
      deliver,
    });

    await (fn as any).fn({
      event: { data: { conversationId: "conv-1", messageId: "msg-1" } },
      step: mockStep(),
    });

    expect(deliver).toHaveBeenCalledWith("addr-1", '{"key":"val"}');
  });
});
