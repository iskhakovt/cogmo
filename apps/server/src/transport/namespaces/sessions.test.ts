import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { inboundArrived } from "../../inngest/events.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import type { AttachmentStore } from "../attachment-store.js";
import { createSessions } from "./sessions.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

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

  const sessions = createSessions({
    channelId: "ch-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
    defaultProfileId: "profile-1",
    inngest,
    inboundArrived: mockEvent,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: overrides?.idleTimeoutMs ?? 0,
    sessionReceive: "routed",
  });

  return { sessions, transportStore, agentStore, inngestSend, mockEvent };
}

describe("resolveSession", () => {
  it("delegates to transportStore with scoped channelId", async () => {
    const { sessions, transportStore } = setup();
    await sessions.resolveSession("addr-1");
    expect(transportStore.resolveSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1");
  });
});

describe("createConversation", () => {
  it("creates conversation via agentStore and session via transportStore", async () => {
    const { sessions, agentStore, transportStore } = setup();

    const session = await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-1",
      isPrivate: true,
    });
    expect(transportStore.createSession).toHaveBeenCalledWith(
      expect.anything(),
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

  it("returns identity_rejected when resolveUser returns null", async () => {
    const ts = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { sessions } = setup({ transportStore: ts });

    const result = await sessions.createConversation("addr-1", "unknown-user", {
      isPrivate: true,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("identity_rejected");
    }
  });

  it("uses resolved userId from identity (not defaultUserId)", async () => {
    const ts = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue({ userId: "resolved-user-42" }),
    });
    const { sessions } = setup({ transportStore: ts, agentStore: mockAgentStore() });

    await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(ts.resolveUser).toHaveBeenCalledWith(expect.anything(), "ch-1", "handle-1");
  });

  it("falls back to the per-chat default profile when none is passed", async () => {
    const ts = mockTransportStore({
      getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "profile-chat-default" }),
    });
    const agentStore = mockAgentStore();
    const { sessions } = setup({ transportStore: ts, agentStore });

    await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(ts.getChatDefaultProfile).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1");
    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-chat-default",
      isPrivate: true,
    });
  });

  it("explicit profileId wins over the per-chat default", async () => {
    const ts = mockTransportStore({
      getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "profile-chat-default" }),
    });
    const agentStore = mockAgentStore();
    const { sessions } = setup({ transportStore: ts, agentStore });

    await sessions.createConversation("addr-1", "handle-1", {
      isPrivate: true,
      profileId: "profile-explicit",
    });

    expect(ts.getChatDefaultProfile).not.toHaveBeenCalled();
    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-explicit",
      isPrivate: true,
    });
  });

  it("falls through to the global default when neither explicit nor chat default is set", async () => {
    // mockTransportStore returns `undefined` from getChatDefaultProfile by default.
    const agentStore = mockAgentStore();
    const { sessions } = setup({ agentStore });

    await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-1", // setup() defaults defaultProfileId to "profile-1"
      isPrivate: true,
    });
  });

  it("returns the resolved profile name on the success value", async () => {
    // The reply layer in handleNew consumes this to surface the profile
    // actually used — atomic with the insert, so it's race-free against
    // a concurrent /new swapping the active session.
    const agentStore = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue({
        id: "profile-1",
        userId: null,
        name: "doc-mode",
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: [],
        memoryScope: null,
        profileClass: null,
        streamChunkChars: 4000,
        streamEdits: true,
        codingAutoapproveMode: "off",
      }),
    });
    const { sessions } = setup({ agentStore });
    const result = await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });
    expect(result._unsafeUnwrap()).toMatchObject({ profileName: "doc-mode" });
  });

  it("returns profile_not_found when getProfile resolves to null after insert", async () => {
    // Defensive: agentStore.createConversation just succeeded with this id
    // under the same FK, so getProfile returning null would mean a torn tx
    // or schema bug. Surface a typed error rather than crashing on null.
    const agentStore = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
    });
    const { sessions } = setup({ agentStore });
    const result = await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });
    expect(result._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
  });
});

