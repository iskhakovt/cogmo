import { describe, expect, it, vi } from "vitest";
import { mockTransportStore } from "../test/factories.js";
import { createCommandService } from "./command-service.js";

describe("createCommandService", () => {
  it("closes active session on resetConversation", async () => {
    const store = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue({
        id: "session-1",
        channelId: "ch-1",
        platformAddress: "addr",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
      }),
    });
    const service = createCommandService(store);

    await service.resetConversation("ch-1", "12345");

    expect(store.resolveSession).toHaveBeenCalledWith("ch-1", "12345");
    expect(store.closeSession).toHaveBeenCalledWith("session-1");
  });

  it("does nothing when no active session exists", async () => {
    const store = mockTransportStore();
    const service = createCommandService(store);

    await service.resetConversation("ch-1", "12345");

    expect(store.closeSession).not.toHaveBeenCalled();
  });
});
