import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../../agent/store/index.js";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleTransportStore } from "./index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleTransportStore;
let agentStore: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleTransportStore();
  agentStore = new DrizzleAgentStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// --- Helpers ---

async function seedChannel(type = "direct"): Promise<string> {
  return (
    await tx((trx) => store.createChannel(trx, { type, credentials: {}, identityMode: "fixed" }))
  ).id;
}

let profileNameCounter = 0;
async function seedConversation(): Promise<{
  userId: string;
  profileId: string;
  conversationId: string;
}> {
  const userId = (await tx((trx) => agentStore.createUser(trx))).id;
  profileNameCounter += 1;
  const profileId = (
    await tx((trx) =>
      agentStore.createProfile(trx, {
        userId: null,
        name: `test-${profileNameCounter}`,
        basePrompt: "prompt",
        model: "model",
        toolSet: [],
      }),
    )
  ).id;
  const conversationId = (
    await tx((trx) => agentStore.createConversation(trx, { userId, profileId, isPrivate: true }))
  ).id;
  return { userId, profileId, conversationId };
}

async function seedSession(
  channelId: string,
  conversationId: string,
  platformAddress = "addr-1",
): Promise<string> {
  return (
    await tx((trx) =>
      store.createSession(trx, {
        channelId,
        platformAddress,
        conversationId,
        status: "active",
        receive: "routed",
      }),
    )
  ).id;
}

// --- Tests ---