describe("closeSession", () => {
  it("delegates to transportStore", async () => {
    const { sessions, transportStore } = setup();
    await sessions.closeSession("session-1");
    expect(transportStore.closeSession).toHaveBeenCalledWith(expect.anything(), "session-1");
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
    const { sessions, inngestSend, mockEvent } = setup({ transportStore: ts });

    await sessions.emit("session-1", "hello", new Date("2026-01-01"));

    expect(ts.persistInbound).toHaveBeenCalledWith(expect.anything(), {
      channelSessionId: "session-1",
      conversationId: "conv-1",
      content: "hello",
      platformTs: new Date("2026-01-01"),
      source: "user",
    });
    expect(mockEvent.create).toHaveBeenCalledWith({
      conversationId: "conv-1",
      inboundMessageId: "inbound-1",
    });
    expect(inngestSend).toHaveBeenCalled();
  });

  it("returns error when session not found", async () => {
    const { sessions } = setup();
    const result = await sessions.emit("nonexistent", "hello", new Date());
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

    const { sessions } = setup({
      transportStore: ts,
      agentStore: as,
      idleTimeoutMs: 60 * 60 * 1000, // 1 hour
    });

    const result = await sessions.resolveSession("addr-1");
    expect(result).toBeNull();
    expect(ts.closeSession).toHaveBeenCalledWith(expect.anything(), "session-1");
  });

  it("returns session when within timeout", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const ts = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
    });
    const as = mockAgentStore({
      getLastMessageTime: vi.fn().mockResolvedValue(recentTime),
    });

    const { sessions } = setup({
      transportStore: ts,
      agentStore: as,
      idleTimeoutMs: 60 * 60 * 1000, // 1 hour
    });

    const result = await sessions.resolveSession("addr-1");
    expect(result).toEqual(activeSession);
    expect(ts.closeSession).not.toHaveBeenCalled();
  });

  it("skips check when timeout is 0 (disabled)", async () => {
    const ts = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
    });

    const { sessions, agentStore } = setup({
      transportStore: ts,
      idleTimeoutMs: 0,
    });

    const result = await sessions.resolveSession("addr-1");
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

    const { sessions } = setup({
      transportStore: ts,
      agentStore: as,
      idleTimeoutMs: 60 * 60 * 1000,
    });

    const result = await sessions.resolveSession("addr-1");
    expect(result).toEqual(activeSession);
  });
});

describe("resumeConversation", () => {
  it("resolves alias, verifies ownership, and swaps session atomically", async () => {
    const agentStore = mockAgentStore({
      findConversationByAlias: vi.fn().mockResolvedValue({ conversationId: "conv-1" }),
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "conv-1", userId: "user-1", profileId: "p1", isPrivate: true }),
    });
    const { sessions, transportStore } = setup({ agentStore });

    const res = await sessions.resumeConversation("addr-1", "handle-1", { alias: "work" });
    expect(res.isOk()).toBe(true);
    expect(agentStore.findConversationByAlias).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "work",
    );
    expect(transportStore.swapSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1", {
      conversationId: "conv-1",
      status: "active",
      receive: "routed",
    });
  });

  it("accepts conversationId target directly (skips alias lookup)", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "conv-1", userId: "user-1", profileId: "p1", isPrivate: true }),
    });
    const { sessions } = setup({ agentStore });

    const res = await sessions.resumeConversation("addr-1", "handle-1", {
      conversationId: "conv-1",
    });
    expect(res.isOk()).toBe(true);
    expect(agentStore.findConversationByAlias).not.toHaveBeenCalled();
  });

  it("returns conversation_not_found when alias lookup fails", async () => {
    const { sessions } = setup();
    const res = await sessions.resumeConversation("addr-1", "handle-1", { alias: "ghost" });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
  });

  it("returns access_denied when caller does not own the conversation", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "someone-else", profileId: "p", isPrivate: true }),
    });
    const { sessions } = setup({ agentStore });

    const res = await sessions.resumeConversation("addr-1", "handle-1", {
      conversationId: "c1",
    });
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
  });

  it("rejects non-private conversation with access_denied", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p", isPrivate: false }),
    });
    const { sessions } = setup({ agentStore });

    const res = await sessions.resumeConversation("addr-1", "handle-1", {
      conversationId: "c1",
    });
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("non-private"),
    });
  });
});
