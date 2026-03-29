import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../../agent/store/index.js";
import type { Database } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleTransportStore } from "./index.js";

let db: Database;
let close: () => Promise<void>;
let store: DrizzleTransportStore;
let agentStore: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleTransportStore(db);
  agentStore = new DrizzleAgentStore(db);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// --- Helpers ---

async function seedChannel(type = "direct"): Promise<string> {
  return (await store.createChannel({ type, credentials: {}, identityMode: "fixed" })).id;
}

async function seedConversation(): Promise<{
  userId: string;
  profileId: string;
  conversationId: string;
}> {
  const userId = (await agentStore.createUser()).id;
  const profileId = (
    await agentStore.createProfile({
      name: "test",
      basePrompt: "prompt",
      model: "model",
      toolSet: [],
    })
  ).id;
  const conversationId = (
    await agentStore.createConversation({ userId, profileId, isPrivate: true })
  ).id;
  return { userId, profileId, conversationId };
}

async function seedSession(
  channelId: string,
  conversationId: string,
  platformAddress = "addr-1",
): Promise<string> {
  return (
    await store.createSession({
      channelId,
      platformAddress,
      conversationId,
      status: "active",
      receive: "routed",
    })
  ).id;
}

// --- Tests ---

describe("DrizzleTransportStore", () => {
  describe("channels", () => {
    it("creates and lists channels", async () => {
      await seedChannel("direct");
      await seedChannel("telegram");

      const all = await store.getAllChannels();
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.type).sort()).toEqual(["direct", "telegram"]);
    });

    it("finds channel by type", async () => {
      await seedChannel("direct");

      const found = await store.getChannelByType("direct");
      expect(found).toBeDefined();
      expect(found?.identityMode).toBe("fixed");
    });

    it("returns null for unknown channel type", async () => {
      expect(await store.getChannelByType("nonexistent")).toBeNull();
    });
  });

  describe("sessions", () => {
    it("creates and resolves a session", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "user-123");

      const session = await store.resolveSession(channelId, "user-123");
      expect(session).toEqual({
        id: sessionId,
        channelId,
        platformAddress: "user-123",
        conversationId,
        status: "active",
        receive: "routed",
      });
    });

    it("resolveSession ignores closed sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "user-123");

      await store.closeSession(sessionId);

      expect(await store.resolveSession(channelId, "user-123")).toBeNull();
    });

    it("resolveSession ignores expired sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      // Insert an expired session via raw db
      const { channelSessions } = await import("./schema.js");
      await db.insert(channelSessions).values({
        channelId,
        platformAddress: "user-expired",
        conversationId,
        status: "active",
        receive: "routed",
        expiresAt: new Date("2020-01-01"),
      });

      expect(await store.resolveSession(channelId, "user-expired")).toBeNull();
    });

    it("getSession returns by ID", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      const session = await store.getSession(sessionId);
      expect(session?.id).toBe(sessionId);
      expect(session?.status).toBe("active");
    });

    it("closeSession sets status to closed", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      await store.closeSession(sessionId);

      const session = await store.getSession(sessionId);
      expect(session?.status).toBe("closed");
    });

    it("getActiveSessionsForConversation returns active non-expired sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const id1 = await seedSession(channelId, conversationId, "addr-1");
      await seedSession(channelId, conversationId, "addr-2");

      // Close one
      await store.closeSession(id1);

      const active = await store.getActiveSessionsForConversation(conversationId);
      expect(active).toHaveLength(1);
      expect(active[0]?.platformAddress).toBe("addr-2");
    });
  });

  describe("inbound messages", () => {
    it("persists and retrieves inbound messages", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      const { id } = await store.persistInbound({
        channelSessionId: sessionId,
        conversationId,
        content: "Hello",
        platformTs: new Date("2026-01-01T12:00:00Z"),
      });

      const unbatched = await store.getUnbatchedInbound(conversationId, null);
      expect(unbatched).toHaveLength(1);
      expect(unbatched[0]).toEqual({ id, content: "Hello" });
    });

    it("getUnbatchedInbound respects afterId cursor", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);
      const now = new Date();

      const { id: first } = await store.persistInbound({
        channelSessionId: sessionId,
        conversationId,
        content: "first",
        platformTs: now,
      });
      await store.persistInbound({
        channelSessionId: sessionId,
        conversationId,
        content: "second",
        platformTs: now,
      });

      const after = await store.getUnbatchedInbound(conversationId, first);
      expect(after).toHaveLength(1);
      expect(after[0]?.content).toBe("second");
    });

    it("returns empty for no inbound messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await store.getUnbatchedInbound(conversationId, null)).toEqual([]);
    });
  });

  describe("identity resolution", () => {
    it("resolves wildcard identity", async () => {
      const userId = (await agentStore.createUser()).id;
      const channelId = await seedChannel();

      await store.createWildcardIdentity({ userId, channelId });

      const resolved = await store.resolveUser(channelId, "any-handle");
      expect(resolved?.userId).toBe(userId);
    });

    it("resolves exact handle match", async () => {
      const userId = (await agentStore.createUser()).id;
      const channelId = await seedChannel();

      // Insert exact identity via raw db (store only exposes wildcard creation)
      const { userIdentities } = await import("./schema.js");
      await db.insert(userIdentities).values({
        userId,
        channelId,
        platformHandle: "alice",
        isWildcard: false,
        autoCreated: false,
      });

      const resolved = await store.resolveUser(channelId, "alice");
      expect(resolved?.userId).toBe(userId);
    });

    it("prefers wildcard over exact match", async () => {
      const wildcardUser = (await agentStore.createUser()).id;
      const exactUser = (await agentStore.createUser()).id;
      const channelId = await seedChannel();

      await store.createWildcardIdentity({ userId: wildcardUser, channelId });

      const { userIdentities } = await import("./schema.js");
      await db.insert(userIdentities).values({
        userId: exactUser,
        channelId,
        platformHandle: "bob",
        isWildcard: false,
        autoCreated: false,
      });

      // Wildcard checked first in resolveUser implementation
      const resolved = await store.resolveUser(channelId, "bob");
      expect(resolved?.userId).toBe(wildcardUser);
    });

    it("returns null when no identity matches", async () => {
      const channelId = await seedChannel();
      expect(await store.resolveUser(channelId, "unknown")).toBeNull();
    });
  });
});
