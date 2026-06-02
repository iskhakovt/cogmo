import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { Transactor } from "../db/index.js";
import type { inboundArrived } from "../inngest/events.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import { createTransport } from "./transport.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

// Filter `inngest.send` mock calls down to events whose payload name
// matches. Tighter than `.find(...)` — a future regression that
// double-fires the event surfaces as `toHaveLength(2)` instead of
// silently passing the same `.find` assertion.
function inngestSendCallsForEvent(calls: unknown[][], eventName: string): unknown[][] {
  return calls.filter((c) => {
    const payload = c[0];
    return (
      typeof payload === "object" &&
      payload !== null &&
      "name" in payload &&
      payload.name === eventName
    );
  });
}

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

  const transport = createTransport({
    channelId: "ch-1",
    defaultUserId: "user-1",
    defaultProfileId: "profile-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
    inngest,
    inboundArrived: mockEvent,
    attachments: { upload: vi.fn(), download: vi.fn() } as any,
    idleTimeoutMs: overrides?.idleTimeoutMs ?? 0,
  });

  return { transport, transportStore, agentStore, inngestSend, mockEvent };
}

describe("createTransport", () => {
  describe("resolveSession", () => {
    it("delegates to transportStore with scoped channelId", async () => {
      const { transport, transportStore } = setup();
      await transport.resolveSession("addr-1");
      expect(transportStore.resolveSession).toHaveBeenCalledWith(
        expect.anything(),
        "ch-1",
        "addr-1",
      );
    });
  });

  describe("createConversation", () => {
    it("creates conversation via agentStore and session via transportStore", async () => {
      const { transport, agentStore, transportStore } = setup();

      const session = await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

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
      const { transport } = setup({ transportStore: ts });

      const result = await transport.createConversation("addr-1", "unknown-user", {
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
      const { transport } = setup({ transportStore: ts, agentStore: mockAgentStore() });

      await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

      expect(ts.resolveUser).toHaveBeenCalledWith(expect.anything(), "ch-1", "handle-1");
    });

    it("falls back to the per-chat default profile when none is passed", async () => {
      const ts = mockTransportStore({
        getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "profile-chat-default" }),
      });
      const agentStore = mockAgentStore();
      const { transport } = setup({ transportStore: ts, agentStore });

      await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

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
      const { transport } = setup({ transportStore: ts, agentStore });

      await transport.createConversation("addr-1", "handle-1", {
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
      const { transport } = setup({ agentStore });

      await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

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
      const { transport } = setup({ agentStore });
      const result = await transport.createConversation("addr-1", "handle-1", { isPrivate: true });
      expect(result._unsafeUnwrap()).toMatchObject({ profileName: "doc-mode" });
    });

    it("returns profile_not_found when getProfile resolves to null after insert", async () => {
      // Defensive: agentStore.createConversation just succeeded with this id
      // under the same FK, so getProfile returning null would mean a torn tx
      // or schema bug. Surface a typed error rather than crashing on null.
      const agentStore = mockAgentStore({
        getProfile: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ agentStore });
      const result = await transport.createConversation("addr-1", "handle-1", { isPrivate: true });
      expect(result._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
    });
  });

  describe("chats.setDefaultProfile", () => {
    it("returns identity_rejected when handle does not resolve", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore });
      const res = await transport.chats.setDefaultProfile("ghost", "addr-1", "p1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("returns profile_not_found when the profile does not exist", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.chats.setDefaultProfile("handle", "addr-1", "ghost-profile");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
    });

    it("rejects pinning another user's profile", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-other" }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.chats.setDefaultProfile("handle", "addr-1", "p-their");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("not visible"),
      });
    });

    it("allows pinning an org profile (user_id = null)", async () => {
      const setChatDefaultProfile = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
      });
      const transportStore = mockTransportStore({ setChatDefaultProfile });
      const { transport } = setup({ transportStore, agentStore });
      const res = await transport.chats.setDefaultProfile("handle", "addr-1", "p-org");
      expect(res.isOk()).toBe(true);
      expect(setChatDefaultProfile).toHaveBeenCalledWith(expect.anything(), {
        channelId: "ch-1",
        platformAddress: "addr-1",
        profileId: "p-org",
      });
    });

    it("allows pinning the caller's own profile", async () => {
      const setChatDefaultProfile = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      });
      const transportStore = mockTransportStore({ setChatDefaultProfile });
      const { transport } = setup({ transportStore, agentStore });
      const res = await transport.chats.setDefaultProfile("handle", "addr-1", "p-mine");
      expect(res.isOk()).toBe(true);
      expect(setChatDefaultProfile).toHaveBeenCalled();
    });
  });

  describe("chats.getDefaultProfile", () => {
    it("returns null when no default is pinned", async () => {
      const { transport } = setup();
      const res = await transport.chats.getDefaultProfile("handle", "addr-1");
      expect(res._unsafeUnwrap()).toBeNull();
    });

    it("returns the bound profile's id and name when pinned", async () => {
      const transportStore = mockTransportStore({
        getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "p-pinned" }),
      });
      const agentStore = mockAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "p-pinned",
          userId: "user-1",
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
      const { transport } = setup({ transportStore, agentStore });
      const res = await transport.chats.getDefaultProfile("handle", "addr-1");
      expect(res._unsafeUnwrap()).toEqual({ profileId: "p-pinned", profileName: "doc-mode" });
    });

    it("returns profile_not_found when the bound row points at a missing profile", async () => {
      // Defensive: the FK cascade should sweep the binding when the profile
      // disappears, so seeing a row without a profile is an invariant break.
      // The implementation surfaces it as profile_not_found rather than
      // returning a half-populated record.
      const transportStore = mockTransportStore({
        getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "p-ghost" }),
      });
      const agentStore = mockAgentStore({
        getProfile: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore, agentStore });
      const res = await transport.chats.getDefaultProfile("handle", "addr-1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
    });
  });

  describe("chats.clearDefaultProfile", () => {
    it("delegates to transportStore.clearChatDefaultProfile", async () => {
      const clearChatDefaultProfile = vi.fn().mockResolvedValue(undefined);
      const transportStore = mockTransportStore({ clearChatDefaultProfile });
      const { transport } = setup({ transportStore });
      const res = await transport.chats.clearDefaultProfile("handle", "addr-1");
      expect(res.isOk()).toBe(true);
      expect(clearChatDefaultProfile).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1");
    });

    it("returns identity_rejected when handle does not resolve", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore });
      const res = await transport.chats.clearDefaultProfile("ghost", "addr-1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });
  });

  describe("closeSession", () => {
    it("delegates to transportStore", async () => {
      const { transport, transportStore } = setup();
      await transport.closeSession("session-1");
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
      const { transport, inngestSend, mockEvent } = setup({ transportStore: ts });

      await transport.emit("session-1", "hello", new Date("2026-01-01"));

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
      const { transport } = setup();
      const result = await transport.emit("nonexistent", "hello", new Date());
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

      const { transport } = setup({
        transportStore: ts,
        agentStore: as,
        idleTimeoutMs: 60 * 60 * 1000, // 1 hour
      });

      const result = await transport.resolveSession("addr-1");
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

      const { transport } = setup({
        transportStore: ts,
        agentStore: as,
        idleTimeoutMs: 60 * 60 * 1000, // 1 hour
      });

      const result = await transport.resolveSession("addr-1");
      expect(result).toEqual(activeSession);
      expect(ts.closeSession).not.toHaveBeenCalled();
    });

    it("skips check when timeout is 0 (disabled)", async () => {
      const ts = mockTransportStore({
        resolveSession: vi.fn().mockResolvedValue(activeSession),
      });

      const { transport, agentStore } = setup({
        transportStore: ts,
        idleTimeoutMs: 0,
      });

      const result = await transport.resolveSession("addr-1");
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

      const { transport } = setup({
        transportStore: ts,
        agentStore: as,
        idleTimeoutMs: 60 * 60 * 1000,
      });

      const result = await transport.resolveSession("addr-1");
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
      const { transport, transportStore } = setup({ agentStore });

      const res = await transport.resumeConversation("addr-1", "handle-1", { alias: "work" });
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
      const { transport } = setup({ agentStore });

      const res = await transport.resumeConversation("addr-1", "handle-1", {
        conversationId: "conv-1",
      });
      expect(res.isOk()).toBe(true);
      expect(agentStore.findConversationByAlias).not.toHaveBeenCalled();
    });

    it("returns conversation_not_found when alias lookup fails", async () => {
      const { transport } = setup();
      const res = await transport.resumeConversation("addr-1", "handle-1", { alias: "ghost" });
      expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
    });

    it("returns access_denied when caller does not own the conversation", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "someone-else", profileId: "p", isPrivate: true }),
      });
      const { transport } = setup({ agentStore });

      const res = await transport.resumeConversation("addr-1", "handle-1", {
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
      const { transport } = setup({ agentStore });

      const res = await transport.resumeConversation("addr-1", "handle-1", {
        conversationId: "c1",
      });
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("non-private"),
      });
    });
  });

  // --- Admin namespaces (Chunk 3) ---

  describe("conversations.setAlias", () => {
    it("returns access_denied when caller does not own the conversation", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "someone-else", profileId: "p", isPrivate: true }),
      });
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue({ userId: "user-1" }),
      });
      const { transport } = setup({ transportStore, agentStore });

      const res = await transport.conversations.setAlias("handle", "c1", "work");
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
    });

    it("rejects non-private conversations with access_denied", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p", isPrivate: false }),
      });
      const { transport } = setup({ agentStore });

      const res = await transport.conversations.setAlias("handle", "c1", "work");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("non-private"),
      });
    });

    it("maps UniqueViolationError to alias_taken", async () => {
      const { UniqueViolationError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p", isPrivate: true }),
        setAlias: vi.fn().mockRejectedValue(new UniqueViolationError("uq_aliases_user_alias")),
      });
      const { transport } = setup({ agentStore });

      const res = await transport.conversations.setAlias("handle", "c1", "work");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "alias_taken" });
    });
  });

  describe("conversations.getMessages", () => {
    it("returns identity_rejected when the handle doesn't resolve", async () => {
      const transportStore = mockTransportStore({ resolveUser: vi.fn().mockResolvedValue(null) });
      const { transport } = setup({ transportStore });
      const res = await transport.conversations.getMessages("handle", "c1");
      expect(res._unsafeUnwrapErr()).toMatchObject({ code: "identity_rejected" });
    });

    it("returns conversation_not_found for a missing conversation", async () => {
      const agentStore = mockAgentStore({ getConversation: vi.fn().mockResolvedValue(undefined) });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.getMessages("handle", "c1");
      expect(res._unsafeUnwrapErr()).toMatchObject({ code: "conversation_not_found" });
    });

    it("returns access_denied when caller does not own the conversation", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "someone-else", profileId: "p", isPrivate: true }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.getMessages("handle", "c1");
      expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
    });

    it("flattens content to text and drops tool-only turns", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p", isPrivate: true }),
        listMessages: vi.fn().mockResolvedValue([
          { id: "m1", role: "user", content: "hello" },
          {
            id: "m2",
            role: "assistant",
            content: [
              { type: "text", text: "hi " },
              { type: "text", text: "there" },
            ],
          },
          {
            id: "m3",
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
          },
          {
            id: "m4",
            role: "user",
            content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }],
          },
        ]),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.getMessages("handle", "c1");
      expect(res._unsafeUnwrap()).toEqual([
        { id: "m1", role: "user", text: "hello" },
        { id: "m2", role: "assistant", text: "hi there" },
      ]);
    });
  });

  describe("conversations.setProfile", () => {
    it("returns conversation_not_found when conversation missing", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setProfile("handle", "c1", "p1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
    });

    it("allows switching to an org profile (user_id = null)", async () => {
      const setConversationProfile = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-old",
          isPrivate: true,
          cooldownState: null,
        }),
        getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
        setConversationProfile,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setProfile("handle", "c1", "p-org");
      expect(res.isOk()).toBe(true);
      expect(setConversationProfile).toHaveBeenCalledWith(expect.anything(), "c1", "p-org");
    });

    it("rejects switching to another user's profile", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p-old", isPrivate: true }),
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-2" }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setProfile("handle", "c1", "p-their");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("not visible"),
      });
    });

    // Auto-repair clear trigger — switching profile is a context change
    // that should end any active cooldown so the new profile's
    // provider/tools get a clean slate. Same-tx so a partial commit
    // can't leave "switched profile but still cooling down". Verify
    // the clear fires when cooldown_state was set.
    it("clears cooldown_state in the same tx as the profile switch", async () => {
      const setConversationProfile = vi.fn();
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-old",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        setConversationProfile,
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setProfile("handle", "c1", "p-new");
      expect(res.isOk()).toBe(true);
      expect(setConversationProfile).toHaveBeenCalledWith(expect.anything(), "c1", "p-new");
      expect(clearCooldown).toHaveBeenCalledWith(expect.anything(), "c1");
    });

    // Symmetric to the success-path clear in handle-message:
    // skipping the UPDATE when cooldown_state is already NULL avoids
    // a per-call pointless write.
    it("does NOT call clearCooldown when cooldown_state was already NULL", async () => {
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-old",
          isPrivate: true,
          cooldownState: null,
        }),
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      await transport.conversations.setProfile("handle", "c1", "p-new");
      expect(clearCooldown).not.toHaveBeenCalled();
    });

    // Telemetry — emit AFTER the tx commits so a rolled-back tx
    // doesn't produce a phantom `cleared` event. Emit fires only
    // when a clear actually happened (prior cooldown_state non-null).
    it("emits conversation/cooldown/cleared with clearedBy=profile_switch when a clear happens", async () => {
      // Fake timers pin `elapsedCooldownSeconds` to an exact value
      // (3600s = the gap between `lastErroredAt` and `now`). Without
      // fake timers the integration assertion can only do
      // `expect.any(Number)`, missing a Math.max regression or a
      // wrong-anchor wiring slip.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
      try {
        const agentStore = mockAgentStore({
          getConversation: vi.fn().mockResolvedValue({
            id: "c1",
            userId: "user-1",
            profileId: "p-old",
            isPrivate: true,
            cooldownState: {
              lastErroredAt: "2026-05-19T11:00:00.000Z",
              cooldownSeconds: 60,
              consecutiveFailures: 1,
            },
          }),
          getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        });
        const { transport, inngestSend } = setup({ agentStore });
        await transport.conversations.setProfile("handle", "c1", "p-new");
        const clearedCalls = inngestSendCallsForEvent(
          inngestSend.mock.calls,
          "conversation/cooldown/cleared",
        );
        expect(clearedCalls).toHaveLength(1);
        expect(clearedCalls[0]?.[0]).toMatchObject({
          name: "conversation/cooldown/cleared",
          // Bus-dedup id keyed on (conversationId, lastErroredAt).
          id: "cooldown-cleared-c1-2026-05-19T11:00:00.000Z",
          data: {
            conversationId: "c1",
            clearedBy: "profile_switch",
            elapsedCooldownSeconds: 3600,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT emit cleared when cooldown_state was already NULL", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-old",
          isPrivate: true,
          cooldownState: null,
        }),
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      });
      const { transport, inngestSend } = setup({ agentStore });
      await transport.conversations.setProfile("handle", "c1", "p-new");
      expect(
        inngestSendCallsForEvent(inngestSend.mock.calls, "conversation/cooldown/cleared"),
      ).toHaveLength(0);
    });
  });

  describe("conversations.repair", () => {
    it("returns identity_rejected when handle does not resolve", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore });
      const res = await transport.conversations.repair("ghost", "c1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("returns conversation_not_found when conversation missing", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.repair("handle", "c1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
    });

    it("returns access_denied when caller does not own the conversation", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-other",
          profileId: "p1",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.repair("handle", "c1");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("not owned"),
      });
    });

    it("clears cooldown_state and reports wasCoolingDown: true", async () => {
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.repair("handle", "c1");
      expect(res._unsafeUnwrap()).toEqual({ wasCoolingDown: true });
      expect(clearCooldown).toHaveBeenCalledWith(expect.anything(), "c1");
    });

    it("is idempotent on conversations not cooling down and skips the write", async () => {
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          cooldownState: null,
        }),
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.repair("handle", "c1");
      expect(res._unsafeUnwrap()).toEqual({ wasCoolingDown: false });
      expect(clearCooldown).not.toHaveBeenCalled();
    });

    it("emits conversation/cooldown/cleared with clearedBy=user_repair on a real clear", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-19T11:00:30.000Z")); // 30s into the cooldown
      try {
        const agentStore = mockAgentStore({
          getConversation: vi.fn().mockResolvedValue({
            id: "c1",
            userId: "user-1",
            profileId: "p1",
            isPrivate: true,
            cooldownState: {
              lastErroredAt: "2026-05-19T11:00:00.000Z",
              cooldownSeconds: 60,
              consecutiveFailures: 1,
            },
          }),
        });
        const { transport, inngestSend } = setup({ agentStore });
        await transport.conversations.repair("handle", "c1");
        const clearedCalls = inngestSendCallsForEvent(
          inngestSend.mock.calls,
          "conversation/cooldown/cleared",
        );
        expect(clearedCalls).toHaveLength(1);
        expect(clearedCalls[0]?.[0]).toMatchObject({
          name: "conversation/cooldown/cleared",
          id: "cooldown-cleared-c1-2026-05-19T11:00:00.000Z",
          // Clear fired mid-window — elapsed < the prior cooldownSeconds
          data: { conversationId: "c1", clearedBy: "user_repair", elapsedCooldownSeconds: 30 },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT emit cleared when /repair was a no-op", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          cooldownState: null,
        }),
      });
      const { transport, inngestSend } = setup({ agentStore });
      await transport.conversations.repair("handle", "c1");
      expect(
        inngestSendCallsForEvent(inngestSend.mock.calls, "conversation/cooldown/cleared"),
      ).toHaveLength(0);
    });
  });

  describe("conversations.summary", () => {
    function makeAgentStore(overrides?: Parameters<typeof mockAgentStore>[0]) {
      return mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          cooldownState: null,
          voiceMode: null,
        }),
        getProfile: vi.fn().mockResolvedValue({
          id: "p1",
          userId: "user-1",
          name: "main",
          basePrompt: "",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          voiceMode: "auto",
          toolSet: ["recall_memory", "retain_memory"],
          memoryScope: null,
        }),
        getConversationStats: vi.fn().mockResolvedValue({
          createdAt: new Date("2026-04-16T10:00:00Z"),
          messageCount: 7,
          lastMessageAt: new Date("2026-04-16T11:30:00Z"),
        }),
        getAliasForConversation: vi.fn().mockResolvedValue("work"),
        getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 12_345, outputTokens: 678 }),
        countActiveRules: vi.fn().mockResolvedValue(3),
        ...overrides,
      });
    }

    function makeTransportStore() {
      return mockTransportStore({
        resolveSession: vi.fn().mockResolvedValue({
          id: "s1",
          channelId: "ch-1",
          platformAddress: "addr-1",
          conversationId: "c1",
          status: "active",
          receive: "routed",
        }),
      });
    }

    it("returns identity_rejected when handle does not resolve", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore });
      const res = await transport.conversations.summary("ghost", "addr-1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("returns ok(null) when no active session for the address", async () => {
      const { transport } = setup();
      const res = await transport.conversations.summary("handle", "addr-empty");
      expect(res._unsafeUnwrap()).toBeNull();
    });

    it("returns ok(null) when conversation is not owned by the caller (mirrors getCurrent)", async () => {
      const agentStore = makeAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-other",
          profileId: "p1",
          isPrivate: true,
          cooldownState: null,
          voiceMode: null,
        }),
      });
      const { transport } = setup({ agentStore, transportStore: makeTransportStore() });
      const res = await transport.conversations.summary("handle", "addr-1");
      expect(res._unsafeUnwrap()).toBeNull();
    });

    it("returns profile_not_found when profile row is missing", async () => {
      const agentStore = makeAgentStore({
        getProfile: vi.fn().mockResolvedValue(undefined),
      });
      const { transport } = setup({ agentStore, transportStore: makeTransportStore() });
      const res = await transport.conversations.summary("handle", "addr-1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
    });

    it("returns conversation_not_found when stats row is missing (race)", async () => {
      const agentStore = makeAgentStore({
        getConversationStats: vi.fn().mockResolvedValue(undefined),
      });
      const { transport } = setup({ agentStore, transportStore: makeTransportStore() });
      const res = await transport.conversations.summary("handle", "addr-1");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
    });

    it("aggregates conversation, profile, last-turn tokens, steering rules, and budget", async () => {
      const agentStore = makeAgentStore();
      const { transport } = setup({ agentStore, transportStore: makeTransportStore() });
      const res = await transport.conversations.summary("handle", "addr-1");
      const value = res._unsafeUnwrap();
      expect(value).toMatchObject({
        conversationId: "c1",
        alias: "work",
        cooldownState: null,
        messageCount: 7,
        profile: {
          id: "p1",
          name: "main",
          model: "claude-sonnet-4-6",
          toolCount: 2,
          autoRecall: "heuristic",
        },
        lastTurn: { inputTokens: 12_345, outputTokens: 678 },
        steeringRulesCount: 3,
      });
      // claude-sonnet-4-6: contextWindow 1_000_000 - maxOutputTokens 64_000 - safetyBuffer 10_000
      expect(value?.contextBudget).toBe(926_000);
      // No mcpRegistry wired in setup() → mcp namespace is null.
      expect(value?.mcp).toBeNull();
    });

    it("normalizes missing last-turn tokens to null", async () => {
      const agentStore = makeAgentStore({
        getLastTokens: vi.fn().mockResolvedValue(undefined),
      });
      const { transport } = setup({ agentStore, transportStore: makeTransportStore() });
      const res = await transport.conversations.summary("handle", "addr-1");
      expect(res._unsafeUnwrap()?.lastTurn).toBeNull();
    });

    it("returns contextBudget=null when the model is unknown to both DB and LiteLLM", async () => {
      // Resolver still returns a conservative default for the agent loop,
      // but `/status` elides the budget so the UI doesn't display the
      // resolver's guess as fact.
      const agentStore = makeAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "p1",
          userId: "user-1",
          name: "main",
          basePrompt: "",
          model: "totally-made-up-model-xyz-2099",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          voiceMode: "auto",
          toolSet: [],
          memoryScope: null,
        }),
      });
      const { transport } = setup({ agentStore, transportStore: makeTransportStore() });
      const res = await transport.conversations.summary("handle", "addr-1");
      expect(res._unsafeUnwrap()?.contextBudget).toBeNull();
    });
  });

  describe("conversations.setVoiceMode", () => {
    it("returns identity_rejected when handle does not resolve", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore });
      const res = await transport.conversations.setVoiceMode("ghost", "c1", "always");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("returns conversation_not_found when conversation missing", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setVoiceMode("handle", "c1", "always");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
    });

    it("returns access_denied when caller does not own the conversation", async () => {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-other",
          profileId: "p1",
          isPrivate: true,
          cooldownState: null,
          voiceMode: null,
        }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setVoiceMode("handle", "c1", "always");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("not owned"),
      });
    });

    it("persists the override on success (always)", async () => {
      const setConversationVoiceMode = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          status: "active",
          voiceMode: null,
        }),
        setConversationVoiceMode,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setVoiceMode("handle", "c1", "always");
      expect(res.isOk()).toBe(true);
      expect(setConversationVoiceMode).toHaveBeenCalledWith(expect.anything(), "c1", "always");
    });

    it("clears the override when called with null", async () => {
      const setConversationVoiceMode = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          status: "active",
          voiceMode: "always",
        }),
        setConversationVoiceMode,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setVoiceMode("handle", "c1", null);
      expect(res.isOk()).toBe(true);
      expect(setConversationVoiceMode).toHaveBeenCalledWith(expect.anything(), "c1", null);
    });
  });

  describe("profiles.update", () => {
    it("rejects org-profile mutation with access_denied", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update("handle", "p-org", { name: "mine" });
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("org profiles"),
      });
    });

    it("rejects another user's profile with access_denied", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-2" }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update("handle", "p-theirs", { name: "new" });
      expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
    });

    it("validates model against user_selectable and returns model_unavailable", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        isModelUserSelectable: vi.fn().mockResolvedValue(false),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update("handle", "p-mine", { model: "experimental-1" });
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "model_unavailable",
        model: "experimental-1",
      });
    });

    it("maps UniqueViolationError to profile_name_taken", async () => {
      const { UniqueViolationError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        updateProfile: vi.fn().mockRejectedValue(new UniqueViolationError("uq_profiles_user_name")),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update("handle", "p-mine", { name: "taken" });
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_name_taken" });
    });

    it("forwards memoryScope=null (clear) to agentStore.updateProfile verbatim", async () => {
      const updateProfile = vi.fn().mockResolvedValue({});
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        updateProfile,
      });
      const { transport } = setup({ agentStore });
      await transport.profiles.update("handle", "p-mine", { memoryScope: null });
      expect(updateProfile).toHaveBeenCalledWith(expect.anything(), "p-mine", {
        memoryScope: null,
      });
    });

    it("forwards a non-null memoryScope to agentStore.updateProfile verbatim", async () => {
      const updateProfile = vi.fn().mockResolvedValue({});
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        updateProfile,
      });
      const { transport } = setup({ agentStore });
      const memoryScope = {
        compartments: ["work" as const, "technical" as const],
        trust: ["first-party" as const],
      };
      await transport.profiles.update("handle", "p-mine", { memoryScope });
      expect(updateProfile).toHaveBeenCalledWith(expect.anything(), "p-mine", { memoryScope });
    });

    // Auto-repair clear trigger — `/model` passes
    // `clearCooldownForConversation: currentConversationId` so the model
    // update and the cooldown clear land in the same tx. Verifies the
    // clear fires and ownership is checked against the conversation
    // before the profile update commits.
    it("clearCooldownForConversation: calls clearCooldown in the same tx as the model update", async () => {
      const updateProfile = vi.fn().mockResolvedValue({});
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-mine",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
        updateProfile,
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update(
        "handle",
        "p-mine",
        { model: "gpt-4o" },
        { clearCooldownForConversation: "c1" },
      );
      expect(res.isOk()).toBe(true);
      expect(updateProfile).toHaveBeenCalled();
      expect(clearCooldown).toHaveBeenCalledWith(expect.anything(), "c1");
    });

    // Without the opt, no cooldown clear — verifies the option is
    // opt-in (other update callers like `/profile edit` shouldn't
    // touch cooldown).
    it("clearCooldownForConversation absent: does NOT call clearCooldown", async () => {
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      await transport.profiles.update("handle", "p-mine", { model: "gpt-4o" });
      expect(clearCooldown).not.toHaveBeenCalled();
    });

    // Ownership check on the conversation runs BEFORE the profile
    // update commits — so a wrong conversationId aborts the whole
    // update rather than silently dropping the cooldown-clear side
    // effect.
    it("clearCooldownForConversation: returns access_denied when conversation isn't owned by caller", async () => {
      const updateProfile = vi.fn().mockResolvedValue({});
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue({
          id: "c-other",
          userId: "user-2",
          profileId: "p-other",
          isPrivate: true,
          cooldownState: null,
        }),
        updateProfile,
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update(
        "handle",
        "p-mine",
        { model: "gpt-4o" },
        { clearCooldownForConversation: "c-other" },
      );
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("conversation"),
      });
      expect(updateProfile).not.toHaveBeenCalled();
      expect(clearCooldown).not.toHaveBeenCalled();
    });

    it("clearCooldownForConversation: returns conversation_not_found when conv row is missing", async () => {
      const updateProfile = vi.fn().mockResolvedValue({});
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue(undefined),
        updateProfile,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update(
        "handle",
        "p-mine",
        { model: "gpt-4o" },
        { clearCooldownForConversation: "c-gone" },
      );
      expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
      expect(updateProfile).not.toHaveBeenCalled();
    });

    // The clear's rationale is "the model the failing turn used
    // changed." If the conversation doesn't actually use this profile,
    // the new model isn't its model and the clear would be spurious.
    // Reject so the caller surfaces a bug rather than silently
    // clearing cooldown on an unrelated conversation.
    it("clearCooldownForConversation: returns access_denied when conversation uses a different profile", async () => {
      const updateProfile = vi.fn().mockResolvedValue({});
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue({
          id: "c-elsewhere",
          userId: "user-1",
          profileId: "p-other",
          isPrivate: true,
          cooldownState: null,
        }),
        updateProfile,
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update(
        "handle",
        "p-mine",
        { model: "gpt-4o" },
        { clearCooldownForConversation: "c-elsewhere" },
      );
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("does not use this profile"),
      });
      expect(updateProfile).not.toHaveBeenCalled();
      expect(clearCooldown).not.toHaveBeenCalled();
    });

    // Mirror setProfile's optimization — skip the UPDATE when there's
    // nothing to clear. Without this, every `/model` against a
    // not-currently-cooling-down conversation would write a no-op
    // row version on `conversations`.
    // When `updateProfile` raises `UniqueViolationError`, Postgres
    // marks the tx as aborted. The error MUST propagate out of
    // `runInTx` so Drizzle issues a clean ROLLBACK before the outer
    // catch translates to `err`. Catching inside the tx and returning
    // `err` would let `runInTx` resolve, Drizzle would send COMMIT,
    // and Postgres would silently turn that into a ROLLBACK with a
    // NOTICE — end-to-end correct but misleading-on-paper. The
    // observable contract this test pins: `clearCooldown` must NOT
    // fire on the unique-violation path, even though
    // `clearCooldownForConversation` was passed and the conversation
    // was cooling down.
    it("UniqueViolationError aborts the tx without firing clearCooldown", async () => {
      const updateProfile = vi
        .fn()
        .mockRejectedValue(
          new (await import("../agent/store/errors.js")).UniqueViolationError(
            "uq_profiles_user_name",
          ),
        );
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-mine",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
        updateProfile,
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update(
        "handle",
        "p-mine",
        { name: "taken" },
        { clearCooldownForConversation: "c1" },
      );
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_name_taken" });
      expect(clearCooldown).not.toHaveBeenCalled();
    });

    it("clearCooldownForConversation: skips the clear write when cooldown_state was already NULL", async () => {
      const clearCooldown = vi.fn();
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-mine",
          isPrivate: true,
          cooldownState: null,
        }),
        clearCooldown,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update(
        "handle",
        "p-mine",
        { model: "gpt-4o" },
        { clearCooldownForConversation: "c1" },
      );
      expect(res.isOk()).toBe(true);
      expect(clearCooldown).not.toHaveBeenCalled();
    });

    it("emits cleared with clearedBy=model_switch when a clear happens", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-19T11:00:00.000Z"));
      try {
        const agentStore = mockAgentStore({
          getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
          getConversation: vi.fn().mockResolvedValue({
            id: "c1",
            userId: "user-1",
            profileId: "p-mine",
            isPrivate: true,
            cooldownState: {
              lastErroredAt: "2026-05-19T11:00:00.000Z",
              cooldownSeconds: 60,
              consecutiveFailures: 1,
            },
          }),
        });
        const { transport, inngestSend } = setup({ agentStore });
        await transport.profiles.update(
          "handle",
          "p-mine",
          { model: "gpt-4o" },
          { clearCooldownForConversation: "c1" },
        );
        const clearedCalls = inngestSendCallsForEvent(
          inngestSend.mock.calls,
          "conversation/cooldown/cleared",
        );
        expect(clearedCalls).toHaveLength(1);
        expect(clearedCalls[0]?.[0]).toMatchObject({
          name: "conversation/cooldown/cleared",
          id: "cooldown-cleared-c1-2026-05-19T11:00:00.000Z",
          // now === lastErroredAt → elapsed is exactly 0
          data: {
            conversationId: "c1",
            clearedBy: "model_switch",
            elapsedCooldownSeconds: 0,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    // UniqueViolation path: tx rolls back, so no clear actually
    // happened. The post-tx emit must NOT fire even though
    // priorCooldownStateForEmit was captured inside the cb.
    it("does NOT emit cleared when updateProfile throws (rolled-back clear)", async () => {
      const updateProfile = vi
        .fn()
        .mockRejectedValue(
          new (await import("../agent/store/errors.js")).UniqueViolationError(
            "uq_profiles_user_name",
          ),
        );
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-mine",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
        updateProfile,
      });
      const { transport, inngestSend } = setup({ agentStore });
      const res = await transport.profiles.update(
        "handle",
        "p-mine",
        { name: "taken" },
        { clearCooldownForConversation: "c1" },
      );
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_name_taken" });
      expect(
        inngestSendCallsForEvent(inngestSend.mock.calls, "conversation/cooldown/cleared"),
      ).toHaveLength(0);
    });
  });

  describe("profiles.delete", () => {
    it("returns profile_in_use when deleteProfile throws ProfileInUseError (atomic check)", async () => {
      const { ProfileInUseError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        deleteProfile: vi.fn().mockRejectedValue(new ProfileInUseError(1, 4)),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.delete("handle", "p-mine");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_in_use" });
    });

    it("rejects deleting an org profile with access_denied", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.delete("handle", "p-org");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("org profiles"),
      });
    });
  });

  describe("profiles.create", () => {
    it("validates model and returns model_unavailable", async () => {
      const agentStore = mockAgentStore({
        isModelUserSelectable: vi.fn().mockResolvedValue(false),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.create("handle", {
        name: "new",
        basePrompt: "p",
        model: "experimental-1",
        toolSet: [],
      });
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "model_unavailable",
        model: "experimental-1",
      });
    });

    it("forwards memoryScope to agentStore.createProfile when present", async () => {
      const createProfile = vi.fn().mockResolvedValue({});
      const agentStore = mockAgentStore({ createProfile });
      const { transport } = setup({ agentStore });
      const memoryScope = {
        compartments: ["work" as const, "technical" as const],
        trust: ["first-party" as const],
      };
      await transport.profiles.create("handle", {
        name: "coder",
        basePrompt: "p",
        model: "claude-sonnet-4-6",
        toolSet: [],
        memoryScope,
      });
      expect(createProfile).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ memoryScope }),
      );
    });

    it("omits memoryScope from createProfile params when not supplied (store applies its own default)", async () => {
      // The store's `memoryScope` column defaults to null at the DB level. The
      // transport must not coerce undefined → null on the way through, because
      // future store-level defaults (e.g. inheriting from the org profile)
      // must not be silently overwritten by an explicit null.
      const createProfile = vi.fn().mockResolvedValue({});
      const agentStore = mockAgentStore({ createProfile });
      const { transport } = setup({ agentStore });
      await transport.profiles.create("handle", {
        name: "open",
        basePrompt: "p",
        model: "claude-sonnet-4-6",
        toolSet: [],
      });
      const args = createProfile.mock.calls[0]?.[0] as Record<string, unknown>;
      expect("memoryScope" in args).toBe(false);
    });
  });

  describe("profiles.setClass", () => {
    it("rejects org-profile classing with access_denied", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.setClass("handle", "p-org", "intimate");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("org profiles"),
      });
    });

    it("rejects another user's profile with access_denied", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-2" }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.setClass("handle", "p-theirs", "intimate");
      expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
    });

    it("returns identity_rejected when resolveUser returns null", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore });
      const res = await transport.profiles.setClass("handle", "p-1", "intimate");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("returns profile_not_found when getProfileOwner returns undefined", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue(undefined),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.setClass("handle", "p-missing", "intimate");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
    });

    it("maps UnknownProfileClassError to unknown_profile_class with the offending name", async () => {
      const { UnknownProfileClassError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        setProfileClass: vi.fn().mockRejectedValue(new UnknownProfileClassError("nope")),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.setClass("handle", "p-mine", "nope");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "unknown_profile_class", name: "nope" });
    });

    it("forwards className=null (clear) to agentStore.setProfileClass verbatim", async () => {
      const setProfileClass = vi.fn().mockResolvedValue(undefined);
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        setProfileClass,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.setClass("handle", "p-mine", null);
      expect(res.isOk()).toBe(true);
      expect(setProfileClass).toHaveBeenCalledWith(expect.anything(), "p-mine", null);
    });

    it("happy path forwards a non-null className", async () => {
      const setProfileClass = vi.fn().mockResolvedValue(undefined);
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        setProfileClass,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.setClass("handle", "p-mine", "intimate");
      expect(res.isOk()).toBe(true);
      expect(setProfileClass).toHaveBeenCalledWith(expect.anything(), "p-mine", "intimate");
    });
  });

  describe("profileClasses", () => {
    it("list returns identity_rejected when resolveUser returns null", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const { transport } = setup({ transportStore });
      const res = await transport.profileClasses.list("handle");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("list scopes to the resolved userId", async () => {
      const listProfileClasses = vi.fn().mockResolvedValue([
        {
          id: "c-1",
          userId: "user-1",
          name: "intimate",
          description: "for emotional / relationship topics",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
      ]);
      const agentStore = mockAgentStore({ listProfileClasses });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.list("handle");
      expect(res._unsafeUnwrap()).toHaveLength(1);
      expect(listProfileClasses).toHaveBeenCalledWith(expect.anything(), "user-1");
    });

    it("create maps UniqueViolationError to profile_class_name_taken", async () => {
      const { UniqueViolationError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        createProfileClass: vi
          .fn()
          .mockRejectedValue(new UniqueViolationError("uq_profile_classes_user_name")),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.create("handle", {
        name: "intimate",
        description: "x",
      });
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "profile_class_name_taken",
        name: "intimate",
      });
    });

    it("create maps InvalidNameError to profile_class_name_invalid", async () => {
      const { InvalidNameError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        createProfileClass: vi
          .fn()
          .mockRejectedValue(new InvalidNameError("Mixed Case", "profile_class")),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.create("handle", {
        name: "Mixed Case",
        description: "x",
      });
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "profile_class_name_invalid",
        name: "Mixed Case",
      });
    });

    it("create happy path forwards name + description", async () => {
      const createProfileClass = vi.fn().mockResolvedValue({
        id: "c-1",
        userId: "user-1",
        name: "intimate",
        description: "for emotional / relationship topics",
        restricted: false,
        createdAt: new Date("2026-04-16T12:00:00Z"),
      });
      const agentStore = mockAgentStore({ createProfileClass });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.create("handle", {
        name: "intimate",
        description: "for emotional / relationship topics",
      });
      expect(res._unsafeUnwrap().name).toBe("intimate");
      expect(createProfileClass).toHaveBeenCalledWith(expect.anything(), {
        userId: "user-1",
        name: "intimate",
        description: "for emotional / relationship topics",
      });
    });

    it("delete returns profile_class_not_found when no row matches", async () => {
      const agentStore = mockAgentStore({
        deleteProfileClass: vi.fn().mockResolvedValue({ deleted: false }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.delete("handle", "no-such");
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "profile_class_not_found",
        name: "no-such",
      });
    });

    it("delete maps ProfileClassInUseError to profile_class_in_use with refCount", async () => {
      const { ProfileClassInUseError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        deleteProfileClass: vi.fn().mockRejectedValue(new ProfileClassInUseError(2)),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.delete("handle", "intimate");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_class_in_use", profileRefs: 2 });
    });

    it("delete happy path returns ok with deleted:true", async () => {
      const deleteProfileClass = vi.fn().mockResolvedValue({ deleted: true });
      const agentStore = mockAgentStore({ deleteProfileClass });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.delete("handle", "intimate");
      expect(res.isOk()).toBe(true);
      expect(deleteProfileClass).toHaveBeenCalledWith(expect.anything(), "user-1", "intimate");
    });

    it("setRestricted forwards (userId, name, restricted) and returns ok on success", async () => {
      const setProfileClassRestricted = vi.fn().mockResolvedValue({ updated: true });
      const agentStore = mockAgentStore({ setProfileClassRestricted });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.setRestricted("handle", "intimate", true);
      expect(res.isOk()).toBe(true);
      expect(setProfileClassRestricted).toHaveBeenCalledWith(
        expect.anything(),
        "user-1",
        "intimate",
        true,
      );
    });

    it("setRestricted returns profile_class_not_found when the row is absent", async () => {
      const agentStore = mockAgentStore({
        setProfileClassRestricted: vi.fn().mockResolvedValue({ updated: false }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profileClasses.setRestricted("handle", "no-such", true);
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "profile_class_not_found",
        name: "no-such",
      });
    });

    it("setRestricted returns identity_rejected when resolveUser returns null", async () => {
      const transportStore = mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue(null),
      });
      const setProfileClassRestricted = vi.fn();
      const { transport } = setup({
        transportStore,
        agentStore: mockAgentStore({ setProfileClassRestricted }),
      });
      const res = await transport.profileClasses.setRestricted("handle", "intimate", true);
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
      // Identity check fires before the store call — agent store stays untouched.
      expect(setProfileClassRestricted).not.toHaveBeenCalled();
    });
  });

  describe("compartments", () => {
    it("list scopes to the resolved userId", async () => {
      const listCustomCompartments = vi.fn().mockResolvedValue([
        {
          id: "cc-1",
          userId: "user-1",
          name: "dnd",
          description: "campaign notes",
          createdAt: new Date("2026-05-09T12:00:00Z"),
        },
      ]);
      const agentStore = mockAgentStore({ listCustomCompartments });
      const { transport } = setup({ agentStore });
      const res = await transport.compartments.list("handle");
      expect(res._unsafeUnwrap()).toHaveLength(1);
      expect(listCustomCompartments).toHaveBeenCalledWith(expect.anything(), "user-1");
    });

    it("create maps InvalidNameError to compartment_name_invalid", async () => {
      const { InvalidNameError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        createCustomCompartment: vi
          .fn()
          .mockRejectedValue(new InvalidNameError("Bad Name", "compartment")),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.compartments.create("handle", {
        name: "Bad Name",
        description: "x",
      });
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "compartment_name_invalid",
        name: "Bad Name",
      });
    });

    it("create maps reserved-name error to compartment_name_reserved", async () => {
      const { ReservedCompartmentNameError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        createCustomCompartment: vi
          .fn()
          .mockRejectedValue(new ReservedCompartmentNameError("personal")),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.compartments.create("handle", {
        name: "personal",
        description: "x",
      });
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "compartment_name_reserved",
        name: "personal",
      });
    });

    it("create maps cap-exceeded error to compartment_cap_exceeded", async () => {
      const { CustomCompartmentCapExceededError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        createCustomCompartment: vi
          .fn()
          .mockRejectedValue(new CustomCompartmentCapExceededError(10, 10)),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.compartments.create("handle", {
        name: "overflow",
        description: "x",
      });
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "compartment_cap_exceeded",
        limit: 10,
        current: 10,
      });
    });

    it("create maps UniqueViolationError to compartment_name_taken", async () => {
      const { UniqueViolationError } = await import("../agent/store/errors.js");
      const agentStore = mockAgentStore({
        createCustomCompartment: vi
          .fn()
          .mockRejectedValue(new UniqueViolationError("uq_custom_compartments_user_name")),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.compartments.create("handle", {
        name: "dnd",
        description: "x",
      });
      expect(res._unsafeUnwrapErr()).toEqual({ code: "compartment_name_taken", name: "dnd" });
    });

    it("delete returns compartment_not_found when no row matches", async () => {
      const agentStore = mockAgentStore({
        deleteCustomCompartment: vi.fn().mockResolvedValue({ deleted: false }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.compartments.delete("handle", "no-such");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "compartment_not_found", name: "no-such" });
    });

    it("delete happy path returns ok and forwards (userId, name)", async () => {
      const deleteCustomCompartment = vi.fn().mockResolvedValue({ deleted: true });
      const agentStore = mockAgentStore({ deleteCustomCompartment });
      const { transport } = setup({ agentStore });
      const res = await transport.compartments.delete("handle", "dnd");
      expect(res.isOk()).toBe(true);
      expect(deleteCustomCompartment).toHaveBeenCalledWith(expect.anything(), "user-1", "dnd");
    });
  });

  describe("profiles.update memoryScope validation", () => {
    it("rejects an unknown compartment value with compartment_unknown", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        listCustomCompartments: vi.fn().mockResolvedValue([
          {
            id: "cc-1",
            userId: "user-1",
            name: "dnd",
            description: "x",
            createdAt: new Date(),
          },
        ]),
        updateProfile: vi.fn(),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update("handle", "p1", {
        memoryScope: { compartments: ["work", "music"], trust: ["first-party"] },
      });
      expect(res._unsafeUnwrapErr()).toEqual({ code: "compartment_unknown", name: "music" });
      expect(agentStore.updateProfile).not.toHaveBeenCalled();
    });

    it("accepts core + custom compartment values", async () => {
      const updateProfile = vi.fn().mockResolvedValue({
        id: "p1",
        userId: "user-1",
        name: "test",
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: [],
        memoryScope: { compartments: ["work", "dnd"], trust: ["first-party"] },
        profileClass: null,
        streamChunkChars: 4000,
        streamEdits: true,
        codingAutoapproveMode: "off",
      });
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        listCustomCompartments: vi.fn().mockResolvedValue([
          {
            id: "cc-1",
            userId: "user-1",
            name: "dnd",
            description: "x",
            createdAt: new Date(),
          },
        ]),
        updateProfile,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.profiles.update("handle", "p1", {
        memoryScope: { compartments: ["work", "dnd"], trust: ["first-party"] },
      });
      expect(res.isOk()).toBe(true);
      expect(updateProfile).toHaveBeenCalledWith(expect.anything(), "p1", {
        memoryScope: { compartments: ["work", "dnd"], trust: ["first-party"] },
      });
    });
  });

  describe("models.list", () => {
    it("delegates to agentStore.listDistinctUserSelectableModels", async () => {
      const agentStore = mockAgentStore({
        listDistinctUserSelectableModels: vi
          .fn()
          .mockResolvedValue(["claude-sonnet-4-6", "gpt-4o"]),
      });
      const { transport } = setup({ agentStore });
      expect(await transport.models.list()).toEqual(["claude-sonnet-4-6", "gpt-4o"]);
    });
  });

  describe("repos", () => {
    function setupWithCoding(overrides: Partial<CodingStore>) {
      const transportStore = mockTransportStore();
      const agentStore = mockAgentStore();
      const inngestSend = vi.fn().mockResolvedValue(undefined);
      const inngest = { send: inngestSend } as unknown as Parameters<
        typeof createTransport
      >[0]["inngest"];
      const mockEvent = {
        create: vi.fn((data: unknown) => ({ name: "inbound/arrived", data })),
      } as unknown as typeof inboundArrived;
      const codingStore: CodingStore = { ...mock<CodingStore>(), ...overrides };
      const transport = createTransport({
        channelId: "ch-1",
        defaultUserId: "user-1",
        defaultProfileId: "profile-1",
        runInTx: fakeRunInTx,
        transportStore,
        agentStore,
        codingStore,
        inngest,
        inboundArrived: mockEvent,
        attachments: { upload: vi.fn(), download: vi.fn() } as unknown as Parameters<
          typeof createTransport
        >[0]["attachments"],
        idleTimeoutMs: 0,
      });
      return transport;
    }

    it("returns sandbox_disabled when no codingStore is supplied", async () => {
      const { transport } = setup();
      const list = await transport.repos.list();
      expect(list._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
      const add = await transport.repos.add({
        name: "x",
        localPath: "/p",
        remoteUrl: "git@x:y/z.git",
      });
      expect(add._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
      const remove = await transport.repos.remove("x");
      expect(remove._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
    });

    it("list maps store rows to RepoSummary shape", async () => {
      const codingStore = {
        listRepos: vi.fn().mockResolvedValue([
          {
            id: "r1",
            name: "cogmo",
            localPath: "/p",
            defaultBranch: "main",
            remoteUrl: "git@x:y/z.git",
            verifyCommand: "true",
            devcontainer: null,
            allowedBackends: ["claude"],
            taskTokenBudget: 1,
            taskWallTimeSeconds: 1,
            maxConcurrentTasks: 1,
            createdAt: new Date(),
          },
        ]),
        insertRepo: vi.fn(),
        getRepoByName: vi.fn(),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
      };
      const transport = setupWithCoding(codingStore);
      const res = await transport.repos.list();
      expect(res._unsafeUnwrap()[0]).toEqual({
        id: "r1",
        name: "cogmo",
        localPath: "/p",
        defaultBranch: "main",
        remoteUrl: "git@x:y/z.git",
        verifyCommand: "true",
      });
    });

    it("add applies slice-1 defaults (verify=true, branch=main, single backend, single concurrent)", async () => {
      const insertRepo = vi.fn().mockResolvedValue({
        id: "r1",
        name: "cogmo",
        localPath: "/p",
        defaultBranch: "main",
        remoteUrl: "git@x:y/z.git",
        verifyCommand: "true",
        devcontainer: null,
        allowedBackends: ["claude"],
        taskTokenBudget: 200_000,
        taskWallTimeSeconds: 1800,
        maxConcurrentTasks: 1,
        createdAt: new Date(),
      });
      const transport = setupWithCoding({
        listRepos: vi.fn(),
        insertRepo,
        getRepoByName: vi.fn(),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
      });
      await transport.repos.add({
        name: "cogmo",
        localPath: "/p",
        remoteUrl: "git@x:y/z.git",
      });
      const insertCall = insertRepo.mock.calls[0];
      if (!insertCall) throw new Error("expected insertRepo to have been called");
      const args = insertCall[1] as Parameters<CodingStore["insertRepo"]>[1];
      expect(args.defaultBranch).toBe("main");
      expect(args.verifyCommand).toBe("true");
      expect(args.allowedBackends).toEqual(["claude"]);
      expect(args.taskTokenBudget).toBe(200_000);
      expect(args.maxConcurrentTasks).toBe(1);
    });

    describe("add input validation", () => {
      function freshTransport() {
        return setupWithCoding({
          listRepos: vi.fn(),
          insertRepo: vi.fn(),
          getRepoByName: vi.fn(),
          countActiveTasksForRepo: vi.fn(),
          removeRepo: vi.fn(),
        });
      }

      it("rejects names with path separators", async () => {
        const t = freshTransport();
        const res = await t.repos.add({
          name: "evil/../escape",
          localPath: "/p",
          remoteUrl: "git@x:y.git",
        });
        const e = res._unsafeUnwrapErr();
        expect(e.code).toBe("repo_invalid_input");
        if (e.code === "repo_invalid_input") expect(e.field).toBe("name");
      });

      it("rejects names with spaces or shell metacharacters", async () => {
        const t = freshTransport();
        const res = await t.repos.add({
          name: "my repo",
          localPath: "/p",
          remoteUrl: "git@x:y.git",
        });
        expect(res._unsafeUnwrapErr().code).toBe("repo_invalid_input");
      });

      it("accepts valid names with letters, digits, dot, dash, underscore", async () => {
        const insertRepo = vi.fn().mockResolvedValue({
          id: "r1",
          name: "cogmo.notes_v2-rc1",
          localPath: "/p",
          defaultBranch: "main",
          remoteUrl: "x",
          devcontainer: null,
          allowedBackends: ["claude"],
          verifyCommand: "true",
          taskTokenBudget: 1,
          taskWallTimeSeconds: 1,
          maxConcurrentTasks: 1,
          createdAt: new Date(),
        });
        const t = setupWithCoding({
          listRepos: vi.fn(),
          insertRepo,
          getRepoByName: vi.fn(),
          countActiveTasksForRepo: vi.fn(),
          removeRepo: vi.fn(),
        });
        const res = await t.repos.add({
          name: "cogmo.notes_v2-rc1",
          localPath: "/p",
          remoteUrl: "git@x:y.git",
        });
        expect(res.isOk()).toBe(true);
      });

      it("rejects relative localPath", async () => {
        const t = freshTransport();
        const res = await t.repos.add({
          name: "cogmo",
          localPath: "relative/path",
          remoteUrl: "git@x:y.git",
        });
        const e = res._unsafeUnwrapErr();
        expect(e.code).toBe("repo_invalid_input");
        if (e.code === "repo_invalid_input") expect(e.field).toBe("localPath");
      });

      it("rejects empty remoteUrl", async () => {
        const t = freshTransport();
        const res = await t.repos.add({
          name: "cogmo",
          localPath: "/p",
          remoteUrl: "   ",
        });
        const e = res._unsafeUnwrapErr();
        expect(e.code).toBe("repo_invalid_input");
        if (e.code === "repo_invalid_input") expect(e.field).toBe("remoteUrl");
      });
    });

    it("add maps UniqueViolationError to repo_name_taken", async () => {
      const { UniqueViolationError } = await import("../agent/store/errors.js");
      const transport = setupWithCoding({
        listRepos: vi.fn(),
        insertRepo: vi.fn().mockRejectedValue(new UniqueViolationError("cogmo")),
        getRepoByName: vi.fn(),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
      });
      const res = await transport.repos.add({
        name: "cogmo",
        localPath: "/p",
        remoteUrl: "git@x:y/z.git",
      });
      expect(res._unsafeUnwrapErr()).toEqual({ code: "repo_name_taken", name: "cogmo" });
    });

    it("remove returns repo_not_found for unknown name", async () => {
      const transport = setupWithCoding({
        listRepos: vi.fn(),
        insertRepo: vi.fn(),
        getRepoByName: vi.fn().mockResolvedValue(null),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
      });
      const res = await transport.repos.remove("nope");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "repo_not_found", name: "nope" });
    });

    it("remove blocks when active tasks exist", async () => {
      const removeRepoIfIdle = vi.fn().mockResolvedValue({ kind: "in_use", activeTasks: 2 });
      const transport = setupWithCoding({
        listRepos: vi.fn(),
        insertRepo: vi.fn(),
        getRepoByName: vi.fn().mockResolvedValue({ id: "r1", name: "cogmo" }),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
        removeRepoIfIdle,
      });
      const res = await transport.repos.remove("cogmo");
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "repo_in_use",
        name: "cogmo",
        activeTasks: 2,
      });
      expect(removeRepoIfIdle).toHaveBeenCalledWith(expect.anything(), "r1");
    });

    it("remove deletes when no active tasks", async () => {
      const removeRepoIfIdle = vi.fn().mockResolvedValue({ kind: "deleted" });
      const transport = setupWithCoding({
        listRepos: vi.fn(),
        insertRepo: vi.fn(),
        getRepoByName: vi.fn().mockResolvedValue({ id: "r1", name: "cogmo" }),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
        removeRepoIfIdle,
      });
      const res = await transport.repos.remove("cogmo");
      expect(res.isOk()).toBe(true);
      expect(removeRepoIfIdle).toHaveBeenCalledWith(expect.anything(), "r1");
    });
  });

  describe("coding (plan-callback surface)", () => {
    const taskId = "019d0000-0000-7000-8000-000000000001";
    const conversationId = "019d0000-0000-7000-8000-000000000002";
    const ownerUserId = "user-owner";

    function buildTransport(args: {
      task: { conversationId: string | null } | null;
      conversation: { userId: string } | null;
      tapperUserId: string | null;
      approvePlanIfPending?: CodingStore["approvePlanIfPending"];
      cancelTaskIfActive?: CodingStore["cancelTaskIfActive"];
      inngestSend?: ReturnType<typeof vi.fn>;
    }) {
      const inngestSend = args.inngestSend ?? vi.fn().mockResolvedValue(undefined);
      const inngest = { send: inngestSend } as unknown as Parameters<
        typeof createTransport
      >[0]["inngest"];
      const transportStore = mockTransportStore({
        resolveUser: vi
          .fn()
          .mockResolvedValue(args.tapperUserId ? { userId: args.tapperUserId } : null),
      });
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue(
          args.conversation
            ? {
                id: conversationId,
                userId: args.conversation.userId,
                profileId: "p",
                isPrivate: true,
              }
            : null,
        ),
      });
      const codingStore: CodingStore = {
        ...mock<CodingStore>(),
        getTask: vi.fn().mockResolvedValue(args.task ? { id: taskId, ...args.task } : null),
        approvePlanIfPending:
          args.approvePlanIfPending ??
          vi.fn().mockResolvedValue({ kind: "approved", conversationId }),
        cancelTaskIfActive:
          args.cancelTaskIfActive ??
          vi.fn().mockResolvedValue({ kind: "cancelled", conversationId }),
      };
      const mockEvent = {
        create: vi.fn((data: unknown) => ({ name: "inbound/arrived", data })),
      } as unknown as typeof inboundArrived;
      const transport = createTransport({
        channelId: "ch-1",
        defaultUserId: ownerUserId,
        defaultProfileId: "profile-1",
        runInTx: fakeRunInTx,
        transportStore,
        agentStore,
        codingStore,
        inngest,
        inboundArrived: mockEvent,
        attachments: { upload: vi.fn(), download: vi.fn() } as unknown as Parameters<
          typeof createTransport
        >[0]["attachments"],
        idleTimeoutMs: 0,
      });
      return { transport, codingStore, inngestSend };
    }

    it("approvePlan: success path stamps approval, emits coding/task/plan-approved", async () => {
      const { transport, codingStore, inngestSend } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: ownerUserId,
      });

      const res = await transport.coding.approvePlan(taskId, "owner-tg-id");

      expect(res.isOk()).toBe(true);
      expect(codingStore.approvePlanIfPending).toHaveBeenCalledWith(
        expect.anything(),
        taskId,
        expect.any(Date),
      );
      expect(inngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "coding/task/plan-approved",
          data: expect.objectContaining({ taskId, approvedAt: expect.any(String) }),
        }),
      );
    });

    it("approvePlan: DB row and event payload carry the same approvedAt timestamp", async () => {
      // Regression for the duplicate `new Date()` calls — the event
      // claims to carry "the same timestamp downstream without a second
      // clock read", so prove the two are equal.
      const { transport, codingStore, inngestSend } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: ownerUserId,
      });

      await transport.coding.approvePlan(taskId, "owner-tg-id");

      const storeCallDate = (codingStore.approvePlanIfPending as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[2] as Date;
      const eventArg = inngestSend.mock.calls[0]?.[0] as {
        data: { approvedAt: string };
      };
      expect(storeCallDate.toISOString()).toBe(eventArg.data.approvedAt);
    });

    it("approvePlan: identity_rejected when tapper isn't the conversation owner — no store write, no event", async () => {
      const approve = vi.fn();
      const { transport, inngestSend } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: "different-user",
        approvePlanIfPending: approve,
      });

      const res = await transport.coding.approvePlan(taskId, "stranger-tg-id");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
      expect(approve).not.toHaveBeenCalled();
      expect(inngestSend).not.toHaveBeenCalled();
    });

    it("approvePlan: identity_rejected when resolveUser returns null", async () => {
      const { transport } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: null,
      });
      const res = await transport.coding.approvePlan(taskId, "ghost-tg-id");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("approvePlan: task_already_approved on double-tap", async () => {
      const { transport, inngestSend } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: ownerUserId,
        approvePlanIfPending: vi
          .fn()
          .mockResolvedValue({ kind: "already_approved", approvedAt: new Date() }),
      });

      const res = await transport.coding.approvePlan(taskId, "owner-tg-id");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "task_already_approved", taskId });
      expect(inngestSend).not.toHaveBeenCalled();
    });

    it("approvePlan: task_not_found when codingStore.getTask returns null", async () => {
      const { transport } = buildTransport({
        task: null,
        conversation: { userId: ownerUserId },
        tapperUserId: ownerUserId,
      });
      const res = await transport.coding.approvePlan(taskId, "owner-tg-id");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "task_not_found", taskId });
    });

    it("approvePlan: operation_not_permitted when task has no conversationId (automated trigger)", async () => {
      const { transport } = buildTransport({
        task: { conversationId: null },
        conversation: { userId: ownerUserId },
        tapperUserId: ownerUserId,
      });
      const res = await transport.coding.approvePlan(taskId, "owner-tg-id");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "operation_not_permitted" });
    });

    it("cancelTask: success path passes the reason through to the store", async () => {
      const cancel = vi.fn().mockResolvedValue({ kind: "cancelled", conversationId });
      const { transport } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: ownerUserId,
        cancelTaskIfActive: cancel,
      });

      const res = await transport.coding.cancelTask(taskId, "owner-tg-id", "user cancelled");
      expect(res.isOk()).toBe(true);
      expect(cancel).toHaveBeenCalledWith(expect.anything(), taskId, "user cancelled");
    });

    it("cancelTask: identity_rejected blocks store call", async () => {
      const cancel = vi.fn();
      const { transport } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: "different-user",
        cancelTaskIfActive: cancel,
      });
      const res = await transport.coding.cancelTask(taskId, "stranger-tg-id", "x");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
      expect(cancel).not.toHaveBeenCalled();
    });

    it("cancelTask: task_already_terminal when the store says so", async () => {
      const cancel = vi.fn().mockResolvedValue({ kind: "already_terminal", status: "failed" });
      const { transport } = buildTransport({
        task: { conversationId },
        conversation: { userId: ownerUserId },
        tapperUserId: ownerUserId,
        cancelTaskIfActive: cancel,
      });
      const res = await transport.coding.cancelTask(taskId, "owner-tg-id", "x");
      expect(res._unsafeUnwrapErr()).toEqual({
        code: "task_already_terminal",
        taskId,
        status: "failed",
      });
    });

    it("returns sandbox_disabled when no codingStore is supplied", async () => {
      const { transport } = setup();
      const a = await transport.coding.approvePlan(taskId, "x");
      expect(a._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
      const c = await transport.coding.cancelTask(taskId, "x", "y");
      expect(c._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
    });
  });

  describe("evolution namespace", () => {
    function buildEvolutionTransport(
      opts: {
        identity?: { userId: string } | null;
        session?: { conversationId: string } | null;
        conv?: { id: string; userId: string } | null;
        events?: ReadonlyArray<unknown>;
        event?: unknown | null;
        triggerReflection?: (id: string) => Promise<never>;
      } = {},
    ) {
      const listEvolutionEvents = vi.fn().mockResolvedValue(opts.events ?? []);
      const getEvolutionEvent = vi.fn().mockResolvedValue(opts.event ?? null);
      const getConversation = vi.fn().mockResolvedValue(opts.conv ?? null);
      const agentStore = mockAgentStore({
        listEvolutionEvents,
        getEvolutionEvent,
        getConversation,
      });
      const transportStore = mockTransportStore({
        resolveUser: vi
          .fn()
          .mockResolvedValue(opts.identity === undefined ? { userId: "user-1" } : opts.identity),
        resolveSession: vi.fn().mockResolvedValue(opts.session ?? null),
      });
      const inngestSend = vi.fn().mockResolvedValue(undefined);
      const inngest = { send: inngestSend } as never;
      const mockEvent = {
        create: vi.fn((data: unknown) => ({ name: "inbound/arrived", data })),
      } as unknown as typeof inboundArrived;
      const transport = createTransport({
        channelId: "ch-1",
        defaultUserId: "user-1",
        defaultProfileId: "profile-1",
        runInTx: fakeRunInTx,
        transportStore,
        agentStore,
        inngest,
        inboundArrived: mockEvent,
        attachments: { upload: vi.fn(), download: vi.fn() } as never,
        idleTimeoutMs: 0,
        ...(opts.triggerReflection && { triggerReflection: opts.triggerReflection }),
      });
      return { transport, listEvolutionEvents, getEvolutionEvent };
    }

    it("listEvents: rejects unknown identity", async () => {
      const { transport } = buildEvolutionTransport({ identity: null });
      const res = await transport.evolution.listEvents("ghost", { limit: 10 });
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("listEvents: returns mapped rows when identity resolves", async () => {
      const { transport, listEvolutionEvents } = buildEvolutionTransport({
        events: [
          {
            id: "evt-1",
            userId: "user-1",
            conversationId: "c1",
            triggeredBy: "idle",
            payload: {},
            createdAt: new Date(),
          },
        ],
      });
      const res = await transport.evolution.listEvents("h", { limit: 10 });
      expect(res.isOk()).toBe(true);
      expect(listEvolutionEvents).toHaveBeenCalled();
    });

    it("getEvent: returns null when no row found", async () => {
      const { transport } = buildEvolutionTransport({ event: null });
      const res = await transport.evolution.getEvent("h", "evt-x");
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toBeNull();
    });

    it("getEvent: returns identity_rejected when identity missing", async () => {
      const { transport } = buildEvolutionTransport({ identity: null });
      const res = await transport.evolution.getEvent("h", "evt-x");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    });

    it("triggerReflection: evolution_unavailable when wiring missing", async () => {
      const { transport } = buildEvolutionTransport({});
      const res = await transport.evolution.triggerReflection("h", "addr");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "evolution_unavailable" });
    });

    it("triggerReflection: identity_rejected", async () => {
      const trigger = vi.fn();
      const { transport } = buildEvolutionTransport({ identity: null, triggerReflection: trigger });
      const res = await transport.evolution.triggerReflection("h", "addr");
      expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
      expect(trigger).not.toHaveBeenCalled();
    });

    it("triggerReflection: no_session when no session", async () => {
      const trigger = vi.fn();
      const { transport } = buildEvolutionTransport({
        identity: { userId: "user-1" },
        session: null,
        triggerReflection: trigger,
      });
      const res = await transport.evolution.triggerReflection("h", "addr");
      expect(res._unsafeUnwrap()).toEqual({ status: "no_session" });
      expect(trigger).not.toHaveBeenCalled();
    });

    it("triggerReflection: no_session when conversation owner mismatches", async () => {
      const trigger = vi.fn();
      const { transport } = buildEvolutionTransport({
        identity: { userId: "user-1" },
        session: { conversationId: "c1" },
        conv: { id: "c1", userId: "other-user" },
        triggerReflection: trigger,
      });
      const res = await transport.evolution.triggerReflection("h", "addr");
      expect(res._unsafeUnwrap()).toEqual({ status: "no_session" });
      expect(trigger).not.toHaveBeenCalled();
    });

    it("triggerReflection: skipped reason passes through", async () => {
      const trigger = vi.fn().mockResolvedValue({ status: "skipped", reason: "drained_zero" });
      const { transport } = buildEvolutionTransport({
        identity: { userId: "user-1" },
        session: { conversationId: "c1" },
        conv: { id: "c1", userId: "user-1" },
        triggerReflection: trigger,
      });
      const res = await transport.evolution.triggerReflection("h", "addr");
      expect(res._unsafeUnwrap()).toEqual({ status: "skipped", reason: "drained_zero" });
    });

    it("triggerReflection: processed → emits eventId + counts", async () => {
      const trigger = vi.fn().mockResolvedValue({
        status: "processed",
        eventId: "evt-99",
        corrections: { extracted: 1, reinforced: 2, promoted: 3 },
        memories: { extracted: 4 },
        drained: { drained: 5 },
      });
      const { transport } = buildEvolutionTransport({
        identity: { userId: "user-1" },
        session: { conversationId: "c1" },
        conv: { id: "c1", userId: "user-1" },
        triggerReflection: trigger,
      });
      const res = await transport.evolution.triggerReflection("h", "addr");
      expect(res._unsafeUnwrap()).toMatchObject({
        status: "processed",
        eventId: "evt-99",
        memoryCount: 4,
        drained: 5,
        ruleChanges: { extracted: 1, reinforced: 2, promoted: 3 },
      });
    });
  });
});
