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
  });

  describe("profiles.delete", () => {
    it("returns profile_in_use when conversations still reference the profile", async () => {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        countConversationsForProfile: vi.fn().mockResolvedValue(3),
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
  });

  describe("models.list", () => {
    it("delegates to agentStore.listDistinctUserSelectableModels", async () => {
      const agentStore = mockAgentStore({
        listDistinctUserSelectableModels: vi
          .fn()
          .mockResolvedValue(["claude-sonnet-4-20250514", "gpt-4o"]),
      });
      const { transport } = setup({ agentStore });
      expect(await transport.models.list()).toEqual(["claude-sonnet-4-20250514", "gpt-4o"]);
    });
  });
});
