import { describe, expect, it, vi } from "vitest";
import type { inboundArrived } from "../inngest/events.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import { createTransport } from "./transport.js";

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
      expect(transportStore.resolveSession).toHaveBeenCalledWith("ch-1", "addr-1");
    });
  });

  describe("createConversation", () => {
    it("creates conversation via agentStore and session via transportStore", async () => {
      const { transport, agentStore, transportStore } = setup();

      const session = await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

      expect(agentStore.createConversation).toHaveBeenCalledWith({
        userId: "user-1",
        profileId: "profile-1",
        isPrivate: true,
      });
      expect(transportStore.createSession).toHaveBeenCalledWith(
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

      expect(ts.resolveUser).toHaveBeenCalledWith("ch-1", "handle-1");
    });
  });

  describe("closeSession", () => {
    it("delegates to transportStore", async () => {
      const { transport, transportStore } = setup();
      await transport.closeSession("session-1");
      expect(transportStore.closeSession).toHaveBeenCalledWith("session-1");
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

      expect(ts.persistInbound).toHaveBeenCalledWith({
        channelSessionId: "session-1",
        conversationId: "conv-1",
        content: "hello",
        platformTs: new Date("2026-01-01"),
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
      expect(ts.closeSession).toHaveBeenCalledWith("session-1");
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
      expect(agentStore.findConversationByAlias).toHaveBeenCalledWith("user-1", "work");
      expect(transportStore.swapSession).toHaveBeenCalledWith("ch-1", "addr-1", {
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
        getConversation: vi
          .fn()
          .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p-old", isPrivate: true }),
        getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
        setConversationProfile,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.setProfile("handle", "c1", "p-org");
      expect(res.isOk()).toBe(true);
      expect(setConversationProfile).toHaveBeenCalledWith("c1", "p-org");
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
          status: "errored",
        }),
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.repair("handle", "c1");
      expect(res._unsafeUnwrapErr()).toMatchObject({
        code: "access_denied",
        reason: expect.stringContaining("not owned"),
      });
    });

    it("flips status to active and reports wasErrored: true", async () => {
      const setConversationStatus = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          status: "errored",
        }),
        setConversationStatus,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.repair("handle", "c1");
      expect(res._unsafeUnwrap()).toEqual({ wasErrored: true });
      expect(setConversationStatus).toHaveBeenCalledWith("c1", "active");
    });

    it("is idempotent on already-active conversations and skips the write", async () => {
      const setConversationStatus = vi.fn();
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          status: "active",
        }),
        setConversationStatus,
      });
      const { transport } = setup({ agentStore });
      const res = await transport.conversations.repair("handle", "c1");
      expect(res._unsafeUnwrap()).toEqual({ wasErrored: false });
      expect(setConversationStatus).not.toHaveBeenCalled();
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
          status: "active",
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
      expect(setConversationVoiceMode).toHaveBeenCalledWith("c1", "always");
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
      expect(setConversationVoiceMode).toHaveBeenCalledWith("c1", null);
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
      expect(updateProfile).toHaveBeenCalledWith("p-mine", { memoryScope: null });
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
      expect(updateProfile).toHaveBeenCalledWith("p-mine", { memoryScope });
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
      expect(createProfile).toHaveBeenCalledWith(expect.objectContaining({ memoryScope }));
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
    function setupWithCoding(codingStore: unknown) {
      const transportStore = mockTransportStore();
      const agentStore = mockAgentStore();
      const inngestSend = vi.fn().mockResolvedValue(undefined);
      const inngest = { send: inngestSend } as unknown as Parameters<
        typeof createTransport
      >[0]["inngest"];
      const mockEvent = {
        create: vi.fn((data: unknown) => ({ name: "inbound/arrived", data })),
      } as unknown as typeof inboundArrived;
      const transport = createTransport({
        channelId: "ch-1",
        defaultUserId: "user-1",
        defaultProfileId: "profile-1",
        transportStore,
        agentStore,
        codingStore: codingStore as Parameters<typeof createTransport>[0]["codingStore"],
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
      const args = insertRepo.mock.calls[0][0];
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
      expect(removeRepoIfIdle).toHaveBeenCalledWith("r1");
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
      expect(removeRepoIfIdle).toHaveBeenCalledWith("r1");
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
      approvePlanIfPending?: ReturnType<typeof vi.fn>;
      cancelTaskIfActive?: ReturnType<typeof vi.fn>;
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
      const codingStore = {
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
        transportStore,
        agentStore,
        codingStore: codingStore as Parameters<typeof createTransport>[0]["codingStore"],
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
      expect(codingStore.approvePlanIfPending).toHaveBeenCalledWith(taskId, expect.any(Date));
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
        .calls[0]?.[1] as Date;
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
      expect(cancel).toHaveBeenCalledWith(taskId, "user cancelled");
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
});
