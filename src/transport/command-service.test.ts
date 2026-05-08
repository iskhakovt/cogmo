import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../db/index.js";
import { mockTransportStore } from "../test/factories.js";
import { createCommandService } from "./command-service.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

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
    const service = createCommandService(fakeRunInTx, store);

    await service.resetConversation("ch-1", "12345");

    expect(store.resolveSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "12345");
    expect(store.closeSession).toHaveBeenCalledWith(expect.anything(), "session-1");
  });

  it("does nothing when no active session exists", async () => {
    const store = mockTransportStore();
    const service = createCommandService(fakeRunInTx, store);

    await service.resetConversation("ch-1", "12345");

    expect(store.closeSession).not.toHaveBeenCalled();
  });
});
