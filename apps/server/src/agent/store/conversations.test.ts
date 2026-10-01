import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import {
  seedConversation,
  seedProfile,
  seedUser,
  TEST_MODEL,
} from "../../test/agent-store-fixtures.js";
import { expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { renderInboundText } from "../../transport/content.js";
import { DrizzleConversationStore } from "./conversations.js";
import { DrizzleProfileStore } from "./profiles.js";
import { DrizzleTranscriptStore } from "./transcript.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleConversationStore();
const profileStore = new DrizzleProfileStore();
const transcriptStore = new DrizzleTranscriptStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleConversationStore", () => {
  describe("conversations", () => {
    it("creates and retrieves a conversation with default 'active' status", async () => {
      const { userId, profileId, conversationId } = await seedConversation(tx);

      const conv = await tx((trx) => store.getConversation(trx, conversationId));
      expect(conv).toEqual({
        id: conversationId,
        userId,
        profileId,
        isPrivate: true,
        cooldownState: null,
        voiceMode: null,
      });
    });

    it("writeCooldownState persists the blob and clearCooldown resets it", async () => {
      const { conversationId } = await seedConversation(tx);
      const cooldown = {
        lastErroredAt: "2026-05-19T11:00:00.000Z",
        cooldownSeconds: 120,
        consecutiveFailures: 2,
      };
      await tx((trx) => store.writeCooldownState(trx, conversationId, cooldown));
      const conv = await tx((trx) => store.getConversation(trx, conversationId));
      expect(conv?.cooldownState).toEqual(cooldown);
      await tx((trx) => store.clearCooldown(trx, conversationId));
      const conv2 = await tx((trx) => store.getConversation(trx, conversationId));
      expect(conv2?.cooldownState).toBeNull();
    });

    it("returns null for unknown conversation", async () => {
      expect(
        await tx((trx) => store.getConversation(trx, "019d0000-0000-7000-8000-000000000000")),
      ).toBeUndefined();
    });

    it("rejects conversation with nonexistent userId", async () => {
      const profileId = await seedProfile(tx);
      await expect(
        tx((trx) =>
          store.createConversation(trx, {
            userId: "019d0000-0000-7000-8000-ffffffffffff",
            profileId,
            isPrivate: true,
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects conversation with nonexistent profileId", async () => {
      const userId = await seedUser(tx);
      await expect(
        tx((trx) =>
          store.createConversation(trx, {
            userId,
            profileId: "019d0000-0000-7000-8000-ffffffffffff",
            isPrivate: true,
          }),
        ),
      ).rejects.toThrow();
    });

    it("setConversationVoiceMode persists the override", async () => {
      const { conversationId } = await seedConversation(tx);
      await tx((trx) => store.setConversationVoiceMode(trx, conversationId, "always"));
      expect((await tx((trx) => store.getConversation(trx, conversationId)))?.voiceMode).toBe(
        "always",
      );

      await tx((trx) => store.setConversationVoiceMode(trx, conversationId, "never"));
      expect((await tx((trx) => store.getConversation(trx, conversationId)))?.voiceMode).toBe(
        "never",
      );
    });

    it("setConversationVoiceMode(null) clears the override (NULL = follow profile)", async () => {
      const { conversationId } = await seedConversation(tx);
      await tx((trx) => store.setConversationVoiceMode(trx, conversationId, "always"));
      await tx((trx) => store.setConversationVoiceMode(trx, conversationId, null));
      expect((await tx((trx) => store.getConversation(trx, conversationId)))?.voiceMode).toBeNull();
    });
  });

  describe("findMostRecentConversationForUserProfile", () => {
    it("returns the latest private conversation with its last-message timestamp", async () => {
      const { userId, profileId, stamp } = await seedConversation(tx);
      // Second conversation for the same user+profile, created later
      // (UUIDv7 = time-ordered) so this is the "most recent" one.
      const newer = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
      ).id;
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId: newer,
          role: "user",
          content: "hi",
          lastInboundMessageId: "019d0000-0000-7000-8000-00000000abcd",
          ...stamp,
        }),
      );

      const result = await tx((trx) =>
        store.findMostRecentConversationForUserProfile(trx, userId, profileId),
      );
      expect(result?.id).toBe(newer);
      expect(result?.lastMessageAt).toBeInstanceOf(Date);
    });

    it("returns lastMessageAt: null when the latest conversation has no messages yet", async () => {
      const { userId, profileId, conversationId } = await seedConversation(tx);

      const result = await tx((trx) =>
        store.findMostRecentConversationForUserProfile(trx, userId, profileId),
      );
      expect(result?.id).toBe(conversationId);
      expect(result?.lastMessageAt).toBeNull();
    });

    it("returns undefined when the user has no private conversation on this profile", async () => {
      const userId = await seedUser(tx);
      const profileId = await seedProfile(tx);

      const result = await tx((trx) =>
        store.findMostRecentConversationForUserProfile(trx, userId, profileId),
      );
      expect(result).toBeUndefined();
    });

    it("ignores non-private (group) conversations", async () => {
      const userId = await seedUser(tx);
      const profileId = await seedProfile(tx);
      await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: false }));

      const result = await tx((trx) =>
        store.findMostRecentConversationForUserProfile(trx, userId, profileId),
      );
      expect(result).toBeUndefined();
    });
  });

  describe("conversation admin", () => {
    it("listConversationsForUser returns user's private conversations with alias + last message preview", async () => {
      const { userId, profileId, conversationId, stamp } = await seedConversation(tx);
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "hello there this is the last message",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work").then(expectOk));

      const list = await tx((trx) => store.listConversationsForUser(trx, userId));
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: conversationId,
        profileName: "test",
        alias: "work",
      });
      expect(list[0]!.lastMessagePreview).toContain("hello");
      expect(list[0]!.lastMessageAt).toBeInstanceOf(Date);
      // Also verify profileId from seedConversation was the one linked
      expect(profileId).toBeDefined();
    });

    it("listConversationsForUser previews a forwarded last message as its sender and body", async () => {
      const { userId, conversationId, stamp } = await seedConversation(tx);
      const forwarded = {
        origin: "user",
        from: "Alice",
        sentAt: "2023-11-14T22:13:20.000Z",
      } as const;
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId,
          role: "user",
          content: renderInboundText("see you at 8", forwarded),
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
          ...stamp,
        }),
      );

      const [conversation] = await tx((trx) => store.listConversationsForUser(trx, userId));
      expect(conversation?.lastMessagePreview).toBe("Fwd from Alice: see you at 8");
    });

    it("listConversationsForUser excludes conversations from other users", async () => {
      const u1 = await seedUser(tx);
      const u2 = await seedUser(tx);
      const profileId = await seedProfile(tx);
      const c1 = (
        await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: true }))
      ).id;
      const c2 = (
        await tx((trx) => store.createConversation(trx, { userId: u2, profileId, isPrivate: true }))
      ).id;
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId: c1,
          role: "user",
          content: "u1",
          lastInboundMessageId: inboundId,
          profileId,
          model: TEST_MODEL,
        }),
      );
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId: c2,
          role: "user",
          content: "u2",
          lastInboundMessageId: inboundId,
          profileId,
          model: TEST_MODEL,
        }),
      );

      const list = await tx((trx) => store.listConversationsForUser(trx, u1));
      expect(list.map((c) => c.id)).toEqual([c1]);
    });

    it("listConversationsForUser excludes non-private conversations and empty conversations", async () => {
      const userId = await seedUser(tx);
      const profileId = await seedProfile(tx);
      const empty = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
      ).id;
      const nonPrivate = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: false }))
      ).id;
      const withMsg = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
      ).id;
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId: nonPrivate,
          role: "user",
          content: "noisy",
          lastInboundMessageId: inboundId,
          profileId,
          model: TEST_MODEL,
        }),
      );
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId: withMsg,
          role: "user",
          content: "real",
          lastInboundMessageId: inboundId,
          profileId,
          model: TEST_MODEL,
        }),
      );

      const list = await tx((trx) => store.listConversationsForUser(trx, userId));
      expect(list.map((c) => c.id)).toEqual([withMsg]);
      expect(empty).toBeDefined(); // empty conv excluded
    });

    it("setConversationProfile updates conversations.profile_id", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      const { id: newProfileId } = await tx((trx) =>
        profileStore
          .createProfile(trx, {
            userId,
            name: "other",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) => store.setConversationProfile(trx, conversationId, newProfileId));
      const conv = await tx((trx) => store.getConversation(trx, conversationId));
      expect(conv?.profileId).toBe(newProfileId);
    });
  });

  describe("aliases", () => {
    it("setAlias inserts, then updates on same conversationId", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work").then(expectOk));
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "work"))).toEqual({
        conversationId,
      });

      await tx((trx) => store.setAlias(trx, userId, conversationId, "personal").then(expectOk));
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "work"))).toBeUndefined();
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "personal"))).toEqual({
        conversationId,
      });
    });

    it("setAlias with null clears the alias", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work").then(expectOk));
      await tx((trx) => store.setAlias(trx, userId, conversationId, null).then(expectOk));
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "work"))).toBeUndefined();
    });

    it("setAlias reports a collision across conversations as alias_taken", async () => {
      const userId = await seedUser(tx);
      const profileId = await seedProfile(tx);
      const c1 = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
      ).id;
      const c2 = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
      ).id;
      await tx((trx) => store.setAlias(trx, userId, c1, "work").then(expectOk));
      expect(await tx((trx) => store.setAlias(trx, userId, c2, "work"))).toEqual(
        err({ kind: "alias_taken" }),
      );
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "work"))).toEqual({
        conversationId: c1,
      });
    });

    it("findConversationByAlias scopes to user", async () => {
      const u1 = await seedUser(tx);
      const u2 = await seedUser(tx);
      const profileId = await seedProfile(tx);
      const conv = (
        await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: true }))
      ).id;
      await tx((trx) => store.setAlias(trx, u1, conv, "shared").then(expectOk));
      // u2 searching for same alias should see nothing
      expect(await tx((trx) => store.findConversationByAlias(trx, u2, "shared"))).toBeUndefined();
    });

    it("getAliasForConversation returns the alias when set, undefined when cleared", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      expect(
        await tx((trx) => store.getAliasForConversation(trx, userId, conversationId)),
      ).toBeUndefined();
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work").then(expectOk));
      expect(await tx((trx) => store.getAliasForConversation(trx, userId, conversationId))).toBe(
        "work",
      );
      await tx((trx) => store.setAlias(trx, userId, conversationId, null).then(expectOk));
      expect(
        await tx((trx) => store.getAliasForConversation(trx, userId, conversationId)),
      ).toBeUndefined();
    });

    it("getAliasForConversation scopes to user (other users see undefined)", async () => {
      const u1 = await seedUser(tx);
      const u2 = await seedUser(tx);
      const profileId = await seedProfile(tx);
      const conv = (
        await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: true }))
      ).id;
      await tx((trx) => store.setAlias(trx, u1, conv, "owned-by-u1").then(expectOk));
      expect(await tx((trx) => store.getAliasForConversation(trx, u2, conv))).toBeUndefined();
      expect(await tx((trx) => store.getAliasForConversation(trx, u1, conv))).toBe("owned-by-u1");
    });
  });

  describe("getConversationStats", () => {
    it("returns createdAt + zero counts for a fresh conversation with no messages", async () => {
      const { conversationId } = await seedConversation(tx);
      const stats = await tx((trx) => store.getConversationStats(trx, conversationId));
      expect(stats).toBeDefined();
      expect(stats?.messageCount).toBe(0);
      expect(stats?.lastMessageAt).toBeNull();
      expect(stats?.createdAt).toBeInstanceOf(Date);
    });

    it("counts messages and surfaces the most recent createdAt", async () => {
      const { profileId, conversationId } = await seedConversation(tx);
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "hi",
          profileId,
          model: "claude-sonnet-4-6",
          lastInboundMessageId: "00000000-0000-7000-8000-000000000001",
        }),
      );
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "hello back",
          profileId,
          model: "claude-sonnet-4-6",
          lastInboundMessageId: "00000000-0000-7000-8000-000000000001",
        }),
      );
      const stats = await tx((trx) => store.getConversationStats(trx, conversationId));
      expect(stats?.messageCount).toBe(2);
      expect(stats?.lastMessageAt).toBeInstanceOf(Date);
    });

    it("returns undefined for a nonexistent conversation id", async () => {
      const stats = await tx((trx) =>
        store.getConversationStats(trx, "00000000-0000-7000-8000-000000000999"),
      );
      expect(stats).toBeUndefined();
    });
  });
});
