import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { openConversation } from "./open-conversation.js";

const FAKE_TX = { __mockTx: true } as never as Transaction;

const args = {
  channelId: "ch-1",
  platformAddress: "addr-1",
  userId: "user-1",
  isPrivate: true,
  profileId: undefined,
  defaultProfileId: "profile-global",
};

describe("openConversation", () => {
  it("inserts the conversation under the explicit profile when one is given", async () => {
    const transportStore = mockTransportStore({
      getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "profile-chat" }),
    });
    const agentStore = mockAgentStore();

    const opened = await openConversation({ transportStore, agentStore }, FAKE_TX, {
      ...args,
      profileId: "profile-explicit",
    });

    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-explicit",
      isPrivate: true,
    });
    expect(transportStore.getChatDefaultProfile).not.toHaveBeenCalled();
    expect(opened).toEqual({ conversationId: "conv-1", profileName: "assistant" });
  });

  it("falls back to the chat's default profile, then to the global default", async () => {
    const pinned = mockTransportStore({
      getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "profile-chat" }),
    });
    const pinnedAgent = mockAgentStore();
    await openConversation({ transportStore: pinned, agentStore: pinnedAgent }, FAKE_TX, args);
    expect(pinned.getChatDefaultProfile).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1");
    expect(pinnedAgent.createConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profileId: "profile-chat" }),
    );

    const unpinned = mockTransportStore(); // getChatDefaultProfile -> undefined
    const unpinnedAgent = mockAgentStore();
    await openConversation({ transportStore: unpinned, agentStore: unpinnedAgent }, FAKE_TX, {
      ...args,
      isPrivate: false,
    });
    expect(unpinnedAgent.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-global",
      isPrivate: false,
    });
  });

  it("throws when the profile the insert just used has no row", async () => {
    const agentStore = mockAgentStore({ getProfile: vi.fn().mockResolvedValue(null) });

    await expect(
      openConversation({ transportStore: mockTransportStore(), agentStore }, FAKE_TX, args),
    ).rejects.toThrow(/profile profile-global row is missing/);
  });
});
