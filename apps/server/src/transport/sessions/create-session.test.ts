import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createSession } from "./create-session.js";

const FAKE_TX = { __mockTx: true } as never as Transaction;

const args = {
  channelId: "ch-1",
  platformAddress: "addr-1",
  userId: "user-1",
  isPrivate: true,
  profileId: undefined,
  defaultProfileId: "profile-1",
  receive: "routed" as const,
};

const activeSession = {
  id: "session-live",
  channelId: "ch-1",
  platformAddress: "addr-1",
  conversationId: "conv-live",
  status: "active" as const,
  receive: "all" as const,
};

describe("createSession", () => {
  it("opens a conversation and swaps the free address onto it", async () => {
    const transportStore = mockTransportStore();
    const agentStore = mockAgentStore();

    const opened = await createSession({ transportStore, agentStore }, FAKE_TX, args);

    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-1",
      isPrivate: true,
    });
    expect(transportStore.swapSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1", {
      conversationId: "conv-1",
      receive: "routed",
    });
    expect(opened).toEqual({
      id: "session-swapped",
      channelId: "ch-1",
      platformAddress: "addr-1",
      conversationId: "conv-1",
      status: "active",
      receive: "routed",
      profileName: "assistant",
      kind: "created",
    });
  });

  it("joins the address's active session as is, inserting nothing", async () => {
    const transportStore = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
    });
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-live",
        userId: "user-1",
        profileId: "p-live",
        isPrivate: true,
      }),
      getProfile: vi.fn().mockResolvedValue({ id: "p-live", name: "live-profile" }),
    });

    const opened = await createSession({ transportStore, agentStore }, FAKE_TX, {
      ...args,
      profileId: "profile-wanted",
      isPrivate: false,
    });

    expect(opened).toEqual({ ...activeSession, profileName: "live-profile", kind: "joined" });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(transportStore.swapSession).not.toHaveBeenCalled();
    expect(agentStore.getProfile).toHaveBeenCalledWith(expect.anything(), "p-live");
  });

  it("throws when the joined session's profile row is missing", async () => {
    const transportStore = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
    });
    const agentStore = mockAgentStore({ getProfile: vi.fn().mockResolvedValue(null) });

    await expect(createSession({ transportStore, agentStore }, FAKE_TX, args)).rejects.toThrow(
      /session session-live/,
    );
  });
});