describe("DrizzleTransportStore", () => {
  describe("channels", () => {
    it("creates and lists channels", async () => {
      await seedChannel("direct");
      await seedChannel("telegram");

      const all = await tx((trx) => store.getAllChannels(trx));
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.type).sort()).toEqual(["direct", "telegram"]);
    });

    it("finds channel by type", async () => {
      await seedChannel("direct");

      const found = await tx((trx) => store.getChannelByType(trx, "direct"));
      expect(found).toBeDefined();
      expect(found?.identityMode).toBe("fixed");
    });

    it("returns null for unknown channel type", async () => {
      expect(await tx((trx) => store.getChannelByType(trx, "nonexistent"))).toBeUndefined();
    });
  });

  describe("sessions", () => {
    it("creates and resolves a session", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "user-123");

      const session = await tx((trx) => store.resolveSession(trx, channelId, "user-123"));
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

      await tx((trx) => store.closeSession(trx, sessionId));

      expect(await tx((trx) => store.resolveSession(trx, channelId, "user-123"))).toBeUndefined();
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

      expect(
        await tx((trx) => store.resolveSession(trx, channelId, "user-expired")),
      ).toBeUndefined();
    });

    it("getSession returns by ID", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      const session = await tx((trx) => store.getSession(trx, sessionId));
      expect(session?.id).toBe(sessionId);
      expect(session?.status).toBe("active");
    });

    it("closeSession sets status to closed", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      await tx((trx) => store.closeSession(trx, sessionId));

      const session = await tx((trx) => store.getSession(trx, sessionId));
      expect(session?.status).toBe("closed");
    });

    it("getActiveSessionsForConversation returns active non-expired sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const id1 = await seedSession(channelId, conversationId, "addr-1");
      await seedSession(channelId, conversationId, "addr-2");

      // Close one
      await tx((trx) => store.closeSession(trx, id1));

      const active = await tx((trx) => store.getActiveSessionsForConversation(trx, conversationId));
      expect(active).toHaveLength(1);
      expect(active[0]?.platformAddress).toBe("addr-2");
    });

    it("swapSession closes all prior active sessions on (channelId, platformAddress) and opens a new one", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const { conversationId: conv2 } = await seedConversation();
      const oldId = await seedSession(channelId, conversationId, "addr-swap");

      const { id: newId } = await tx((trx) =>
        store.swapSession(trx, channelId, "addr-swap", {
          conversationId: conv2,
          status: "active",
          receive: "routed",
        }),
      );

      expect(newId).not.toBe(oldId);
      expect((await tx((trx) => store.getSession(trx, oldId)))?.status).toBe("closed");
      expect((await tx((trx) => store.getSession(trx, newId)))?.status).toBe("active");
      // resolveSession returns the new one (most recent)
      expect((await tx((trx) => store.resolveSession(trx, channelId, "addr-swap")))?.id).toBe(
        newId,
      );
    });

    it("swapSession works when no prior session exists on the address", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const { id } = await tx((trx) =>
        store.swapSession(trx, channelId, "fresh-addr", {
          conversationId,
          status: "active",
          receive: "routed",
        }),
      );

      expect((await tx((trx) => store.getSession(trx, id)))?.status).toBe("active");
      expect((await tx((trx) => store.resolveSession(trx, channelId, "fresh-addr")))?.id).toBe(id);
    });

    it("swapSession does not touch sessions on other addresses", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const otherId = await seedSession(channelId, conversationId, "other-addr");

      await tx((trx) =>
        store.swapSession(trx, channelId, "addr-a", {
          conversationId,
          status: "active",
          receive: "routed",
        }),
      );

      expect((await tx((trx) => store.getSession(trx, otherId)))?.status).toBe("active");
    });
  });

  describe("inbound messages", () => {
    it("persists and retrieves inbound messages", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      const { id } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "Hello",
          platformTs: new Date("2026-01-01T12:00:00Z"),
        }),
      );

      const unbatched = await tx((trx) => store.getUnbatchedInbound(trx, conversationId, null));
      expect(unbatched).toHaveLength(1);
      expect(unbatched[0]).toEqual({ id, content: "Hello" });
    });

    it("getUnbatchedInbound respects afterId cursor", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);
      const now = new Date();

      const { id: first } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "first",
          platformTs: now,
        }),
      );
      // UUIDv7 is time-ordered per millisecond — ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 2));
      await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "second",
          platformTs: now,
        }),
      );

      const after = await tx((trx) => store.getUnbatchedInbound(trx, conversationId, first));
      expect(after).toHaveLength(1);
      expect(after[0]?.content).toBe("second");
    });

    it("returns empty for no inbound messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await tx((trx) => store.getUnbatchedInbound(trx, conversationId, null))).toEqual([]);
    });
  });

  describe("getSourceSessions", () => {
    it("returns sessions that sent inbound messages in the range", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "addr-1");

      const { id: inboundId } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "hello",
          platformTs: new Date(),
        }),
      );

      const result = await tx((trx) =>
        store.getSourceSessions(trx, {
          conversationId,
          prevCursor: null,
          maxInboundId: inboundId,
        }),
      );
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

      const { id: inboundId } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: mutedSession!.id,
          conversationId,
          content: "hello",
          platformTs: new Date(),
        }),
      );

      const result = await tx((trx) =>
        store.getSourceSessions(trx, {
          conversationId,
          prevCursor: null,
          maxInboundId: inboundId,
        }),
      );
      expect(result).toHaveLength(0);
    });

    it("excludes closed sessions", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      const { id: inboundId } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "hello",
          platformTs: new Date(),
        }),
      );

      await tx((trx) => store.closeSession(trx, sessionId));

      const result = await tx((trx) =>
        store.getSourceSessions(trx, {
          conversationId,
          prevCursor: null,
          maxInboundId: inboundId,
        }),
      );
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

      const { id: inboundId } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: expiredSession!.id,
          conversationId,
          content: "hello",
          platformTs: new Date(),
        }),
      );

      const result = await tx((trx) =>
        store.getSourceSessions(trx, {
          conversationId,
          prevCursor: null,
          maxInboundId: inboundId,
        }),
      );
      expect(result).toHaveLength(0);
    });

    it("respects prevCursor lower bound", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const s1 = await seedSession(channelId, conversationId, "addr-1");
      const s2 = await seedSession(channelId, conversationId, "addr-2");

      const { id: firstInbound } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: s1,
          conversationId,
          content: "first",
          platformTs: new Date(),
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      const { id: secondInbound } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: s2,
          conversationId,
          content: "second",
          platformTs: new Date(),
        }),
      );

      // With prevCursor = firstInbound, only s2's message is in range
      const result = await tx((trx) =>
        store.getSourceSessions(trx, {
          conversationId,
          prevCursor: firstInbound,
          maxInboundId: secondInbound,
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.platformAddress).toBe("addr-2");
    });

    it("returns distinct sessions when one session has multiple messages", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId);

      await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "first",
          platformTs: new Date(),
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      const { id: lastInbound } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "second",
          platformTs: new Date(),
        }),
      );

      const result = await tx((trx) =>
        store.getSourceSessions(trx, {
          conversationId,
          prevCursor: null,
          maxInboundId: lastInbound,
        }),
      );
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

      const result = await tx((trx) => store.getReceiveAllSessions(trx, conversationId));
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

      const result = await tx((trx) => store.getReceiveAllSessions(trx, conversationId));
      expect(result).toHaveLength(0);
    });
  });

  describe("identity resolution", () => {
    it("resolves wildcard identity", async () => {
      const userId = (await tx((trx) => agentStore.createUser(trx))).id;
      const channelId = await seedChannel();

      await tx((trx) => store.createWildcardIdentity(trx, { userId, channelId }));

      const resolved = await tx((trx) => store.resolveUser(trx, channelId, "any-handle"));
      expect(resolved?.userId).toBe(userId);
    });

    it("resolves exact handle match", async () => {
      const userId = (await tx((trx) => agentStore.createUser(trx))).id;
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

      const resolved = await tx((trx) => store.resolveUser(trx, channelId, "alice"));
      expect(resolved?.userId).toBe(userId);
    });

    it("prefers wildcard over exact match", async () => {
      const wildcardUser = (await tx((trx) => agentStore.createUser(trx))).id;
      const exactUser = (await tx((trx) => agentStore.createUser(trx))).id;
      const channelId = await seedChannel();

      await tx((trx) => store.createWildcardIdentity(trx, { userId: wildcardUser, channelId }));

      const { userIdentities } = await import("./schema.js");
      await db.insert(userIdentities).values({
        userId: exactUser,
        channelId,
        platformHandle: "bob",
        isWildcard: false,
        autoCreated: false,
      });

      // Wildcard checked first in resolveUser implementation
      const resolved = await tx((trx) => store.resolveUser(trx, channelId, "bob"));
      expect(resolved?.userId).toBe(wildcardUser);
    });

    it("returns null when no identity matches", async () => {
      const channelId = await seedChannel();
      expect(await tx((trx) => store.resolveUser(trx, channelId, "unknown"))).toBeUndefined();
    });
  });

  describe("getVoiceMaxReplyChars", () => {
    it("returns null when the conversation has no active sessions", async () => {
      const { conversationId } = await seedConversation();
      expect(await tx((trx) => store.getVoiceMaxReplyChars(trx, conversationId))).toBeNull();
    });

    it("returns the default cap (700) for a single fresh channel", async () => {
      const channelId = await seedChannel("telegram");
      const { conversationId } = await seedConversation();
      await seedSession(channelId, conversationId);

      expect(await tx((trx) => store.getVoiceMaxReplyChars(trx, conversationId))).toBe(700);
    });

    it("takes the MIN cap across multiple active sessions on different channels", async () => {
      // Two channels with different caps — the min wins so the
      // most-restrictive cost ceiling is honoured.
      const ch1 = await seedChannel("telegram");
      const ch2 = await seedChannel("slack");
      await db.execute(sql`UPDATE channels SET voice_max_reply_chars = 1500 WHERE id = ${ch1}`);
      await db.execute(sql`UPDATE channels SET voice_max_reply_chars = 300 WHERE id = ${ch2}`);
      const { conversationId } = await seedConversation();
      await seedSession(ch1, conversationId, "addr-1");
      await seedSession(ch2, conversationId, "addr-2");

      expect(await tx((trx) => store.getVoiceMaxReplyChars(trx, conversationId))).toBe(300);
    });

    it("ignores closed sessions when computing the cap", async () => {
      const ch1 = await seedChannel("telegram");
      const ch2 = await seedChannel("slack");
      await db.execute(sql`UPDATE channels SET voice_max_reply_chars = 1500 WHERE id = ${ch1}`);
      await db.execute(sql`UPDATE channels SET voice_max_reply_chars = 100 WHERE id = ${ch2}`);
      const { conversationId } = await seedConversation();
      const activeSessionId = await seedSession(ch1, conversationId, "addr-1");
      const closedSessionId = await seedSession(ch2, conversationId, "addr-2");
      await tx((trx) => store.closeSession(trx, closedSessionId));
      // Active session id retained for clarity — only its channel's cap should drive the result.
      expect(activeSessionId).toBeDefined();

      // Only ch1 (1500) is active; ch2's tiny 100 is closed and excluded.
      expect(await tx((trx) => store.getVoiceMaxReplyChars(trx, conversationId))).toBe(1500);
    });
  });
});
