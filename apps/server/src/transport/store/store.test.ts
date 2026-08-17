import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../../agent/store/index.js";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleTransportStore } from "./index.js";
import { inboundMessages as inboundMessagesTable } from "./schema.js";

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
          source: "user",
        }),
      );

      const unbatched = await tx((trx) => store.getUnbatchedInbound(trx, conversationId, null));
      expect(unbatched).toHaveLength(1);
      expect(unbatched[0]).toEqual({ id, content: "Hello", source: "user" });
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
          source: "user",
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
          source: "user",
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

    it("persists a scheduled inbound and finds it by scheduledFireKey", async () => {
      const { conversationId } = await seedConversation();

      const { id } = await tx((trx) =>
        store.persistInbound(trx, {
          source: "scheduled",
          scheduledFireKey: "task-1:2026-05-14T09:00:00.000Z",
          conversationId,
          content: "morning briefing",
          platformTs: new Date("2026-05-14T09:00:00.000Z"),
        }),
      );

      const found = await tx((trx) =>
        store.findInboundByScheduledFireKey(trx, "task-1:2026-05-14T09:00:00.000Z"),
      );
      expect(found).toEqual({ id, conversationId });

      const missing = await tx((trx) =>
        store.findInboundByScheduledFireKey(trx, "task-1:2026-05-14T10:00:00.000Z"),
      );
      expect(missing).toBeUndefined();
    });

    it("rejects a second scheduled inbound with the same scheduledFireKey", async () => {
      // The partial unique index is the DB-level safety net against a
      // concurrent retry that slips past `findInboundByScheduledFireKey`.
      const { conversationId } = await seedConversation();
      const insert = (key: string) =>
        tx((trx) =>
          store.persistInbound(trx, {
            source: "scheduled",
            scheduledFireKey: key,
            conversationId,
            content: "ping",
            platformTs: new Date(),
          }),
        );

      await insert("task-1:2026-05-14T09:00:00.000Z");
      await expect(insert("task-1:2026-05-14T09:00:00.000Z")).rejects.toThrow();
    });

    it("rejects a scheduled inbound without a scheduledFireKey at the DB constraint", async () => {
      // Type narrowing prevents a TS caller from constructing this shape,
      // but the check constraint must also catch raw inserts (migrations,
      // adhoc psql, future store changes).
      const { conversationId } = await seedConversation();
      await expect(
        tx(async (trx) => {
          await trx.insert(inboundMessagesTable).values({
            source: "scheduled",
            conversationId,
            content: "ping",
            platformTs: new Date(),
          });
        }),
      ).rejects.toThrow();
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
          source: "user",
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
          source: "user",
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
          source: "user",
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
          source: "user",
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
          source: "user",
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      const { id: secondInbound } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: s2,
          conversationId,
          content: "second",
          platformTs: new Date(),
          source: "user",
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
          source: "user",
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      const { id: lastInbound } = await tx((trx) =>
        store.persistInbound(trx, {
          channelSessionId: sessionId,
          conversationId,
          content: "second",
          platformTs: new Date(),
          source: "user",
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

  describe("chat default profile", () => {
    it("returns undefined when no default is pinned", async () => {
      const channelId = await seedChannel("telegram");
      const got = await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-x"));
      expect(got).toBeUndefined();
    });

    it("sets, reads, and clears a chat default profile", async () => {
      const channelId = await seedChannel("telegram");
      const { profileId } = await seedConversation();

      await tx((trx) =>
        store.setChatDefaultProfile(trx, { channelId, platformAddress: "addr-1", profileId }),
      );

      const got = await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-1"));
      expect(got).toEqual({ profileId });

      await tx((trx) => store.clearChatDefaultProfile(trx, channelId, "addr-1"));
      expect(
        await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-1")),
      ).toBeUndefined();
    });

    it("setChatDefaultProfile is an upsert keyed on (channelId, platformAddress)", async () => {
      const channelId = await seedChannel("telegram");
      const { profileId: p1 } = await seedConversation();
      const { profileId: p2 } = await seedConversation();

      await tx((trx) =>
        store.setChatDefaultProfile(trx, {
          channelId,
          platformAddress: "addr-1",
          profileId: p1,
        }),
      );
      await tx((trx) =>
        store.setChatDefaultProfile(trx, {
          channelId,
          platformAddress: "addr-1",
          profileId: p2,
        }),
      );

      expect(await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-1"))).toEqual({
        profileId: p2,
      });
    });

    it("scopes defaults by (channelId, platformAddress)", async () => {
      const ch1 = await seedChannel("telegram");
      const ch2 = await seedChannel("slack");
      const { profileId: p1 } = await seedConversation();
      const { profileId: p2 } = await seedConversation();

      await tx((trx) =>
        store.setChatDefaultProfile(trx, {
          channelId: ch1,
          platformAddress: "addr-1",
          profileId: p1,
        }),
      );
      await tx((trx) =>
        store.setChatDefaultProfile(trx, {
          channelId: ch1,
          platformAddress: "addr-2",
          profileId: p2,
        }),
      );
      await tx((trx) =>
        store.setChatDefaultProfile(trx, {
          channelId: ch2,
          platformAddress: "addr-1",
          profileId: p2,
        }),
      );

      expect(await tx((trx) => store.getChatDefaultProfile(trx, ch1, "addr-1"))).toEqual({
        profileId: p1,
      });
      expect(await tx((trx) => store.getChatDefaultProfile(trx, ch1, "addr-2"))).toEqual({
        profileId: p2,
      });
      expect(await tx((trx) => store.getChatDefaultProfile(trx, ch2, "addr-1"))).toEqual({
        profileId: p2,
      });
    });

    it("clearChatDefaultProfile is idempotent when no row exists", async () => {
      const channelId = await seedChannel("telegram");
      await tx((trx) => store.clearChatDefaultProfile(trx, channelId, "addr-1"));
      // No throw; nothing to assert beyond reaching here.
    });

    it("cascades on channel delete — removeChannel sweeps the chat defaults with it", async () => {
      // Confirms the ON DELETE CASCADE on channel_id: removing a channel
      // (e.g. operator rotates a Telegram bot) takes its chat-default rows
      // with it, so a re-registered channel doesn't inherit stale pins.
      // removeChannel currently does manual deletes in FK order then deletes
      // the channel itself — the cascade fires on that final delete.
      const channelId = await seedChannel("telegram");
      const { profileId } = await seedConversation();
      await tx((trx) =>
        store.setChatDefaultProfile(trx, { channelId, platformAddress: "addr-1", profileId }),
      );
      await tx((trx) =>
        store.setChatDefaultProfile(trx, { channelId, platformAddress: "addr-2", profileId }),
      );

      await tx((trx) => store.removeChannel(trx, channelId));

      // Both rows should be swept by the FK cascade on the channels delete.
      // Query each address back through the store rather than poking raw SQL
      // — the public API gives us the typed assertion for free.
      expect(
        await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-1")),
      ).toBeUndefined();
      expect(
        await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-2")),
      ).toBeUndefined();
    });

    it("agentStore.deleteProfile succeeds when a chat default references the profile", async () => {
      // Integration check: deleteProfile only ref-counts conversations and
      // messages; it relies on the FK cascade on profile_id to sweep
      // chat_default_profiles. If a future change flips that FK to RESTRICT
      // (matching the profile_class pattern), deleteProfile will start
      // raising an opaque PG FK error — this test catches that regression.
      const channelId = await seedChannel("telegram");
      profileNameCounter += 1;
      const profileId = (
        await tx((trx) =>
          agentStore.createProfile(trx, {
            userId: null,
            name: `pin-only-${profileNameCounter}`,
            basePrompt: "prompt",
            model: "model",
            toolSet: [],
          }),
        )
      ).id;
      await tx((trx) =>
        store.setChatDefaultProfile(trx, { channelId, platformAddress: "addr-1", profileId }),
      );

      await tx((trx) => agentStore.deleteProfile(trx, profileId));

      // Both the profile and its chat-default binding should be gone.
      expect(
        await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-1")),
      ).toBeUndefined();
    });

    it("cascades on profile delete — affected chats unpin silently", async () => {
      // Confirms the ON DELETE CASCADE on profile_id: deleting a pinned
      // profile sweeps the binding rather than raising an FK violation,
      // so the chat falls back to the global default on the next /new.
      // Use a profile with no conversation refs (conversations.profile_id
      // is RESTRICT, so deleting through it would fail for unrelated reasons).
      const channelId = await seedChannel("telegram");
      profileNameCounter += 1;
      const profileId = (
        await tx((trx) =>
          agentStore.createProfile(trx, {
            userId: null,
            name: `pinned-only-${profileNameCounter}`,
            basePrompt: "prompt",
            model: "model",
            toolSet: [],
          }),
        )
      ).id;
      await tx((trx) =>
        store.setChatDefaultProfile(trx, { channelId, platformAddress: "addr-1", profileId }),
      );

      await db.execute(sql`DELETE FROM profiles WHERE id = ${profileId}`);

      expect(
        await tx((trx) => store.getChatDefaultProfile(trx, channelId, "addr-1")),
      ).toBeUndefined();
    });
  });

  describe("findReachableChannelsForUserProfile", () => {
    it("returns the user's reachable channel for the profile", async () => {
      const { userId, profileId, conversationId } = await seedConversation();
      const channelId = await seedChannel();
      await seedSession(channelId, conversationId, "addr-1");

      const result = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileId),
      );
      expect(result).toEqual([{ channelId, platformAddress: "addr-1", receive: "routed" }]);
    });

    it("returns an empty array when the user has no prior session for the profile", async () => {
      const { userId, profileId } = await seedConversation();

      const result = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileId),
      );
      expect(result).toEqual([]);
    });

    it("includes closed sessions — reachability is independent of conversation lifecycle", async () => {
      // A `/end`-ed Telegram chat still has a reachable chat_id; rotation
      // can swapSession onto a fresh conversation. The query is the source
      // of `(channelId, platformAddress)` tuples, not a live-session check.
      const { userId, profileId, conversationId } = await seedConversation();
      const channelId = await seedChannel();
      const sessionId = await seedSession(channelId, conversationId);
      await tx((trx) => store.closeSession(trx, sessionId));

      const result = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileId),
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.channelId).toBe(channelId);
    });

    it("excludes expired sessions (Web UI tab closed)", async () => {
      const { userId, profileId, conversationId } = await seedConversation();
      const channelId = await seedChannel();
      const sessionId = await seedSession(channelId, conversationId);
      await db.execute(
        sql`UPDATE channel_sessions SET expires_at = now() - interval '1 hour' WHERE id = ${sessionId}`,
      );

      const result = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileId),
      );
      expect(result).toEqual([]);
    });

    it("dedups on (channelId, platformAddress) — newest session's receive mode wins", async () => {
      // /new on the same chat rotates sessions: the old row is closed,
      // a fresh row is opened with the same (channelId, platformAddress).
      // The query must collapse them and return the newer `receive` mode.
      const { userId, profileId, conversationId } = await seedConversation();
      const channelId = await seedChannel();
      // First session: receive='all' (Web UI style)
      await tx((trx) =>
        store.createSession(trx, {
          channelId,
          platformAddress: "shared-addr",
          conversationId,
          status: "active",
          receive: "all",
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
      // Second session on same address: receive='routed'
      await tx((trx) =>
        store.createSession(trx, {
          channelId,
          platformAddress: "shared-addr",
          conversationId,
          status: "active",
          receive: "routed",
        }),
      );

      const result = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileId),
      );
      expect(result).toEqual([{ channelId, platformAddress: "shared-addr", receive: "routed" }]);
    });

    it("scopes by both userId AND profileId — does not leak across users", async () => {
      const a = await seedConversation();
      const b = await seedConversation();
      const channelId = await seedChannel();
      await seedSession(channelId, a.conversationId, "addr-a");
      await seedSession(channelId, b.conversationId, "addr-b");

      const result = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, a.userId, b.profileId),
      );
      expect(result).toEqual([]);
    });

    it("returns distinct channels (one per (channelId, platformAddress)) across conversations", async () => {
      // Two conversations on the same profile, each with its own Telegram
      // session — the user reached the bot from two chats. Both should
      // surface as separate reachable channels for the rotation.
      const { userId, profileId, conversationId: conv1 } = await seedConversation();
      const conv2 = (
        await tx((trx) =>
          agentStore.createConversation(trx, { userId, profileId, isPrivate: true }),
        )
      ).id;
      const channelId = await seedChannel();
      await seedSession(channelId, conv1, "chat-1");
      await seedSession(channelId, conv2, "chat-2");

      const result = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileId),
      );
      expect(result).toHaveLength(2);
      const addrs = result.map((r) => r.platformAddress).sort();
      expect(addrs).toEqual(["chat-1", "chat-2"]);
    });

    it("excludes addresses currently bound to an active session on a different profile", async () => {
      // Cross-profile hijack regression: the user historically chatted on
      // profile A via chat X, then `/new`-switched the chat to profile B.
      // Profile A's old session is closed; profile B's session is active.
      // A scheduled fire on profile A must NOT rotate chat X back onto a
      // profile-A conversation — that would close the user's active
      // profile-B session and silently switch their context.
      const userId = (await tx((trx) => agentStore.createUser(trx))).id;
      profileNameCounter += 1;
      const profileA = (
        await tx((trx) =>
          agentStore.createProfile(trx, {
            userId: null,
            name: `cross-profile-a-${profileNameCounter}`,
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      profileNameCounter += 1;
      const profileB = (
        await tx((trx) =>
          agentStore.createProfile(trx, {
            userId: null,
            name: `cross-profile-b-${profileNameCounter}`,
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      const convA = (
        await tx((trx) =>
          agentStore.createConversation(trx, { userId, profileId: profileA, isPrivate: true }),
        )
      ).id;
      const convB = (
        await tx((trx) =>
          agentStore.createConversation(trx, { userId, profileId: profileB, isPrivate: true }),
        )
      ).id;
      const channelId = await seedChannel();
      // Step 1: profile-A session on chat X, then closed (simulates /new).
      const sessionA = await seedSession(channelId, convA, "chat-X");
      await tx((trx) => store.closeSession(trx, sessionA));
      // Step 2: profile-B session on chat X is currently active.
      await seedSession(channelId, convB, "chat-X");

      const reachableForA = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileA),
      );
      // chat X is excluded: rotating would hijack the active profile-B session.
      expect(reachableForA).toEqual([]);

      // Profile B can still see chat X as its own reachable channel.
      const reachableForB = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileB),
      );
      expect(reachableForB).toHaveLength(1);
      expect(reachableForB[0]?.platformAddress).toBe("chat-X");
    });

    it("includes addresses where the other-profile session is itself closed", async () => {
      // The exclusion is keyed on an ACTIVE other-profile session. A
      // user who used profile B briefly and then closed it should not
      // permanently lose chat-X reachability on profile A.
      const userId = (await tx((trx) => agentStore.createUser(trx))).id;
      profileNameCounter += 1;
      const profileA = (
        await tx((trx) =>
          agentStore.createProfile(trx, {
            userId: null,
            name: `closed-other-a-${profileNameCounter}`,
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      profileNameCounter += 1;
      const profileB = (
        await tx((trx) =>
          agentStore.createProfile(trx, {
            userId: null,
            name: `closed-other-b-${profileNameCounter}`,
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      const convA = (
        await tx((trx) =>
          agentStore.createConversation(trx, { userId, profileId: profileA, isPrivate: true }),
        )
      ).id;
      const convB = (
        await tx((trx) =>
          agentStore.createConversation(trx, { userId, profileId: profileB, isPrivate: true }),
        )
      ).id;
      const channelId = await seedChannel();
      await seedSession(channelId, convA, "chat-X");
      const sessionB = await seedSession(channelId, convB, "chat-X");
      await tx((trx) => store.closeSession(trx, sessionB));

      const reachableForA = await tx((trx) =>
        store.findReachableChannelsForUserProfile(trx, userId, profileA),
      );
      expect(reachableForA).toHaveLength(1);
      expect(reachableForA[0]?.platformAddress).toBe("chat-X");
    });
  });

  describe("peekPriorClosedConversation", () => {
    async function seedUserMessage(
      conversationId: string,
      profileId: string,
      text: string,
    ): Promise<void> {
      await tx((trx) =>
        agentStore.insertMessage(trx, {
          conversationId,
          role: "user",
          content: text,
          profileId,
          model: "test",
          lastInboundMessageId: "00000000-0000-7000-8000-000000000000",
        }),
      );
    }

    it("returns the snapshot when the prior session is closed and meets the turn gate", async () => {
      const channelId = await seedChannel();
      const { profileId, conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "chat-A");
      for (let i = 0; i < 3; i++) {
        await seedUserMessage(conversationId, profileId, `hello world ${i}`);
      }
      await tx((trx) => store.closeSession(trx, sessionId));

      const peek = await tx((trx) =>
        store.peekPriorClosedConversation(trx, channelId, "chat-A", 3, 25),
      );
      expect(peek?.conversationId).toBe(conversationId);
      expect(peek?.userTurnCount).toBe(3);
      expect(peek?.firstUserSnippet).toBe("hello world 0");
      expect(peek?.alias).toBeNull();
      expect(peek?.lastMessageAt).toBeInstanceOf(Date);
    });

    it("returns undefined when prior has fewer than minUserTurns", async () => {
      const channelId = await seedChannel();
      const { profileId, conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "chat-B");
      await seedUserMessage(conversationId, profileId, "single message");
      await tx((trx) => store.closeSession(trx, sessionId));

      const peek = await tx((trx) =>
        store.peekPriorClosedConversation(trx, channelId, "chat-B", 3, 25),
      );
      expect(peek).toBeUndefined();
    });

    it("returns undefined when the prior session is still active", async () => {
      const channelId = await seedChannel();
      const { profileId, conversationId } = await seedConversation();
      await seedSession(channelId, conversationId, "chat-C");
      for (let i = 0; i < 3; i++) {
        await seedUserMessage(conversationId, profileId, `m${i}`);
      }

      const peek = await tx((trx) =>
        store.peekPriorClosedConversation(trx, channelId, "chat-C", 3, 25),
      );
      expect(peek).toBeUndefined();
    });

    it("returns undefined when no session exists on the address", async () => {
      const channelId = await seedChannel();
      const peek = await tx((trx) =>
        store.peekPriorClosedConversation(trx, channelId, "never-used", 3, 25),
      );
      expect(peek).toBeUndefined();
    });

    it("truncates the snippet at snippetMaxChars", async () => {
      const channelId = await seedChannel();
      const { profileId, conversationId } = await seedConversation();
      const sessionId = await seedSession(channelId, conversationId, "chat-D");
      // 2ms between inserts so uuidv7 ids sort by insertion order (random low
      // bits don't) — firstUserSnippet must resolve to the long opening message.
      await seedUserMessage(
        conversationId,
        profileId,
        "this is a very long opening message that exceeds the cap",
      );
      await new Promise((r) => setTimeout(r, 2));
      await seedUserMessage(conversationId, profileId, "two");
      await new Promise((r) => setTimeout(r, 2));
      await seedUserMessage(conversationId, profileId, "three");
      await tx((trx) => store.closeSession(trx, sessionId));

      const peek = await tx((trx) =>
        store.peekPriorClosedConversation(trx, channelId, "chat-D", 3, 10),
      );
      expect(peek?.firstUserSnippet).toHaveLength(10);
      expect(peek?.firstUserSnippet?.endsWith("…")).toBe(true);
    });
  });

  describe("boundary pending", () => {
    it("creates, fetches by address, fetches by id, appends, and deletes", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const expiresAt = new Date("2026-06-01T00:00:00Z");

      const created = await tx((trx) =>
        store.createBoundaryPending(trx, {
          channelId,
          platformAddress: "chat-7",
          platformUserHandle: "tg-user-123",
          priorConversationId: conversationId,
          promptMessageId: "tg:42",
          bufferedInbounds: [
            {
              content: "first",
              platformTs: "2026-05-19T12:00:00.000Z",
            },
          ],
          expiresAt,
        }),
      );

      const byAddr = await tx((trx) => store.getBoundaryPendingByAddress(trx, channelId, "chat-7"));
      expect(byAddr?.id).toBe(created.id);
      expect(byAddr?.platformUserHandle).toBe("tg-user-123");
      expect(byAddr?.priorConversationId).toBe(conversationId);
      expect(byAddr?.promptMessageId).toBe("tg:42");
      expect(byAddr?.bufferedInbounds).toHaveLength(1);
      expect(byAddr?.bufferedInbounds[0]?.content).toBe("first");

      await tx((trx) =>
        store.appendBoundaryBuffer(trx, created.id, {
          content: "second",
          platformTs: "2026-05-19T12:00:05.000Z",
        }),
      );

      const afterAppend = await tx((trx) => store.getBoundaryPendingById(trx, created.id));
      expect(afterAppend?.bufferedInbounds).toHaveLength(2);
      expect(afterAppend?.bufferedInbounds[1]?.content).toBe("second");

      await tx((trx) => store.deleteBoundaryPending(trx, created.id));
      expect(await tx((trx) => store.getBoundaryPendingById(trx, created.id))).toBeUndefined();
    });

    it("UNIQUE (channel_id, platform_address) allows the same address across DIFFERENT channels", async () => {
      // Invariant guard against accidental over-scoping of the unique
      // constraint: chat ids from different channels (e.g. telegram and
      // direct) can collide as opaque strings; the schema must scope per
      // channel. Without the channel_id in the uniqueness key, a user on
      // Telegram with chat-id "42" and a Direct-channel client with
      // address "42" would compete for the same boundary slot.
      const chA = await seedChannel("telegram");
      const chB = await seedChannel("direct");
      const { conversationId: convA } = await seedConversation();
      const { conversationId: convB } = await seedConversation();
      const expiresAt = new Date("2026-06-01T00:00:00Z");

      await tx((trx) =>
        store.createBoundaryPending(trx, {
          channelId: chA,
          platformAddress: "42",
          platformUserHandle: "tg-1",
          priorConversationId: convA,
          promptMessageId: "tg:1",
          bufferedInbounds: [{ content: "x", platformTs: "2026-05-19T12:00:00.000Z" }],
          expiresAt,
        }),
      );
      // Same platform_address on a DIFFERENT channel must succeed.
      await tx((trx) =>
        store.createBoundaryPending(trx, {
          channelId: chB,
          platformAddress: "42",
          platformUserHandle: "direct-1",
          priorConversationId: convB,
          promptMessageId: "d:1",
          bufferedInbounds: [{ content: "y", platformTs: "2026-05-19T12:00:00.000Z" }],
          expiresAt,
        }),
      );

      const onA = await tx((trx) => store.getBoundaryPendingByAddress(trx, chA, "42"));
      const onB = await tx((trx) => store.getBoundaryPendingByAddress(trx, chB, "42"));
      expect(onA?.priorConversationId).toBe(convA);
      expect(onB?.priorConversationId).toBe(convB);
      expect(onA?.id).not.toBe(onB?.id);
    });

    it("UNIQUE (channel_id, platform_address) rejects a second hold on the same chat", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();
      const expiresAt = new Date("2026-06-01T00:00:00Z");

      await tx((trx) =>
        store.createBoundaryPending(trx, {
          channelId,
          platformAddress: "chat-9",
          platformUserHandle: "tg-user-1",
          priorConversationId: conversationId,
          promptMessageId: "tg:1",
          bufferedInbounds: [
            {
              content: "x",
              platformTs: "2026-05-19T12:00:00.000Z",
            },
          ],
          expiresAt,
        }),
      );

      await expect(
        tx((trx) =>
          store.createBoundaryPending(trx, {
            channelId,
            platformAddress: "chat-9",
            platformUserHandle: "tg-user-2",
            priorConversationId: conversationId,
            promptMessageId: "tg:2",
            bufferedInbounds: [
              {
                content: "y",
                platformTs: "2026-05-19T12:00:01.000Z",
              },
            ],
            expiresAt,
          }),
        ),
      ).rejects.toThrow();
    });

    it("listExpiredBoundaryPending returns only rows whose expires_at < cutoff", async () => {
      const channelId = await seedChannel();
      const { conversationId } = await seedConversation();

      const past = new Date("2026-05-19T11:00:00Z");
      const future = new Date("2026-05-19T13:00:00Z");

      const expiredId = (
        await tx((trx) =>
          store.createBoundaryPending(trx, {
            channelId,
            platformAddress: "chat-old",
            platformUserHandle: "u-1",
            priorConversationId: conversationId,
            promptMessageId: "tg:1",
            bufferedInbounds: [{ content: "x", platformTs: "2026-05-19T10:00:00.000Z" }],
            expiresAt: past,
          }),
        )
      ).id;
      await tx((trx) =>
        store.createBoundaryPending(trx, {
          channelId,
          platformAddress: "chat-new",
          platformUserHandle: "u-2",
          priorConversationId: conversationId,
          promptMessageId: "tg:2",
          bufferedInbounds: [{ content: "y", platformTs: "2026-05-19T12:30:00.000Z" }],
          expiresAt: future,
        }),
      );

      const cutoff = new Date("2026-05-19T12:00:00Z");
      const expired = await tx((trx) => store.listExpiredBoundaryPending(trx, cutoff));
      expect(expired).toHaveLength(1);
      expect(expired[0]?.id).toBe(expiredId);
      expect(expired[0]?.platformAddress).toBe("chat-old");
    });

    it("appendBoundaryBuffer is a no-op for a missing id", async () => {
      await tx((trx) =>
        store.appendBoundaryBuffer(trx, "00000000-0000-7000-8000-000000000001", {
          content: "x",
          platformTs: "2026-05-19T12:00:00.000Z",
        }),
      );
      // Reaching this point without throwing is the assertion.
    });
  });
});
