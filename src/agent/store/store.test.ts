import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../../secrets/encryption.js";
import { DrizzleSecretsStore } from "../../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "./index.js";
import { messages } from "./schema.js";

let db: Database;
let close: () => Promise<void>;
let store: DrizzleAgentStore;
let secretsStore: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleAgentStore(db);
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(db, key);
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

const TEST_MODEL = "claude-sonnet-4-6";

async function seedProfile(): Promise<string> {
  return (
    await store.createProfile({
      userId: null,
      name: "test",
      basePrompt: "You are a test assistant.",
      model: TEST_MODEL,
      toolSet: ["tool_a"],
    })
  ).id;
}

async function seedConversation(): Promise<{
  userId: string;
  profileId: string;
  conversationId: string;
  /** Convenience — spread into insertMessage/insertMessages to stamp the turn. */
  stamp: { profileId: string; model: string };
}> {
  const userId = await seedUser();
  const profileId = await seedProfile();
  const conversationId = (await store.createConversation({ userId, profileId, isPrivate: true }))
    .id;
  return { userId, profileId, conversationId, stamp: { profileId, model: TEST_MODEL } };
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
      expect(await store.getFirstUser()).toBeUndefined();
    });
  });

  describe("profiles", () => {
    it("creates and retrieves a profile", async () => {
      const { id } = await store.createProfile({
        userId: null,
        name: "main",
        basePrompt: "Be helpful.",
        model: "claude-test",
        toolSet: ["memory_recall"],
      });

      const profile = await store.getProfile(id);
      expect(profile).toEqual({
        id,
        userId: null,
        name: "main",
        basePrompt: "Be helpful.",
        model: "claude-test",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: ["memory_recall"],
        memoryScope: null,
      });
    });

    it("returns null for unknown profile", async () => {
      expect(await store.getProfile("019d0000-0000-7000-8000-000000000000")).toBeUndefined();
    });

    it("getDefaultProfile returns first profile", async () => {
      expect(await store.getDefaultProfile()).toBeUndefined();
      const { id } = await store.createProfile({
        userId: null,
        name: "default",
        basePrompt: "prompt",
        model: "m",
        toolSet: [],
      });
      expect((await store.getDefaultProfile())?.id).toBe(id);
    });

    it("enforces unique org profile name (user_id null)", async () => {
      await store.createProfile({
        userId: null,
        name: "dup",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      await expect(
        store.createProfile({
          userId: null,
          name: "dup",
          basePrompt: "p2",
          model: "m2",
          toolSet: [],
        }),
      ).rejects.toThrow();
    });

    it("allows same name across different users (and between org and user)", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      await store.createProfile({
        userId: null,
        name: "coder",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      await store.createProfile({
        userId: u1,
        name: "coder",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      await store.createProfile({
        userId: u2,
        name: "coder",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      // No throw — same name is allowed when (user_id, name) differs.
    });

    it("rejects duplicate name within the same user", async () => {
      const u = await seedUser();
      await store.createProfile({
        userId: u,
        name: "mine",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      await expect(
        store.createProfile({
          userId: u,
          name: "mine",
          basePrompt: "p2",
          model: "m2",
          toolSet: [],
        }),
      ).rejects.toThrow();
    });
  });

  describe("conversations", () => {
    it("creates and retrieves a conversation with default 'active' status", async () => {
      const { userId, profileId, conversationId } = await seedConversation();

      const conv = await store.getConversation(conversationId);
      expect(conv).toEqual({
        id: conversationId,
        userId,
        profileId,
        isPrivate: true,
        status: "active",
        voiceMode: null,
      });
    });

    it("setConversationStatus flips status and getConversation reflects it", async () => {
      const { conversationId } = await seedConversation();
      await store.setConversationStatus(conversationId, "errored");
      const conv = await store.getConversation(conversationId);
      expect(conv?.status).toBe("errored");
      // Reversibility — future `/repair` (or manual psql) flips back
      await store.setConversationStatus(conversationId, "active");
      const conv2 = await store.getConversation(conversationId);
      expect(conv2?.status).toBe("active");
    });

    it("returns null for unknown conversation", async () => {
      expect(await store.getConversation("019d0000-0000-7000-8000-000000000000")).toBeUndefined();
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

    it("setConversationVoiceMode persists the override", async () => {
      const { conversationId } = await seedConversation();
      await store.setConversationVoiceMode(conversationId, "always");
      expect((await store.getConversation(conversationId))?.voiceMode).toBe("always");

      await store.setConversationVoiceMode(conversationId, "never");
      expect((await store.getConversation(conversationId))?.voiceMode).toBe("never");
    });

    it("setConversationVoiceMode(null) clears the override (NULL = follow profile)", async () => {
      const { conversationId } = await seedConversation();
      await store.setConversationVoiceMode(conversationId, "always");
      await store.setConversationVoiceMode(conversationId, null);
      expect((await store.getConversation(conversationId))?.voiceMode).toBeNull();
    });
  });

  describe("messages", () => {
    it("inserts and retrieves messages in order", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "user",
        content: "Hello",
        lastInboundMessageId: inboundId,
        ...stamp,
      });
      // 2ms sleep — PGlite's pg_uuidv7 uses random bits, not monotonic counter
      await new Promise((r) => setTimeout(r, 2));
      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "Hi there",
        lastInboundMessageId: inboundId,
        ...stamp,
      });

      const history = await store.getHistory(conversationId);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: "user", content: "Hello" });
      expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
    });

    it("getMessage returns a single message", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const { id } = await store.insertMessage({
        conversationId,
        role: "user",
        content: [{ type: "text", text: "structured" }],
        lastInboundMessageId: inboundId,
        ...stamp,
      });

      const msg = await store.getMessage(id);
      expect(msg).toEqual({ id, role: "user", content: [{ type: "text", text: "structured" }] });
    });

    it("returns null for unknown message", async () => {
      expect(await store.getMessage("019d0000-0000-7000-8000-000000000000")).toBeUndefined();
    });

    it("insertMessages batch inserts with tool_use/tool_result pairing", async () => {
      const { conversationId, stamp } = await seedConversation();
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
        lastMessageOutputTokens: 120,
        ...stamp,
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
      const { conversationId, stamp } = await seedConversation();
      await expect(
        store.insertMessages({
          conversationId,
          messages: [],
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
          lastMessageOutputTokens: 0,
          ...stamp,
        }),
      ).rejects.toThrow("insertMessages requires at least one message");
    });

    it("insertMessages writes token counts onto the last message only", async () => {
      const { conversationId, stamp } = await seedConversation();
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
        lastMessageOutputTokens: 7,
        ...stamp,
      });

      // Query raw table — don't rely on UUID ordering (PGlite's pg_uuidv7
      // uses random bits, so ORDER BY id is non-deterministic within a batch)
      const rows = await db
        .select({
          role: messages.role,
          inputTokens: messages.inputTokens,
          outputTokens: messages.outputTokens,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));

      // Only one row carries real token counts — the final assistant reply.
      const finalRow = rows.find((r) => r.inputTokens != null);
      expect(finalRow).toBeDefined();
      expect(finalRow!.inputTokens).toBe(42);
      expect(finalRow!.outputTokens).toBe(7);

      // Non-final rows: inputTokens null, outputTokens is the -1 sentinel.
      const otherRows = rows.filter((r) => r.inputTokens == null);
      expect(otherRows).toHaveLength(2);
      for (const r of otherRows) {
        expect(r.outputTokens).toBe(-1);
      }
    });

    it("getLastAssistantMessage returns most recent", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      expect(await store.getLastAssistantMessage(conversationId)).toBeUndefined();

      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "first",
        lastInboundMessageId: inboundId,
        ...stamp,
      });
      // UUIDv7 is time-ordered per millisecond — ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 2));
      const { id: secondId } = await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "second",
        lastInboundMessageId: inboundId,
        ...stamp,
      });

      const last = await store.getLastAssistantMessage(conversationId);
      expect(last?.id).toBe(secondId);
      expect(last?.lastInboundMessageId).toBe(inboundId);
    });

    it("getHistory returns empty array for no messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await store.getHistory(conversationId)).toEqual([]);
    });

    it("insertMessages persists both token counts and getLastTokens returns them", async () => {
      // After a turn with input=N, output=M, getLastTokens should report
      // both — the fast path needs both terms to estimate next-turn input.
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessages({
        conversationId,
        messages: [{ role: "assistant", content: [{ type: "text", text: "response" }] }],
        lastInboundMessageId: inboundId,
        lastMessageInputTokens: 5432,
        lastMessageOutputTokens: 321,
        ...stamp,
      });

      expect(await store.getLastTokens(conversationId)).toEqual({
        inputTokens: 5432,
        outputTokens: 321,
      });
    });

    it("getLastTokens returns null when no assistant messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await store.getLastTokens(conversationId)).toBeUndefined();
    });

    it("getLastTokens returns the most recent assistant row's tokens", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessages({
        conversationId,
        messages: [{ role: "assistant", content: [{ type: "text", text: "first" }] }],
        lastInboundMessageId: inboundId,
        lastMessageInputTokens: 1000,
        lastMessageOutputTokens: 100,
        ...stamp,
      });
      await new Promise((r) => setTimeout(r, 2));
      await store.insertMessages({
        conversationId,
        messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] }],
        lastInboundMessageId: inboundId,
        lastMessageInputTokens: 2000,
        lastMessageOutputTokens: 200,
        ...stamp,
      });

      expect(await store.getLastTokens(conversationId)).toEqual({
        inputTokens: 2000,
        outputTokens: 200,
      });
    });

    it("insertMessage (singular) stores the -1 sentinel for outputTokens", async () => {
      // Singular insertMessage is used for the user row the orchestrator
      // writes up front — it has no output count, so the sentinel -1 is
      // stored. (The fast path only reads the last *assistant* row, so this
      // is never returned by getLastTokens — but we still prove it on disk.)
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "user",
        content: "no tokens",
        lastInboundMessageId: inboundId,
        ...stamp,
      });

      const rows = await db
        .select({ outputTokens: messages.outputTokens })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outputTokens).toBe(-1);

      // And getLastTokens still returns null — no assistant row exists.
      expect(await store.getLastTokens(conversationId)).toBeUndefined();
    });
  });

  describe("steering rules", () => {
    it("returns active rules for profile + global, ordered by priority", async () => {
      const profileId = await seedProfile();
      const otherProfileId = (
        await store.createProfile({
          userId: null,
          name: "other",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        })
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

      const rules = await store.getActiveRules(profileId, []);
      expect(rules).toEqual([{ rule: "Global safety rule" }, { rule: "Be concise" }]);
    });

    it("returns empty array when no active rules", async () => {
      const profileId = await seedProfile();
      expect(await store.getActiveRules(profileId, [])).toEqual([]);
    });

    it("returns channel-scoped rules when channel is active", async () => {
      const profileId = await seedProfile();
      const { steeringRules: sr } = await import("./schema.js");
      await db.insert(sr).values([
        {
          rule: "Global rule",
          category: "style",
          active: true,
          source: "manual",
          priority: 1,
          observationCount: 0,
          profileId: null,
          channelType: null,
        },
        {
          rule: "Telegram rule",
          category: "style",
          active: true,
          source: "manual",
          priority: 2,
          observationCount: 0,
          profileId: null,
          channelType: "telegram",
        },
        {
          rule: "Slack rule",
          category: "style",
          active: true,
          source: "manual",
          priority: 3,
          observationCount: 0,
          profileId: null,
          channelType: "slack",
        },
      ]);

      // No channels active — only null-scoped rules
      expect(await store.getActiveRules(profileId, [])).toEqual([{ rule: "Global rule" }]);

      // Telegram active — global + telegram
      expect(await store.getActiveRules(profileId, ["telegram"])).toEqual([
        { rule: "Global rule" },
        { rule: "Telegram rule" },
      ]);

      // Both channels — union
      expect(await store.getActiveRules(profileId, ["telegram", "slack"])).toEqual([
        { rule: "Global rule" },
        { rule: "Telegram rule" },
        { rule: "Slack rule" },
      ]);
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
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await store.insertMessage({
        conversationId,
        role: "user",
        content: "hello",
        lastInboundMessageId: inboundId,
        ...stamp,
      });

      const time = await store.getLastMessageTime(conversationId);
      expect(time).toBeInstanceOf(Date);
    });

    it("returns undefined for conversation with no messages", async () => {
      const { conversationId } = await seedConversation();
      const time = await store.getLastMessageTime(conversationId);
      expect(time).toBeUndefined();
    });
  });

  describe("providers", () => {
    async function seedProvider(name = "test-provider") {
      const { id: secretId } = await secretsStore.putSecret({
        name: `${name}_key`,
        plaintext: "sk-test",
      });
      return store.createProvider({
        name,
        type: "anthropic",
        secretId,
        attrs: {},
      });
    }

    it("creates and retrieves a provider", async () => {
      const { id } = await seedProvider();
      const provider = await store.getProvider(id);
      expect(provider).toMatchObject({ name: "test-provider", type: "anthropic" });
    });

    it("lists providers", async () => {
      await seedProvider("p1");
      await seedProvider("p2");
      const list = await store.listProviders();
      expect(list.map((p) => p.name).sort()).toEqual(["p1", "p2"]);
    });

    it("deleteProvider cascades to model_providers", async () => {
      const { id: providerId } = await seedProvider();
      await store.addModelProvider({
        model: "claude-test",
        providerId,
        position: 0,
        userSelectable: true,
      });

      await store.deleteProvider(providerId);

      expect(await store.getProvider(providerId)).toBeUndefined();
      expect(await store.resolveProviderForModel("claude-test")).toBeUndefined();
    });
  });

  describe("model_providers", () => {
    async function seedProviderWithSecret(name: string) {
      const { id: secretId } = await secretsStore.putSecret({
        name: `${name}_key`,
        plaintext: "sk-test",
      });
      return store.createProvider({ name, type: "anthropic", secretId, attrs: {} });
    }

    it("resolves the lowest-position provider for a model", async () => {
      const { id: fallbackId } = await seedProviderWithSecret("fallback");
      const { id: primaryId } = await seedProviderWithSecret("primary");

      await store.addModelProvider({
        model: "claude-sonnet-4",
        providerId: fallbackId,
        position: 1,
        userSelectable: true,
      });
      await store.addModelProvider({
        model: "claude-sonnet-4",
        providerId: primaryId,
        position: 0,
        userSelectable: true,
      });

      const resolved = await store.resolveProviderForModel("claude-sonnet-4");
      expect(resolved?.name).toBe("primary");
    });

    it("returns undefined when no provider is registered for a model", async () => {
      const resolved = await store.resolveProviderForModel("nonexistent-model");
      expect(resolved).toBeUndefined();
    });

    it("removes model_providers by provider", async () => {
      const { id: providerId } = await seedProviderWithSecret("removable");
      await store.addModelProvider({
        model: "model-a",
        providerId,
        position: 0,
        userSelectable: true,
      });
      await store.addModelProvider({
        model: "model-b",
        providerId,
        position: 0,
        userSelectable: true,
      });

      await store.removeModelProvidersByProvider(providerId);

      expect(await store.resolveProviderForModel("model-a")).toBeUndefined();
      expect(await store.resolveProviderForModel("model-b")).toBeUndefined();
    });

    it("enforces unique (model, position)", async () => {
      const { id: p1 } = await seedProviderWithSecret("p1");
      const { id: p2 } = await seedProviderWithSecret("p2");

      await store.addModelProvider({
        model: "claude-test",
        providerId: p1,
        position: 0,
        userSelectable: true,
      });

      await expect(
        store.addModelProvider({
          model: "claude-test",
          providerId: p2,
          position: 0,
          userSelectable: true,
        }),
      ).rejects.toThrow();
    });

    it("listProvidersForModel returns all providers in position ASC order", async () => {
      const { id: pZero } = await seedProviderWithSecret("pri");
      const { id: pOne } = await seedProviderWithSecret("sec");
      const { id: pTwo } = await seedProviderWithSecret("ter");

      // Insert out-of-order to verify sort isn't insertion-order-dependent.
      await store.addModelProvider({
        model: "claude-x",
        providerId: pZero,
        position: 0,
        userSelectable: true,
      });
      await store.addModelProvider({
        model: "claude-x",
        providerId: pTwo,
        position: 2,
        userSelectable: true,
      });
      await store.addModelProvider({
        model: "claude-x",
        providerId: pOne,
        position: 1,
        userSelectable: true,
      });

      const list = await store.listProvidersForModel("claude-x");
      expect(list.map((p) => p.name)).toEqual(["pri", "sec", "ter"]);
    });

    it("listProvidersForModel returns empty array when model has no providers", async () => {
      expect(await store.listProvidersForModel("unknown-model")).toEqual([]);
    });

    it("listDistinctUserSelectableModels excludes internal-only models", async () => {
      const { id: p } = await seedProviderWithSecret("p");
      await store.addModelProvider({
        model: "model-public",
        providerId: p,
        position: 0,
        userSelectable: true,
      });
      await store.addModelProvider({
        model: "model-internal",
        providerId: p,
        position: 1,
        userSelectable: false,
      });

      expect(await store.listDistinctUserSelectableModels()).toEqual(["model-public"]);
      expect(await store.isModelUserSelectable("model-public")).toBe(true);
      expect(await store.isModelUserSelectable("model-internal")).toBe(false);
      expect(await store.isModelUserSelectable("model-missing")).toBe(false);
    });
  });

  // --- Admin methods: profile CRUD, conversation listing, aliases ---

  describe("profile admin", () => {
    it("createProfile defaults memoryScope to null when not supplied", async () => {
      const userId = await seedUser();
      const profile = await store.createProfile({
        userId,
        name: "no-scope",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      expect(profile.memoryScope).toBeNull();
    });

    it("createProfile + getProfile round-trip a memoryScope", async () => {
      const userId = await seedUser();
      const created = await store.createProfile({
        userId,
        name: "coder",
        basePrompt: "p",
        model: "m",
        toolSet: [],
        memoryScope: {
          compartments: ["work", "technical"],
          trust: ["first-party"],
        },
      });
      expect(created.memoryScope).toEqual({
        compartments: ["work", "technical"],
        trust: ["first-party"],
      });
      const loaded = await store.getProfile(created.id);
      expect(loaded?.memoryScope).toEqual(created.memoryScope);
    });

    it("updateProfile can set and clear memoryScope", async () => {
      const userId = await seedUser();
      const { id } = await store.createProfile({
        userId,
        name: "p",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });

      const set = await store.updateProfile(id, {
        memoryScope: { compartments: ["health"], trust: ["first-party"] },
      });
      expect(set.memoryScope).toEqual({ compartments: ["health"], trust: ["first-party"] });

      const cleared = await store.updateProfile(id, { memoryScope: null });
      expect(cleared.memoryScope).toBeNull();
    });

    it("createProfile rejects empty compartments or trust arrays at the store boundary", async () => {
      const userId = await seedUser();
      await expect(
        store.createProfile({
          userId,
          name: "bad",
          basePrompt: "p",
          model: "m",
          toolSet: [],
          // biome-ignore lint/suspicious/noExplicitAny: testing invalid input rejection
          memoryScope: { compartments: [], trust: ["first-party"] } as any,
        }),
      ).rejects.toThrow();
    });

    it("listProfiles returns org profiles + caller's own, not other users'", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const org = (
        await store.createProfile({
          userId: null,
          name: "default",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        })
      ).id;
      const mine = (
        await store.createProfile({
          userId: u1,
          name: "mine",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        })
      ).id;
      await store.createProfile({
        userId: u2,
        name: "theirs",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });

      const visible = await store.listProfiles(u1);
      expect(visible.map((p) => p.id).sort()).toEqual([org, mine].sort());
    });

    it("getProfileOwner returns userId (or null for org)", async () => {
      const u = await seedUser();
      const orgId = (
        await store.createProfile({
          userId: null,
          name: "org",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        })
      ).id;
      const mineId = (
        await store.createProfile({
          userId: u,
          name: "mine",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        })
      ).id;
      expect(await store.getProfileOwner(orgId)).toEqual({ userId: null });
      expect(await store.getProfileOwner(mineId)).toEqual({ userId: u });
      expect(await store.getProfileOwner("019d0000-0000-7000-8000-000000000000")).toBeUndefined();
    });

    it("updateProfile applies partial changes and preserves unlisted fields", async () => {
      const u = await seedUser();
      const { id } = await store.createProfile({
        userId: u,
        name: "before",
        basePrompt: "before-prompt",
        model: "m",
        toolSet: ["a"],
      });
      const updated = await store.updateProfile(id, { name: "after", model: "m2" });
      expect(updated).toMatchObject({
        id,
        userId: u,
        name: "after",
        model: "m2",
        basePrompt: "before-prompt",
      });
    });

    it("createProfile + updateProfile return rows with voiceMode populated", async () => {
      // Regression guard: a `.returning()` block missing `voiceMode` would
      // cast to `Profile` but leak `undefined` at runtime, silently
      // bypassing resolveVoiceMode's profile-default fallback.
      const u = await seedUser();
      const created = await store.createProfile({
        userId: u,
        name: "voice-test",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      expect(created.voiceMode).toBe("auto");

      const updated = await store.updateProfile(created.id, { voiceMode: "always" });
      expect(updated.voiceMode).toBe("always");
    });

    it("updateProfile translates unique-name collision to UniqueViolationError", async () => {
      const u = await seedUser();
      await store.createProfile({
        userId: u,
        name: "taken",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      const { id: other } = await store.createProfile({
        userId: u,
        name: "free",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      const { UniqueViolationError } = await import("./errors.js");
      await expect(store.updateProfile(other, { name: "taken" })).rejects.toThrow(
        UniqueViolationError,
      );
    });

    it("countProfileReferences counts both conversations and messages", async () => {
      const u = await seedUser();
      const { id: profileId } = await store.createProfile({
        userId: u,
        name: "p",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      expect(await store.countProfileReferences(profileId)).toEqual({
        conversations: 0,
        messages: 0,
      });

      const { id: c1 } = await store.createConversation({ userId: u, profileId, isPrivate: true });
      await store.createConversation({ userId: u, profileId, isPrivate: true });
      await store.insertMessage({
        conversationId: c1,
        role: "user",
        content: "hi",
        profileId,
        model: "m",
        lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
      });
      expect(await store.countProfileReferences(profileId)).toEqual({
        conversations: 2,
        messages: 1,
      });
    });

    it("deleteProfile removes the row when no references exist", async () => {
      const u = await seedUser();
      const { id } = await store.createProfile({
        userId: u,
        name: "temp",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      await store.deleteProfile(id);
      expect(await store.getProfile(id)).toBeUndefined();
    });

    it("deleteProfile throws ProfileInUseError when conversations reference it", async () => {
      const u = await seedUser();
      const { id: profileId } = await store.createProfile({
        userId: u,
        name: "busy",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      await store.createConversation({ userId: u, profileId, isPrivate: true });
      const { ProfileInUseError } = await import("./errors.js");
      await expect(store.deleteProfile(profileId)).rejects.toThrow(ProfileInUseError);
      // Profile still exists — delete rolled back.
      expect(await store.getProfile(profileId)).not.toBeUndefined();
    });

    it("deleteProfile throws ProfileInUseError when only message history references it", async () => {
      // The conversation has been switched away (profileId pointer gone) but stamped messages remain.
      const u = await seedUser();
      const { id: oldProfileId } = await store.createProfile({
        userId: u,
        name: "old",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      const { id: newProfileId } = await store.createProfile({
        userId: u,
        name: "new",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      const { id: convId } = await store.createConversation({
        userId: u,
        profileId: oldProfileId,
        isPrivate: true,
      });
      await store.insertMessage({
        conversationId: convId,
        role: "user",
        content: "hi",
        profileId: oldProfileId,
        model: "m",
        lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
      });
      // Switch the conversation to new profile — old profile now only referenced by stamped msg
      await store.setConversationProfile(convId, newProfileId);

      const { ProfileInUseError } = await import("./errors.js");
      await expect(store.deleteProfile(oldProfileId)).rejects.toThrow(ProfileInUseError);
    });
  });

  describe("conversation admin", () => {
    it("listConversationsForUser returns user's private conversations with alias + last message preview", async () => {
      const { userId, profileId, conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await store.insertMessage({
        conversationId,
        role: "user",
        content: "hello there this is the last message",
        lastInboundMessageId: inboundId,
        ...stamp,
      });
      await store.setAlias(userId, conversationId, "work");

      const list = await store.listConversationsForUser(userId);
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

    it("listConversationsForUser excludes conversations from other users", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const profileId = await seedProfile();
      const c1 = (await store.createConversation({ userId: u1, profileId, isPrivate: true })).id;
      const c2 = (await store.createConversation({ userId: u2, profileId, isPrivate: true })).id;
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await store.insertMessage({
        conversationId: c1,
        role: "user",
        content: "u1",
        lastInboundMessageId: inboundId,
        profileId,
        model: TEST_MODEL,
      });
      await store.insertMessage({
        conversationId: c2,
        role: "user",
        content: "u2",
        lastInboundMessageId: inboundId,
        profileId,
        model: TEST_MODEL,
      });

      const list = await store.listConversationsForUser(u1);
      expect(list.map((c) => c.id)).toEqual([c1]);
    });

    it("listConversationsForUser excludes non-private conversations and empty conversations", async () => {
      const userId = await seedUser();
      const profileId = await seedProfile();
      const empty = (await store.createConversation({ userId, profileId, isPrivate: true })).id;
      const nonPrivate = (await store.createConversation({ userId, profileId, isPrivate: false }))
        .id;
      const withMsg = (await store.createConversation({ userId, profileId, isPrivate: true })).id;
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await store.insertMessage({
        conversationId: nonPrivate,
        role: "user",
        content: "noisy",
        lastInboundMessageId: inboundId,
        profileId,
        model: TEST_MODEL,
      });
      await store.insertMessage({
        conversationId: withMsg,
        role: "user",
        content: "real",
        lastInboundMessageId: inboundId,
        profileId,
        model: TEST_MODEL,
      });

      const list = await store.listConversationsForUser(userId);
      expect(list.map((c) => c.id)).toEqual([withMsg]);
      expect(empty).toBeDefined(); // empty conv excluded
    });

    it("setConversationProfile updates conversations.profile_id", async () => {
      const { userId, conversationId } = await seedConversation();
      const { id: newProfileId } = await store.createProfile({
        userId,
        name: "other",
        basePrompt: "p",
        model: "m",
        toolSet: [],
      });
      await store.setConversationProfile(conversationId, newProfileId);
      const conv = await store.getConversation(conversationId);
      expect(conv?.profileId).toBe(newProfileId);
    });
  });

  describe("aliases", () => {
    it("setAlias inserts, then updates on same conversationId", async () => {
      const { userId, conversationId } = await seedConversation();
      await store.setAlias(userId, conversationId, "work");
      expect(await store.findConversationByAlias(userId, "work")).toEqual({ conversationId });

      await store.setAlias(userId, conversationId, "personal");
      expect(await store.findConversationByAlias(userId, "work")).toBeUndefined();
      expect(await store.findConversationByAlias(userId, "personal")).toEqual({
        conversationId,
      });
    });

    it("setAlias with null clears the alias", async () => {
      const { userId, conversationId } = await seedConversation();
      await store.setAlias(userId, conversationId, "work");
      await store.setAlias(userId, conversationId, null);
      expect(await store.findConversationByAlias(userId, "work")).toBeUndefined();
    });

    it("setAlias collision across conversations throws UniqueViolationError", async () => {
      const userId = await seedUser();
      const profileId = await seedProfile();
      const c1 = (await store.createConversation({ userId, profileId, isPrivate: true })).id;
      const c2 = (await store.createConversation({ userId, profileId, isPrivate: true })).id;
      await store.setAlias(userId, c1, "work");
      const { UniqueViolationError } = await import("./errors.js");
      await expect(store.setAlias(userId, c2, "work")).rejects.toThrow(UniqueViolationError);
    });

    it("findConversationByAlias scopes to user", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const profileId = await seedProfile();
      const conv = (await store.createConversation({ userId: u1, profileId, isPrivate: true })).id;
      await store.setAlias(u1, conv, "shared");
      // u2 searching for same alias should see nothing
      expect(await store.findConversationByAlias(u2, "shared")).toBeUndefined();
    });

    it("getAliasForConversation returns the alias when set, null when cleared", async () => {
      const { userId, conversationId } = await seedConversation();
      expect(await store.getAliasForConversation(userId, conversationId)).toBeNull();
      await store.setAlias(userId, conversationId, "work");
      expect(await store.getAliasForConversation(userId, conversationId)).toBe("work");
      await store.setAlias(userId, conversationId, null);
      expect(await store.getAliasForConversation(userId, conversationId)).toBeNull();
    });

    it("getAliasForConversation scopes to user (other users see null)", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const profileId = await seedProfile();
      const conv = (await store.createConversation({ userId: u1, profileId, isPrivate: true })).id;
      await store.setAlias(u1, conv, "owned-by-u1");
      expect(await store.getAliasForConversation(u2, conv)).toBeNull();
      expect(await store.getAliasForConversation(u1, conv)).toBe("owned-by-u1");
    });
  });

  describe("getConversationStats", () => {
    it("returns createdAt + zero counts for a fresh conversation with no messages", async () => {
      const { conversationId } = await seedConversation();
      const stats = await store.getConversationStats(conversationId);
      expect(stats).toBeDefined();
      expect(stats?.messageCount).toBe(0);
      expect(stats?.lastMessageAt).toBeNull();
      expect(stats?.createdAt).toBeInstanceOf(Date);
    });

    it("counts messages and surfaces the most recent createdAt", async () => {
      const { profileId, conversationId } = await seedConversation();
      await store.insertMessage({
        conversationId,
        role: "user",
        content: "hi",
        profileId,
        model: "claude-sonnet-4-6",
        lastInboundMessageId: "00000000-0000-7000-8000-000000000001",
      });
      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: "hello back",
        profileId,
        model: "claude-sonnet-4-6",
        lastInboundMessageId: "00000000-0000-7000-8000-000000000001",
      });
      const stats = await store.getConversationStats(conversationId);
      expect(stats?.messageCount).toBe(2);
      expect(stats?.lastMessageAt).toBeInstanceOf(Date);
    });

    it("returns undefined for a nonexistent conversation id", async () => {
      const stats = await store.getConversationStats("00000000-0000-7000-8000-000000000999");
      expect(stats).toBeUndefined();
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

      const rules = await store.getActiveRules(profileId, []);
      expect(rules).toEqual([{ rule: "New consolidated rule" }]);
    });
  });

  describe("voice config", () => {
    it("returns undefined when no row is present", async () => {
      expect(await store.getVoiceConfig()).toBeUndefined();
    });

    it("returns the singleton row when present", async () => {
      // Bootstrap path: voice_config has FKs to `secrets`. The wizard would
      // insert these via `secretsStore.putSecret` then a row via raw SQL —
      // mirror that here. Same secret id can serve both TTS and STT
      // (when the operator opts to reuse the OpenAI LLM provider's key).
      const { id: secretId } = await secretsStore.putSecret({
        name: "voice_openai_key",
        plaintext: "sk-test-voice",
      });
      await db.execute(sql`
        INSERT INTO voice_config (
          tts_secret_id, stt_secret_id,
          tts_provider, tts_model, tts_voice, tts_base_url,
          stt_provider, stt_model, stt_base_url
        ) VALUES (
          ${secretId}, ${secretId},
          'openai', 'gpt-4o-mini-tts', 'alloy', NULL,
          'openai', 'gpt-4o-mini-transcribe', NULL
        )
      `);

      const cfg = await store.getVoiceConfig();
      expect(cfg).toBeDefined();
      expect(cfg).toMatchObject({
        ttsSecretId: secretId,
        sttSecretId: secretId,
        ttsProvider: "openai",
        ttsModel: "gpt-4o-mini-tts",
        ttsVoice: "alloy",
        ttsBaseUrl: null,
        sttProvider: "openai",
        sttModel: "gpt-4o-mini-transcribe",
        sttBaseUrl: null,
      });
    });

    it("enforces singleton at the DB level — second insert violates UNIQUE", async () => {
      // The singleton column + UNIQUE/CHECK make a second row impossible.
      // Without the constraint, getVoiceConfig().limit(1) would pick
      // arbitrarily; the constraint blocks the misconfiguration at write time.
      const { id: secretId } = await secretsStore.putSecret({
        name: "voice_openai_key",
        plaintext: "sk-test-voice",
      });
      const insertSql = sql`
        INSERT INTO voice_config (
          tts_secret_id, stt_secret_id,
          tts_provider, tts_model, tts_voice,
          stt_provider, stt_model
        ) VALUES (
          ${secretId}, ${secretId},
          'openai', 'gpt-4o-mini-tts', 'alloy',
          'openai', 'gpt-4o-mini-transcribe'
        )
      `;
      await db.execute(insertSql);
      // Second insert with default singleton=TRUE collides on the UNIQUE.
      await expect(db.execute(insertSql)).rejects.toThrow();
    });
  });

  describe("pending_memories", () => {
    it("stages a row with content + source and returns its id", async () => {
      const userId = await seedUser();

      const { id } = await store.stagePendingMemory({
        userId,
        content: "homelab IP is 10.0.10.10",
        source: "live_retain",
      });

      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const rows = await store.getPendingMemories(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id,
        content: "homelab IP is 10.0.10.10",
        context: null,
        source: "live_retain",
      });
      expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    });

    it("preserves optional context", async () => {
      const userId = await seedUser();

      await store.stagePendingMemory({
        userId,
        content: "wife's birthday is March 15",
        context: "while planning a gift",
        source: "live_retain",
      });

      const rows = await store.getPendingMemories(userId);
      expect(rows[0]?.context).toBe("while planning a gift");
    });

    it("returns rows ordered oldest-first (FIFO)", async () => {
      const userId = await seedUser();

      const { id: first } = await store.stagePendingMemory({
        userId,
        content: "first",
        source: "live_retain",
      });
      // Brief delay so created_at differs measurably under PGlite.
      await new Promise((r) => setTimeout(r, 5));
      const { id: second } = await store.stagePendingMemory({
        userId,
        content: "second",
        source: "migration",
      });

      const rows = await store.getPendingMemories(userId);
      expect(rows.map((r) => r.id)).toEqual([first, second]);
    });

    it("respects the limit parameter and returns the oldest rows first", async () => {
      const userId = await seedUser();

      for (let i = 0; i < 5; i++) {
        await store.stagePendingMemory({
          userId,
          content: `fact ${i}`,
          source: "live_retain",
        });
        await new Promise((r) => setTimeout(r, 2));
      }

      const limited = await store.getPendingMemories(userId, 2);
      expect(limited).toHaveLength(2);
      expect(limited.map((r) => r.content)).toEqual(["fact 0", "fact 1"]);

      const unbounded = await store.getPendingMemories(userId);
      expect(unbounded).toHaveLength(5);
    });

    it("scopes rows by userId — never returns another user's pending rows", async () => {
      const userA = await seedUser();
      const userB = await seedUser();

      await store.stagePendingMemory({
        userId: userA,
        content: "A's fact",
        source: "live_retain",
      });
      await store.stagePendingMemory({
        userId: userB,
        content: "B's fact",
        source: "live_retain",
      });

      const rowsA = await store.getPendingMemories(userA);
      const rowsB = await store.getPendingMemories(userB);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]?.content).toBe("A's fact");
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]?.content).toBe("B's fact");
    });

    it("deletes specified rows by id", async () => {
      const userId = await seedUser();

      const a = await store.stagePendingMemory({
        userId,
        content: "fact A",
        source: "live_retain",
      });
      const b = await store.stagePendingMemory({
        userId,
        content: "fact B",
        source: "live_retain",
      });

      await store.deletePendingMemories([a.id]);

      const remaining = await store.getPendingMemories(userId);
      expect(remaining.map((r) => r.id)).toEqual([b.id]);
    });

    it("deletePendingMemories with empty list is a no-op", async () => {
      const userId = await seedUser();

      await store.stagePendingMemory({
        userId,
        content: "fact",
        source: "live_retain",
      });

      await store.deletePendingMemories([]);

      const rows = await store.getPendingMemories(userId);
      expect(rows).toHaveLength(1);
    });

    it("bulk-stages multiple rows in one statement", async () => {
      const userId = await seedUser();

      await store.bulkStagePendingMemories([
        { userId, content: "fact A", source: "migration" },
        { userId, content: "fact B", context: "with context", source: "migration" },
        { userId, content: "fact C", source: "migration" },
      ]);

      const rows = await store.getPendingMemories(userId);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.content).sort()).toEqual(["fact A", "fact B", "fact C"]);
      expect(rows.find((r) => r.content === "fact B")?.context).toBe("with context");
      expect(rows.every((r) => r.source === "migration")).toBe(true);
    });

    it("bulkStagePendingMemories with empty array is a no-op", async () => {
      const userId = await seedUser();

      await store.bulkStagePendingMemories([]);

      const rows = await store.getPendingMemories(userId);
      expect(rows).toEqual([]);
    });

    it("rejects unknown source values", async () => {
      const userId = await seedUser();

      await expect(
        store.stagePendingMemory({
          userId,
          content: "fact",
          // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
          source: "bogus" as any,
        }),
      ).rejects.toThrow();
    });
  });
});
