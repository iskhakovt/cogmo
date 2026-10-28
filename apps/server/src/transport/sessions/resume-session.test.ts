import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "../../db/index.js";
import { logger } from "../../logger.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { resumeSession } from "./resume-session.js";

const FAKE_TX = { __mockTx: true } as never as Transaction;

const args = {
  channelId: "ch-1",
  platformAddress: "addr-1",
  userId: "user-1",
  conversationId: "conv-1",
  receive: "routed" as const,
};

function owned(overrides: { userId?: string; isPrivate?: boolean } = {}) {
  return mockAgentStore({
    getConversation: vi.fn().mockResolvedValue({
      id: "conv-1",
      userId: overrides.userId ?? "user-1",
      profileId: "p1",
      isPrivate: overrides.isPrivate ?? true,
    }),
  });
}

describe("resumeSession", () => {
  it("swaps the address onto the caller's private conversation", async () => {
    const transportStore = mockTransportStore();

    const resumed = await resumeSession({ transportStore, agentStore: owned() }, FAKE_TX, args);

    expect(transportStore.swapSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1", {
      conversationId: "conv-1",
      receive: "routed",
    });
    expect(resumed._unsafeUnwrap()).toEqual({
      id: "session-swapped",
      channelId: "ch-1",
      platformAddress: "addr-1",
      conversationId: "conv-1",
      status: "active",
      receive: "routed",
    });
  });

  it("logs the session the swap closed", async () => {
    const transportStore = mockTransportStore({
      swapSession: vi.fn().mockResolvedValue({ id: "session-new", closedIds: ["session-old"] }),
    });
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    try {
      await resumeSession({ transportStore, agentStore: owned() }, FAKE_TX, args);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-new", closedSessionIds: ["session-old"] }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("returns conversation_not_found for an unknown conversation", async () => {
    const agentStore = mockAgentStore({ getConversation: vi.fn().mockResolvedValue(null) });
    const res = await resumeSession({ transportStore: mockTransportStore(), agentStore }, FAKE_TX, {
      ...args,
      conversationId: "ghost",
    });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
  });

  it("returns access_denied for another user's conversation, and swaps nothing", async () => {
    const transportStore = mockTransportStore();
    const res = await resumeSession(
      { transportStore, agentStore: owned({ userId: "someone-else" }) },
      FAKE_TX,
      args,
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
    expect(transportStore.swapSession).not.toHaveBeenCalled();
  });

  it("returns access_denied for a non-private conversation", async () => {
    const res = await resumeSession(
      { transportStore: mockTransportStore(), agentStore: owned({ isPrivate: false }) },
      FAKE_TX,
      args,
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("non-private"),
    });
  });
});
