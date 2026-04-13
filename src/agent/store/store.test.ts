import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "./index.js";
import { messages } from "./schema.js";

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
      model: "claude-sonnet-4-20250514",
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
        content: [{ type: "text", text: "structured" }],
        lastInboundMessageId: inboundId,
      });

      const msg = await store.getMessage(id);
      expect(msg).toEqual({ id, role: "user", content: [{ type: "text", text: "structured" }] });
    });

    it("returns null for unknown message", async () => {
      expect(await store.getMessage("019d0000-0000-7000-8000-000000000000")).toBeNull();
    });

    it("insertMessages batch inserts with tool_use/tool_result pairing", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const result = await store.insertMessages({
        conversationId,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "test" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "t1", content: "search result" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Here is the answer" }],
          },
        ],
        lastInboundMessageId: inboundId,
        lastMessageInputTokens: 500,
      });

      expect(result.id).toBeDefined();
      expect(result.id).not.toBe("");

      const history = await store.getHistory(conversationId);
      expect(history).toHaveLength(3);
      // PGlite's pg_uuidv7 uses random bits (not monotonic counter), so
      // batch-inserted rows may sort in any order. Check content regardless of position.
      const contents = history.map((m) => m.content);
      expect(contents).toContainEqual([
        { type: "tool_use", id: "t1", name: "search", input: { q: "test" } },
      ]);
      expect(contents).toContainEqual([
        { type: "tool_result", toolUseId: "t1", content: "search result" },
      ]);
      expect(contents).toContainEqual([{ type: "text", text: "Here is the answer" }]);
    });

    it("insertMessages throws on empty array", async () => {
      const { conversationId } = await seedConversation();
      await expect(
        store.insertMessages({
          conversationId,
          messages: [],
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
        }),
      ).rejects.toThrow("insertMessages requires at least one message");
    });

    it("insertMessages sets inputTokens only on the last message", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessages({
        conversationId,
        messages: [
          { role: "assistant", content: [{ type: "text", text: "first" }] },
          { role: "user", content: "follow-up" },
          { role: "assistant", content: [{ type: "text", text: "second" }] },
        ],
        lastInboundMessageId: inboundId,
        lastMessageInputTokens: 42,
      });

      // Query raw table — don't rely on UUID ordering (PGlite's pg_uuidv7
      // uses random bits, so ORDER BY id is non-deterministic within a batch)
      const rows = await db
        .select({ role: messages.role, inputTokens: messages.inputTokens })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));

      const withTokens = rows.filter((r) => r.inputTokens != null);
      expect(withTokens).toHaveLength(1);
      expect(withTokens[0]!.inputTokens).toBe(42);

      const withoutTokens = rows.filter((r) => r.inputTokens == null);
      expect(withoutTokens).toHaveLength(2);
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

    it("persists and retrieves inputTokens on assistant messages", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "response",
        lastInboundMessageId: inboundId,
        inputTokens: 5432,
      });

      const tokens = await store.getLastInputTokens(conversationId);
      expect(tokens).toBe(5432);
    });

    it("getLastInputTokens returns null when no assistant messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await store.getLastInputTokens(conversationId)).toBeNull();
    });

    it("getLastInputTokens returns most recent assistant's tokens", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "first",
        lastInboundMessageId: inboundId,
        inputTokens: 1000,
      });
      await new Promise((r) => setTimeout(r, 2));
      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "second",
        lastInboundMessageId: inboundId,
        inputTokens: 2000,
      });

      expect(await store.getLastInputTokens(conversationId)).toBe(2000);
    });

    it("insertMessage without inputTokens leaves it null", async () => {
      const { conversationId } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "no tokens",
        lastInboundMessageId: inboundId,
      });

      expect(await store.getLastInputTokens(conversationId)).toBeNull();
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

  describe("evolution: corrections", () => {
    it("getCorrections returns correction-sourced rules for profile + global", async () => {
      const profileId = await seedProfile();

      const { steeringRules } = await import("./schema.js");
      await db.insert(steeringRules).values([
        {
          rule: "Be concise",
          category: "style",
          active: false,
          source: "correction",
          priority: 100,
          observationCount: 1,
          profileId: null,
        },
        {
          rule: "Use tables for data",
          category: "style",
          active: true,
          source: "correction",
          priority: 100,
          observationCount: 2,
          profileId: null,
        },
        {
          rule: "Manual rule",
          category: "safety",
          active: true,
          source: "manual",
          priority: 1,
          observationCount: 0,
          profileId: null,
        },
      ]);

      const corrections = await store.getCorrections(profileId);
      expect(corrections).toHaveLength(2);
      expect(corrections.map((c) => c.rule)).toEqual(["Be concise", "Use tables for data"]);
    });

    it("upsertCorrection inserts new rule as inactive with observationCount 1", async () => {
      const result = await store.upsertCorrection({
        rule: "Prefer bullet points",
        category: "style",
        profileId: null,
      });

      expect(result.promoted).toBe(false);

      const { steeringRules } = await import("./schema.js");
      const rows = await db
        .select({
          rule: steeringRules.rule,
          active: steeringRules.active,
          source: steeringRules.source,
          observationCount: steeringRules.observationCount,
          priority: steeringRules.priority,
        })
        .from(steeringRules)
        .where(eq(steeringRules.id, result.id));

      expect(rows[0]).toEqual({
        rule: "Prefer bullet points",
        active: false,
        source: "correction",
        observationCount: 1,
        priority: 100,
      });
    });

    it("upsertCorrection increments existing rule without promotion when count < 2", async () => {
      // Insert a rule that's already been seen once but needs special handling
      // (observationCount will go to 2 on increment, which triggers promotion)
      // So for this test, we need a rule with observationCount = 0 (edge case)
      const { steeringRules } = await import("./schema.js");
      const [inserted] = await db
        .insert(steeringRules)
        .values({
          rule: "Test rule",
          category: "style",
          active: false,
          source: "correction",
          priority: 100,
          observationCount: 0,
        })
        .returning({ id: steeringRules.id });

      const result = await store.upsertCorrection({
        rule: "Test rule",
        category: "style",
        profileId: null,
        existingRuleId: inserted!.id,
      });

      expect(result.promoted).toBe(false);

      const rows = await db
        .select({
          observationCount: steeringRules.observationCount,
          active: steeringRules.active,
        })
        .from(steeringRules)
        .where(eq(steeringRules.id, inserted!.id));

      expect(rows[0]).toEqual({ observationCount: 1, active: false });
    });

    it("upsertCorrection graduates rule to active when observationCount reaches 2", async () => {
      // Insert with observationCount = 1 — next increment crosses the threshold
      const { steeringRules } = await import("./schema.js");
      const [inserted] = await db
        .insert(steeringRules)
        .values({
          rule: "Be concise",
          category: "style",
          active: false,
          source: "correction",
          priority: 100,
          observationCount: 1,
        })
        .returning({ id: steeringRules.id });

      const result = await store.upsertCorrection({
        rule: "Be concise",
        category: "style",
        profileId: null,
        existingRuleId: inserted!.id,
      });

      expect(result.promoted).toBe(true);

      const rows = await db
        .select({
          observationCount: steeringRules.observationCount,
          active: steeringRules.active,
        })
        .from(steeringRules)
        .where(eq(steeringRules.id, inserted!.id));

      expect(rows[0]).toEqual({ observationCount: 2, active: true });
    });

    it("upsertCorrection does not re-promote already active rule", async () => {
      const { steeringRules } = await import("./schema.js");
      const [inserted] = await db
        .insert(steeringRules)
        .values({
          rule: "Already active",
          category: "domain",
          active: true,
          source: "correction",
          priority: 100,
          observationCount: 5,
        })
        .returning({ id: steeringRules.id });

      const result = await store.upsertCorrection({
        rule: "Already active",
        category: "domain",
        profileId: null,
        existingRuleId: inserted!.id,
      });

      expect(result.promoted).toBe(false);

      const rows = await db
        .select({ observationCount: steeringRules.observationCount })
        .from(steeringRules)
        .where(eq(steeringRules.id, inserted!.id));

      expect(rows[0]!.observationCount).toBe(6);
    });

    it("countActiveRules counts global + profile-specific", async () => {
      const profileId = await seedProfile();

      const { steeringRules } = await import("./schema.js");
      await db.insert(steeringRules).values([
        {
          rule: "Global rule",
          category: "style",
          active: true,
          source: "manual",
          priority: 1,
          observationCount: 0,
          profileId: null,
        },
        {
          rule: "Profile rule",
          category: "domain",
          active: true,
          source: "correction",
          priority: 100,
          observationCount: 2,
          profileId,
        },
        {
          rule: "Inactive rule",
          category: "style",
          active: false,
          source: "correction",
          priority: 100,
          observationCount: 1,
          profileId: null,
        },
      ]);

      expect(await store.countActiveRules(profileId)).toBe(2);
    });

    it("replaceRules deletes old and inserts new atomically", async () => {
      const { steeringRules } = await import("./schema.js");
      const inserted = await db
        .insert(steeringRules)
        .values([
          {
            rule: "Rule A",
            category: "style",
            active: true,
            source: "correction",
            priority: 100,
            observationCount: 3,
          },
          {
            rule: "Rule B",
            category: "style",
            active: true,
            source: "correction",
            priority: 100,
            observationCount: 2,
          },
        ])
        .returning({ id: steeringRules.id });

      const oldIds = inserted.map((r) => r.id);

      const result = await store.replaceRules({
        oldIds,
        newRule: {
          rule: "Combined rule A+B",
          category: "style",
          profileId: null,
          priority: 100,
          observationCount: 5,
        },
      });

      // Old rules deleted
      const remaining = await db.select({ id: steeringRules.id }).from(steeringRules);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(result.id);

      // New rule has correct values
      const rows = await db
        .select({
          rule: steeringRules.rule,
          source: steeringRules.source,
          active: steeringRules.active,
          observationCount: steeringRules.observationCount,
        })
        .from(steeringRules)
        .where(eq(steeringRules.id, result.id));

      expect(rows[0]).toEqual({
        rule: "Combined rule A+B",
        source: "evolution",
        active: true,
        observationCount: 5,
      });
    });

    it("replaceRules result visible in getActiveRules", async () => {
      const profileId = await seedProfile();

      const { steeringRules } = await import("./schema.js");
      const inserted = await db
        .insert(steeringRules)
        .values([
          {
            rule: "Old rule",
            category: "style",
            active: true,
            source: "correction",
            priority: 100,
            observationCount: 2,
            profileId: null,
          },
        ])
        .returning({ id: steeringRules.id });

      await store.replaceRules({
        oldIds: [inserted[0]!.id],
        newRule: {
          rule: "New consolidated rule",
          category: "style",
          profileId: null,
          priority: 100,
          observationCount: 2,
        },
      });

      const rules = await store.getActiveRules(profileId);
      expect(rules).toEqual([{ rule: "New consolidated rule" }]);
    });
  });
});
