import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { supersedeSession } from "./supersede-session.js";

const FAKE_TX = { __mockTx: true } as never as Transaction;

describe("supersedeSession", () => {
  it("opens a conversation and swaps the address onto it, reporting what it closed", async () => {
    const transportStore = mockTransportStore({
      swapSession: vi.fn().mockResolvedValue({ id: "session-new", closedIds: ["session-old"] }),
    });
    const agentStore = mockAgentStore();

    const superseded = await supersedeSession({ transportStore, agentStore }, FAKE_TX, {
      channelId: "ch-1",
      platformAddress: "addr-1",
      userId: "user-1",
      isPrivate: true,
      profileId: "profile-explicit",
      defaultProfileId: "profile-1",
      receive: "routed",
    });

    expect(transportStore.resolveSession).not.toHaveBeenCalled();
    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-explicit",
      isPrivate: true,
    });
    expect(transportStore.swapSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1", {
      conversationId: "conv-1",
      receive: "routed",
    });
    expect(superseded).toEqual({
      session: {
        id: "session-new",
        channelId: "ch-1",
        platformAddress: "addr-1",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
        profileName: "assistant",
      },
      closedIds: ["session-old"],
    });
  });
});
