import { describe, expect, it } from "vitest";
import { mockTransportStore } from "../../test/factories.js";
import { rotateSessions } from "./rotate-sessions.js";

const FAKE_TX = { __mockTx: true } as never;

describe("rotateSessions", () => {
  it("swaps every channel onto the conversation, keeping each one's receive mode", async () => {
    const transportStore = mockTransportStore();

    await rotateSessions({ transportStore }, FAKE_TX, {
      conversationId: "conv-fresh",
      channels: [
        { channelId: "ch-tg", platformAddress: "chat-42", receive: "routed" },
        { channelId: "ch-web", platformAddress: "tab-7", receive: "all" },
      ],
    });

    expect(transportStore.swapSession).toHaveBeenCalledTimes(2);
    expect(transportStore.swapSession).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "ch-tg",
      "chat-42",
      { conversationId: "conv-fresh", receive: "routed" },
    );
    expect(transportStore.swapSession).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "ch-web",
      "tab-7",
      { conversationId: "conv-fresh", receive: "all" },
    );
  });

  it("swaps nothing for no channels", async () => {
    const transportStore = mockTransportStore();
    await rotateSessions({ transportStore }, FAKE_TX, { conversationId: "conv", channels: [] });
    expect(transportStore.swapSession).not.toHaveBeenCalled();
  });
});
