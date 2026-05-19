import { describe, expect, it, vi } from "vitest";
import type { Transaction, Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import type { BoundaryPendingRow } from "../store/index.js";
import { resolveBoundary } from "./resolve-boundary.js";

const FAKE_TX = { __mockTx: true } as never as Transaction;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const baseRow: BoundaryPendingRow = {
  id: "b1",
  channelId: "ch-1",
  platformAddress: "chat-X",
  platformUserHandle: "tg-7",
  priorConversationId: "conv-prior",
  promptMessageId: "tg-msg:1",
  bufferedInbounds: [
    { content: "hello", platformTs: "2026-05-19T12:00:00.000Z" },
    { content: "are you there?", platformTs: "2026-05-19T12:00:30.000Z" },
  ],
  expiresAt: new Date("2026-05-19T12:00:30.000Z"),
  createdAt: new Date("2026-05-19T12:00:00.000Z"),
};

function makeDeps(
  overrides: {
    rowAtRead?: { row: BoundaryPendingRow | undefined };
    agentOverrides?: Parameters<typeof mockAgentStore>[0];
    transportOverrides?: Parameters<typeof mockTransportStore>[0];
  } = {},
) {
  const sendSpy = vi.fn().mockResolvedValue(undefined);
  const inngest = { send: sendSpy } as never as import("inngest").Inngest;
  const rowToReturn = overrides.rowAtRead ? overrides.rowAtRead.row : baseRow;
  const transportStore = mockTransportStore({
    getBoundaryPendingById: vi.fn().mockResolvedValue(rowToReturn),
    resolveUser: vi.fn().mockResolvedValue({ userId: "user-7" }),
    persistInbound: vi
      .fn()
      .mockResolvedValueOnce({ id: "inbound-1" })
      .mockResolvedValueOnce({ id: "inbound-2" }),
    swapSession: vi.fn().mockResolvedValue({ id: "session-resumed" }),
    createSession: vi.fn().mockResolvedValue({ id: "session-fresh" }),
    deleteBoundaryPending: vi.fn().mockResolvedValue(undefined),
    getChatDefaultProfile: vi.fn().mockResolvedValue(undefined),
    ...overrides.transportOverrides,
  });
  const agentStore = mockAgentStore({
    getConversation: vi.fn().mockResolvedValue({
      id: "conv-prior",
      userId: "user-7",
      profileId: "profile-1",
      isPrivate: true,
      cooldownState: null,
      voiceMode: null,
    }),
    createConversation: vi.fn().mockResolvedValue({ id: "conv-fresh" }),
    ...overrides.agentOverrides,
  });
  return {
    deps: {
      runInTx: fakeRunInTx,
      transportStore,
      agentStore,
      inngest,
      channelId: "ch-1",
      defaultProfileId: "profile-default",
    },
    sendSpy,
    transportStore,
    agentStore,
  };
}

describe("resolveBoundary", () => {
  it("resume: swaps to prior conversation, drains buffer, emits inbound events", async () => {
    const { deps, sendSpy, transportStore } = makeDeps();

    const res = await resolveBoundary(deps, {
      boundaryId: "b1",
      choice: { kind: "resume-prior" },
      reason: "user_resume",
    });

    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual({
      sessionId: "session-resumed",
      conversationId: "conv-prior",
      drainedInboundCount: 2,
      platformAddress: "chat-X",
    });

    expect(transportStore.swapSession).toHaveBeenCalledWith(
      expect.anything(),
      "ch-1",
      "chat-X",
      expect.objectContaining({ conversationId: "conv-prior" }),
    );
    expect(transportStore.persistInbound).toHaveBeenCalledTimes(2);
    expect(transportStore.persistInbound).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        source: "user",
        channelSessionId: "session-resumed",
        conversationId: "conv-prior",
        content: "hello",
      }),
    );
    expect(transportStore.deleteBoundaryPending).toHaveBeenCalledWith(expect.anything(), "b1");

    // 2 inbound/arrived + 1 boundary/resolved
    expect(sendSpy).toHaveBeenCalledTimes(3);
    const arrivedCalls = sendSpy.mock.calls.filter(([e]) => e?.name === "inbound/arrived");
    expect(arrivedCalls).toHaveLength(2);
    expect(arrivedCalls[0]?.[0]?.data).toEqual({
      conversationId: "conv-prior",
      inboundMessageId: "inbound-1",
    });
    // Dedup id so a retry after partial-emit crash doesn't double-fire the router.
    expect(arrivedCalls[0]?.[0]?.id).toBe("inbound-arrived-inbound-1");
    expect(arrivedCalls[1]?.[0]?.id).toBe("inbound-arrived-inbound-2");
    const resolvedCalls = sendSpy.mock.calls.filter(
      ([e]) => e?.name === "conversation/boundary/resolved",
    );
    expect(resolvedCalls).toHaveLength(1);
    expect(resolvedCalls[0]?.[0]?.data).toEqual({
      boundaryId: "b1",
      channelId: "ch-1",
      platformAddress: "chat-X",
      resolvedConversationId: "conv-prior",
      reason: "user_resume",
      drainedInboundCount: 2,
    });
  });

  it("fresh: creates a new conversation + session and drains into it", async () => {
    const { deps, transportStore, agentStore } = makeDeps();

    const res = await resolveBoundary(deps, {
      boundaryId: "b1",
      choice: { kind: "fresh" },
      reason: "user_fresh",
    });

    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual({
      sessionId: "session-fresh",
      conversationId: "conv-fresh",
      drainedInboundCount: 2,
      platformAddress: "chat-X",
    });

    expect(agentStore.createConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "user-7",
        profileId: "profile-default",
        isPrivate: true,
      }),
    );
    expect(transportStore.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: "ch-1",
        platformAddress: "chat-X",
        conversationId: "conv-fresh",
      }),
    );
    expect(transportStore.persistInbound).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        channelSessionId: "session-fresh",
        conversationId: "conv-fresh",
      }),
    );
  });

  it("fresh: uses chat-default profile when one is set", async () => {
    const { deps, agentStore } = makeDeps({
      transportOverrides: {
        getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "profile-pinned" }),
      },
    });

    await resolveBoundary(deps, {
      boundaryId: "b1",
      choice: { kind: "fresh" },
      reason: "waiter_timeout",
    });

    expect(agentStore.createConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profileId: "profile-pinned" }),
    );
  });

  it("returns boundary_not_found when the row is already gone (race with another resolver)", async () => {
    const { deps, sendSpy } = makeDeps({ rowAtRead: { row: undefined } });

    const res = await resolveBoundary(deps, {
      boundaryId: "b1",
      choice: { kind: "fresh" },
      reason: "waiter_timeout",
    });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr()).toEqual({ code: "boundary_not_found" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("resume: returns access_denied when prior conversation belongs to a different user", async () => {
    const { deps, sendSpy } = makeDeps({
      agentOverrides: {
        getConversation: vi.fn().mockResolvedValue({
          id: "conv-prior",
          userId: "other-user",
          profileId: "profile-1",
          isPrivate: true,
          cooldownState: null,
          voiceMode: null,
        }),
      },
    });

    const res = await resolveBoundary(deps, {
      boundaryId: "b1",
      choice: { kind: "resume-prior" },
      reason: "user_resume",
    });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr()).toEqual({ code: "access_denied" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("resume: returns identity_rejected when the handle isn't known on this channel", async () => {
    const { deps } = makeDeps({
      transportOverrides: {
        resolveUser: vi.fn().mockResolvedValue(undefined),
      },
    });

    const res = await resolveBoundary(deps, {
      boundaryId: "b1",
      choice: { kind: "resume-prior" },
      reason: "user_resume",
    });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });
});
