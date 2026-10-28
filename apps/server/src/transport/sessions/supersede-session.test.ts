import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { supersedeSession } from "./supersede-session.js";

const FAKE_TX = { __mockTx: true } as never;

const args = {
  channelId: "ch-1",
  platformAddress: "addr-1",
  userId: "user-1",
  isPrivate: true,
  profileId: "profile-explicit",
  defaultProfileId: "profile-1",
  receive: "routed" as const,
};

describe("supersedeSession", () => {
  it("opens a conversation under the explicit profile and swaps the address onto it", async () => {
    const transportStore = mockTransportStore();
    const agentStore = mockAgentStore();

    const superseded = await supersedeSession({ transportStore, agentStore }, FAKE_TX, args);

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
      id: "session-swapped",
      channelId: "ch-1",
      platformAddress: "addr-1",
      conversationId: "conv-1",
      status: "active",
      receive: "routed",
      profileName: "assistant",
    });
  });

  it("logs the session it closed — the record of a reply that will be skipped", async () => {
    const session = {
      id: "session-new",
      channelId: "ch-1",
      platformAddress: "addr-1",
      conversationId: "conv-1",
      status: "active" as const,
      receive: "routed" as const,
    };
    const transportStore = mockTransportStore({
      swapSession: vi.fn().mockResolvedValue({ session, closedIds: ["session-old"] }),
    });
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    try {
      await supersedeSession({ transportStore, agentStore: mockAgentStore() }, FAKE_TX, args);
      expect(info).toHaveBeenCalledWith(
        {
          platformAddress: "addr-1",
          sessionId: "session-new",
          closedSessionIds: ["session-old"],
        },
        expect.stringContaining("supersede closed"),
      );
    } finally {
      info.mockRestore();
    }
  });
});
