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

let profileNameCounter = 0;
async function seedConversation(): Promise<{
  userId: string;
  profileId: string;
  conversationId: string;
}> {
  const userId = (await agentStore.createUser()).id;
  profileNameCounter += 1;
  const profileId = (
    await agentStore.createProfile({
      userId: null,
      name: `test-${profileNameCounter}`,
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

    it("swapSession closes all prior active sessions on (channelId, platformAddress) and opens a new one", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const { conversationId: conv2 } = await seedConversation();
      const oldId = await seedSession(channelId, conversationId, "addr-swap");

      const { id: newId } = await store.swapSession(channelId, "addr-swap", {
        conversationId: conv2,
        status: "active",
        receive: "routed",
      });

      expect(newId).not.toBe(oldId);
      expect((await store.getSession(oldId))?.status).toBe("closed");
      expect((await store.getSession(newId))?.status).toBe("active");
      // resolveSession returns the new one (most recent)
      expect((await store.resolveSession(channelId, "addr-swap"))?.id).toBe(newId);
    });

    it("swapSession works when no prior session exists on the address", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const { id } = await store.swapSession(channelId, "fresh-addr", {
        conversationId,
        status: "active",
        receive: "routed",
      });

      expect((await store.getSession(id))?.status).toBe("active");
      expect((await store.resolveSession(channelId, "fresh-addr"))?.id).toBe(id);
    });

    it("swapSession does not touch sessions on other addresses", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const otherId = await seedSession(channelId, conversationId, "other-addr");

      await store.swapSession(channelId, "addr-a", {
        conversationId,
        status: "active",
        receive: "routed",
      });

      expect((await store.getSession(otherId))?.status).toBe("active");
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
      // UUIDv7 is time-ordered per millisecond — ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 2));
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

  describe("getSourceSessions", () => {
    it("returns sessions that sent inbound messages in the range", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "addr-1");

      const { id: inboundId } = await store.persistInbound({
        channelSessionId: sessionId,
        conversationId,
        content: "hello",
        platformTs: new Date(),
      });

      const result = await store.getSourceSessions({
        conversationId,
        prevCursor: null,
        maxInboundId: inboundId,
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(sessionId);
    });

    it("excludes sessions with receive='none'", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const { channelSessions: csTable } = await import("./schema.js");
      const [mutedSession] = await db
        .insert(csTable)
        .values({
          channelId,
          platformAddress: "muted-addr",
          conversationId,
          status: "active",
          receive: "none",
        })
        .returning({ id: csTable.id });

      const { id: inboundId } = await store.persistInbound({
        channelSessionId: mutedSession!.id,
        conversationId,
        content: "hello",
        platformTs: new Date(),
      });

      const result = await store.getSourceSessions({
        conversationId,
        prevCursor: null,
        maxInboundId: inboundId,
      });
      expect(result).toHaveLength(0);
    });

    it("excludes closed sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      const { id: inboundId } = await store.persistInbound({
        channelSessionId: sessionId,
        conversationId,
        content: "hello",
        platformTs: new Date(),
      });

      await store.closeSession(sessionId);

      const result = await store.getSourceSessions({
        conversationId,
        prevCursor: null,
        maxInboundId: inboundId,
      });
      expect(result).toHaveLength(0);
    });

    it("excludes expired sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const { channelSessions: csTable } = await import("./schema.js");
      const [expiredSession] = await db
        .insert(csTable)
        .values({
          channelId,
          platformAddress: "addr-expired",
          conversationId,
          status: "active",
          receive: "routed",
          expiresAt: new Date("2020-01-01"),
        })
        .returning({ id: csTable.id });

      const { id: inboundId } = await store.persistInbound({
        channelSessionId: expiredSession!.id,
        conversationId,
        content: "hello",
        platformTs: new Date(),
      });

      const result = await store.getSourceSessions({
        conversationId,
        prevCursor: null,
        maxInboundId: inboundId,
      });
      expect(result).toHaveLength(0);
    });

    it("respects prevCursor lower bound", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const s1 = await seedSession(channelId, conversationId, "addr-1");
      const s2 = await seedSession(channelId, conversationId, "addr-2");

      const { id: firstInbound } = await store.persistInbound({
        channelSessionId: s1,
        conversationId,
        content: "first",
        platformTs: new Date(),
      });
      await new Promise((r) => setTimeout(r, 2));
      const { id: secondInbound } = await store.persistInbound({
        channelSessionId: s2,
        conversationId,
        content: "second",
        platformTs: new Date(),
      });

      // With prevCursor = firstInbound, only s2's message is in range
      const result = await store.getSourceSessions({
        conversationId,
        prevCursor: firstInbound,
        maxInboundId: secondInbound,
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.platformAddress).toBe("addr-2");
    });

    it("returns distinct sessions when one session has multiple messages", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      await store.persistInbound({
        channelSessionId: sessionId,
        conversationId,
        content: "first",
        platformTs: new Date(),
      });
      await new Promise((r) => setTimeout(r, 2));
      const { id: lastInbound } = await store.persistInbound({
        channelSessionId: sessionId,
        conversationId,
        content: "second",
        platformTs: new Date(),
      });

      const result = await store.getSourceSessions({
        conversationId,
        prevCursor: null,
        maxInboundId: lastInbound,
      });
      expect(result).toHaveLength(1);
    });
  });

  describe("getReceiveAllSessions", () => {
    it("returns only receive='all' sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      // Routed session — should NOT appear
      await seedSession(channelId, conversationId, "addr-routed");

      // All session — should appear
      const { channelSessions: csTable } = await import("./schema.js");
      const [allSession] = await db
        .insert(csTable)
        .values({
          channelId,
          platformAddress: "addr-all",
          conversationId,
          status: "active",
          receive: "all",
        })
        .returning({ id: csTable.id });

      const result = await store.getReceiveAllSessions(conversationId);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(allSession!.id);
    });

    it("excludes expired sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const { channelSessions: csTable } = await import("./schema.js");
      await db.insert(csTable).values({
        channelId,
        platformAddress: "addr-expired",
        conversationId,
        status: "active",
        receive: "all",
        expiresAt: new Date("2020-01-01"),
      });

      const result = await store.getReceiveAllSessions(conversationId);
      expect(result).toHaveLength(0);
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
