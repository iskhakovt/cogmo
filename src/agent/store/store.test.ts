import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "./index.js";

let db: Database;
let close: () => Promise<void>;
let store: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleAgentStore(db);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// --- Helpers ---

async function seedUser(): Promise<string> {
  return (await store.createUser()).id;
}

async function seedProfile(): Promise<string> {
  return (
    await store.createProfile({
      name: "test",
      basePrompt: "You are a test assistant.",
      model: "test-model",
      toolSet: ["tool_a"],
    })
  ).id;
}

async function seedConversation(): Promise<{
  userId: string;
  profileId: string;
  conversationId: string;
}> {
  const userId = await seedUser();
  const profileId = await seedProfile();
  const conversationId = (await store.createConversation({ userId, profileId, isPrivate: true }))
    .id;
  return { userId, profileId, conversationId };
}

// --- Tests ---

describe("DrizzleAgentStore", () => {
  describe("users", () => {
    it("creates a user and retrieves it", async () => {
      const { id } = await store.createUser();
      expect(id).toBeDefined();

      const first = await store.getFirstUser();
      expect(first?.id).toBe(id);
    });

    it("returns null when no users exist", async () => {
      expect(await store.getFirstUser()).toBeNull();
    });
  });

  describe("profiles", () => {
    it("creates and retrieves a profile", async () => {
      const { id } = await store.createProfile({
        name: "main",
        basePrompt: "Be helpful.",
        model: "claude-test",
        toolSet: ["memory_recall"],
      });

      const profile = await store.getProfile(id);
      expect(profile).toEqual({
        id,
        basePrompt: "Be helpful.",
        model: "claude-test",
        toolSet: ["memory_recall"],
      });
    });

    it("returns null for unknown profile", async () => {
      expect(await store.getProfile("019d0000-0000-7000-8000-000000000000")).toBeNull();
    });

    it("getDefaultProfile returns first profile", async () => {
      expect(await store.getDefaultProfile()).toBeNull();
      const { id } = await store.createProfile({
        name: "default",
        basePrompt: "prompt",
        model: "m",
        toolSet: [],
      });
      expect((await store.getDefaultProfile())?.id).toBe(id);
    });

    it("enforces unique profile name", async () => {
      await store.createProfile({ name: "dup", basePrompt: "p", model: "m", toolSet: [] });
      await expect(
        store.createProfile({ name: "dup", basePrompt: "p2", model: "m2", toolSet: [] }),
      ).rejects.toThrow();
    });
  });

  describe("conversations", () => {
    it("creates and retrieves a conversation", async () => {
      const { userId, profileId, conversationId } = await seedConversation();

      const conv = await store.getConversation(conversationId);
      expect(conv).toEqual({ id: conversationId, userId, profileId, isPrivate: true });
    });

    it("returns null for unknown conversation", async () => {
      expect(await store.getConversation("019d0000-0000-7000-8000-000000000000")).toBeNull();
    });

    it("rejects conversation with nonexistent userId", async () => {
      const profileId = await seedProfile();
      await expect(
        store.createConversation({
          userId: "019d0000-0000-7000-8000-ffffffffffff",
          profileId,
          isPrivate: true,
        }),
      ).rejects.toThrow();
    });

    it("rejects conversation with nonexistent profileId", async () => {
      const userId = await seedUser();
      await expect(
        store.createConversation({
          userId,
          profileId: "019d0000-0000-7000-8000-ffffffffffff",
          isPrivate: true,
        }),
      ).rejects.toThrow();
    });
  });

  describe("messages", () => {
    it("inserts and retrieves messages in order", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "user",
        content: "Hello",
        lastInboundMessageId: inboundId,
      });
      // 2ms sleep — PGlite's pg_uuidv7 uses random bits, not monotonic counter
      await new Promise((r) => setTimeout(r, 2));
      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "Hi there",
        lastInboundMessageId: inboundId,
      });

      const history = await store.getHistory(conversationId);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: "user", content: "Hello" });
      expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
    });

    it("getMessage returns a single message", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const { id } = await store.insertMessage({
        conversationId,
        role: "user",
        content: { text: "structured" },
        lastInboundMessageId: inboundId,
      });

      const msg = await store.getMessage(id);
      expect(msg).toEqual({ id, role: "user", content: { text: "structured" } });
    });

    it("returns null for unknown message", async () => {
      expect(await store.getMessage("019d0000-0000-7000-8000-000000000000")).toBeNull();
    });

    it("getLastAssistantMessage returns most recent", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      expect(await store.getLastAssistantMessage(conversationId)).toBeNull();

      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "first",
        lastInboundMessageId: inboundId,
      });
      // UUIDv7 is time-ordered per millisecond — ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 2));
      const { id: secondId } = await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "second",
        lastInboundMessageId: inboundId,
      });

      const last = await store.getLastAssistantMessage(conversationId);
      expect(last?.id).toBe(secondId);
      expect(last?.lastInboundMessageId).toBe(inboundId);
    });

    it("getHistory returns empty array for no messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await store.getHistory(conversationId)).toEqual([]);
    });
  });

  describe("steering rules", () => {
    it("returns active rules for profile + global, ordered by priority", async () => {
      const profileId = await seedProfile();
      const otherProfileId = (
        await store.createProfile({ name: "other", basePrompt: "p", model: "m", toolSet: [] })
      ).id;

      // Insert rules via raw db since store doesn't expose createRule
      const { steeringRules } = await import("./schema.js");
      await db.insert(steeringRules).values([
        {
          rule: "Be concise",
          category: "style",
          active: true,
          source: "manual",
          priority: 2,
          observationCount: 0,
          profileId,
        },
        {
          rule: "Global safety rule",
          category: "safety",
          active: true,
          source: "manual",
          priority: 1,
          observationCount: 0,
          profileId: null,
        },
        {
          rule: "Inactive rule",
          category: "style",
          active: false,
          source: "manual",
          priority: 0,
          observationCount: 0,
          profileId,
        },
        {
          rule: "Other profile rule",
          category: "domain",
          active: true,
          source: "manual",
          priority: 0,
          observationCount: 0,
          profileId: otherProfileId,
        },
      ]);

      const rules = await store.getActiveRules(profileId);
      expect(rules).toEqual([{ rule: "Global safety rule" }, { rule: "Be concise" }]);
    });

    it("returns empty array when no active rules", async () => {
      const profileId = await seedProfile();
      expect(await store.getActiveRules(profileId)).toEqual([]);
    });
  });

  describe("core memory blocks", () => {
    it("upsert creates a new block", async () => {
      const userId = await seedUser();
      await store.upsertCoreMemoryBlock({ userId, key: "user_profile", content: "Name: Tim" });

      const blocks = await store.getCoreMemoryBlocks(userId);
      expect(blocks).toEqual([{ key: "user_profile", content: "Name: Tim" }]);
    });

    it("upsert updates existing block", async () => {
      const userId = await seedUser();
      await store.upsertCoreMemoryBlock({ userId, key: "user_profile", content: "Name: Tim" });
      await store.upsertCoreMemoryBlock({
        userId,
        key: "user_profile",
        content: "Name: Tim\nRole: Engineer",
      });

      const blocks = await store.getCoreMemoryBlocks(userId);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.content).toBe("Name: Tim\nRole: Engineer");
    });

    it("returns blocks ordered by key", async () => {
      const userId = await seedUser();
      await store.upsertCoreMemoryBlock({ userId, key: "preferences", content: "Dark mode" });
      await store.upsertCoreMemoryBlock({ userId, key: "active_projects", content: "Assistant" });
      await store.upsertCoreMemoryBlock({ userId, key: "user_profile", content: "Tim" });

      const blocks = await store.getCoreMemoryBlocks(userId);
      expect(blocks.map((b) => b.key)).toEqual(["active_projects", "preferences", "user_profile"]);
    });

    it("returns empty array for unknown user", async () => {
      const blocks = await store.getCoreMemoryBlocks("00000000-0000-0000-0000-000000000000");
      expect(blocks).toEqual([]);
    });
  });

  describe("getLastMessageTime", () => {
    it("returns the most recent message timestamp", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "user",
        content: "hello",
        lastInboundMessageId: inboundId,
      });

      const time = await store.getLastMessageTime(conversationId);
      expect(time).toBeInstanceOf(Date);
    });

    it("returns null for conversation with no messages", async () => {
      const { conversationId } = await seedConversation();
      const time = await store.getLastMessageTime(conversationId);
      expect(time).toBeNull();
    });
  });
});
