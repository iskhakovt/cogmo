import { describe, expect, it, vi } from "vitest";
import type { inboundArrived } from "../inngest/events.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import { createTransport } from "./transport.js";

function setup(overrides?: {
  transportStore?: ReturnType<typeof mockTransportStore>;
  agentStore?: ReturnType<typeof mockAgentStore>;
  idleTimeoutMs?: number;
}) {
  const transportStore = overrides?.transportStore ?? mockTransportStore();
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const inngestSend = vi.fn().mockResolvedValue(undefined);
  const inngest = { send: inngestSend } as any;
  const mockEvent = {
    create: vi.fn((data: any) => ({ name: "inbound/arrived", data })),
  } as unknown as typeof inboundArrived;

  const transport = createTransport({
    channelId: "ch-1",
    defaultUserId: "user-1",
    defaultProfileId: "profile-1",
    transportStore,
    agentStore,
    inngest,
    inboundArrived: mockEvent,
    attachments: { upload: vi.fn(), download: vi.fn() } as any,
    idleTimeoutMs: overrides?.idleTimeoutMs ?? 0,
  });

  return { transport, transportStore, agentStore, inngestSend, mockEvent };
}

describe("createTransport", () => {
  describe("resolveSession", () => {
    it("delegates to transportStore with scoped channelId", async () => {
      const { transport, transportStore } = setup();
      await transport.resolveSession("addr-1");
      expect(transportStore.resolveSession).toHaveBeenCalledWith("ch-1", "addr-1");
    });
  });

  describe("createConversation", () => {
    it("creates conversation via agentStore and session via transportStore", async () => {
      const { transport, agentStore, transportStore } = setup();

      const session = await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

      expect(agentStore.createConversation).toHaveBeenCalledWith({
        userId: "user-1",
        profileId: "profile-1",
        isPrivate: true,
      });
      expect(transportStore.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "ch-1",
          platformAddress: "addr-1",
          status: "active",
          receive: "routed",
        }),
      );
      expect(session.isOk()).toBe(true);
      if (session.isOk()) {
        expect(session.value.platformAddress).toBe("addr-1");
        expect(session.value.channelId).toBe("ch-1");
      }
    });
  });

  describe("closeSession", () => {
    it("delegates to transportStore", async () => {
      const { transport, transportStore } = setup();
      await transport.closeSession("session-1");
      expect(transportStore.closeSession).toHaveBeenCalledWith("session-1");
    });
  });

  describe("emit", () => {
    it("persists inbound and sends inngest event", async () => {
      const ts = mockTransportStore({
        getSession: vi.fn().mockResolvedValue({
          id: "session-1",
          channelId: "ch-1",
          platformAddress: "addr-1",
          conversationId: "conv-1",
          status: "active",
          receive: "routed",
        }),
      });
      const { transport, inngestSend, mockEvent } = setup({ transportStore: ts });

      await transport.emit("session-1", "hello", new Date("2026-01-01"));

      expect(ts.persistInbound).toHaveBeenCalledWith({
        channelSessionId: "session-1",
        conversationId: "conv-1",
        content: "hello",
        platformTs: new Date("2026-01-01"),
      });
      expect(mockEvent.create).toHaveBeenCalledWith({
        conversationId: "conv-1",
        inboundMessageId: "inbound-1",
      });
      expect(inngestSend).toHaveBeenCalled();
    });

    it("returns error when session not found", async () => {
      const { transport } = setup();
      const result = await transport.emit("nonexistent", "hello", new Date());
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("session_not_found");
      }
    });
  });

  describe("idle timeout", () => {
    const activeSession = {
      id: "session-1",
      channelId: "ch-1",
      platformAddress: "addr-1",
      conversationId: "conv-1",
      status: "active",
      receive: "routed",
    };

    it("returns null and closes stale session", async () => {
      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      const ts = mockTransportStore({
        resolveSession: vi.fn().mockResolvedValue(activeSession),
      });
      const as = mockAgentStore({
        getLastMessageTime: vi.fn().mockResolvedValue(staleTime),
      });

      const { transport } = setup({
        transportStore: ts,
        agentStore: as,
        idleTimeoutMs: 60 * 60 * 1000, // 1 hour
      });

      const result = await transport.resolveSession("addr-1");
      expect(result).toBeNull();
      expect(ts.closeSession).toHaveBeenCalledWith("session-1");
    });

    it("returns session when within timeout", async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
      const ts = mockTransportStore({
        resolveSession: vi.fn().mockResolvedValue(activeSession),
      });
      const as = mockAgentStore({
        getLastMessageTime: vi.fn().mockResolvedValue(recentTime),
      });

      const { transport } = setup({
        transportStore: ts,
        agentStore: as,
        idleTimeoutMs: 60 * 60 * 1000, // 1 hour
      });

      const result = await transport.resolveSession("addr-1");
      expect(result).toEqual(activeSession);
      expect(ts.closeSession).not.toHaveBeenCalled();
    });

    it("skips check when timeout is 0 (disabled)", async () => {
      const ts = mockTransportStore({
        resolveSession: vi.fn().mockResolvedValue(activeSession),
      });

      const { transport, agentStore } = setup({
        transportStore: ts,
        idleTimeoutMs: 0,
      });

      const result = await transport.resolveSession("addr-1");
      expect(result).toEqual(activeSession);
      expect(agentStore.getLastMessageTime).not.toHaveBeenCalled();
    });

    it("returns session when no messages yet (new conversation)", async () => {
      const ts = mockTransportStore({
        resolveSession: vi.fn().mockResolvedValue(activeSession),
      });
      const as = mockAgentStore({
        getLastMessageTime: vi.fn().mockResolvedValue(null),
      });

      const { transport } = setup({
        transportStore: ts,
        agentStore: as,
        idleTimeoutMs: 60 * 60 * 1000,
      });

      const result = await transport.resolveSession("addr-1");
      expect(result).toEqual(activeSession);
    });
  });
});
