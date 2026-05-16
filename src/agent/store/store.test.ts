import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../../secrets/encryption.js";
import { DrizzleSecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "./index.js";
import { messages } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleAgentStore;
let secretsStore: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleAgentStore();
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// --- Helpers ---

async function seedUser(): Promise<string> {
  return (await tx((trx) => store.createUser(trx))).id;
}

const TEST_MODEL = "claude-sonnet-4-6";

async function seedProfile(): Promise<string> {
  return (
    await tx((trx) =>
      store.createProfile(trx, {
        userId: null,
        name: "test",
        basePrompt: "You are a test assistant.",
        model: TEST_MODEL,
        toolSet: ["tool_a"],
      }),
    )
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
  const conversationId = (
    await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
  ).id;
  return { userId, profileId, conversationId, stamp: { profileId, model: TEST_MODEL } };
}

// --- Tests ---

describe("DrizzleAgentStore", () => {
  describe("users", () => {
    it("creates a user and retrieves it", async () => {
      const { id } = await tx((trx) => store.createUser(trx));
      expect(id).toBeDefined();

      const first = await tx((trx) => store.getFirstUser(trx));
      expect(first?.id).toBe(id);
    });

    it("returns null when no users exist", async () => {
      expect(await tx((trx) => store.getFirstUser(trx))).toBeUndefined();
    });
  });

  describe("profiles", () => {
    it("creates and retrieves a profile", async () => {
      const { id } = await tx((trx) =>
        store.createProfile(trx, {
          userId: null,
          name: "main",
          basePrompt: "Be helpful.",
          model: "claude-test",
          toolSet: ["memory_recall"],
        }),
      );

      const profile = await tx((trx) => store.getProfile(trx, id));
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
        profileClass: null,
      });
    });

    it("returns null for unknown profile", async () => {
      expect(
        await tx((trx) => store.getProfile(trx, "019d0000-0000-7000-8000-000000000000")),
      ).toBeUndefined();
    });

    it("getDefaultProfile returns first profile", async () => {
      expect(await tx((trx) => store.getDefaultProfile(trx))).toBeUndefined();
      const { id } = await tx((trx) =>
        store.createProfile(trx, {
          userId: null,
          name: "default",
          basePrompt: "prompt",
          model: "m",
          toolSet: [],
        }),
      );
      expect((await tx((trx) => store.getDefaultProfile(trx)))?.id).toBe(id);
    });

    it("enforces unique org profile name (user_id null)", async () => {
      await tx((trx) =>
        store.createProfile(trx, {
          userId: null,
          name: "dup",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await expect(
        tx((trx) =>
          store.createProfile(trx, {
            userId: null,
            name: "dup",
            basePrompt: "p2",
            model: "m2",
            toolSet: [],
          }),
        ),
      ).rejects.toThrow();
    });

    it("allows same name across different users (and between org and user)", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      await tx((trx) =>
        store.createProfile(trx, {
          userId: null,
          name: "coder",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) =>
        store.createProfile(trx, {
          userId: u1,
          name: "coder",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) =>
        store.createProfile(trx, {
          userId: u2,
          name: "coder",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      // No throw — same name is allowed when (user_id, name) differs.
    });

    it("rejects duplicate name within the same user", async () => {
      const u = await seedUser();
      await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "mine",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await expect(
        tx((trx) =>
          store.createProfile(trx, {
            userId: u,
            name: "mine",
            basePrompt: "p2",
            model: "m2",
            toolSet: [],
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("profile classes", () => {
    async function seedClassed(): Promise<{ userId: string; profileId: string }> {
      const userId = await seedUser();
      const profile = await tx((trx) =>
        store.createProfile(trx, {
          userId,
          name: "intimate",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      return { userId, profileId: profile.id };
    }

    it("creates a class and lists it", async () => {
      const { userId } = await seedClassed();
      const created = await tx((trx) =>
        store.createProfileClass(trx, {
          userId,
          name: "intimate",
          description: "for emotional / relationship topics",
        }),
      );
      expect(created.name).toBe("intimate");
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list).toHaveLength(1);
      expect(list[0]?.description).toBe("for emotional / relationship topics");
    });

    it("rejects duplicate class name within the same user", async () => {
      const { userId } = await seedClassed();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "first" }),
      );
      await expect(
        tx((trx) =>
          store.createProfileClass(trx, { userId, name: "intimate", description: "second" }),
        ),
      ).rejects.toThrow();
    });

    it("rejects class names that don't match the canonical shape", async () => {
      const { userId } = await seedClassed();
      // Same canonical-name regex enforced for profile classes — keeps
      // the merged "label registry" surface uniform with compartments.
      await expect(
        tx((trx) => store.createProfileClass(trx, { userId, name: "Intimate", description: "x" })),
      ).rejects.toThrow(/invalid profile_class name/);
      await expect(
        tx((trx) => store.createProfileClass(trx, { userId, name: "two words", description: "x" })),
      ).rejects.toThrow(/invalid profile_class name/);
    });

    it("setProfileClass attaches a registered class", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      await tx((trx) => store.setProfileClass(trx, profileId, "intimate"));
      const profile = await tx((trx) => store.getProfile(trx, profileId));
      expect(profile?.profileClass).toBe("intimate");
    });

    it("setProfileClass with null clears the class", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      await tx((trx) => store.setProfileClass(trx, profileId, "intimate"));
      await tx((trx) => store.setProfileClass(trx, profileId, null));
      const profile = await tx((trx) => store.getProfile(trx, profileId));
      expect(profile?.profileClass).toBeNull();
    });

    it("setProfileClass throws UnknownProfileClassError for an unregistered class", async () => {
      const { profileId } = await seedClassed();
      await expect(
        tx((trx) => store.setProfileClass(trx, profileId, "no-such-class")),
      ).rejects.toThrow(/unknown profile class/);
    });

    it("setProfileClass on an org profile (userId=null) rejects any non-null class", async () => {
      // Create an org profile (userId=null).
      const orgProfile = await tx((trx) =>
        store.createProfile(trx, {
          userId: null,
          name: "org",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await expect(
        tx((trx) => store.setProfileClass(trx, orgProfile.id, "anything")),
      ).rejects.toThrow(/unknown profile class/);
    });

    it("deleteProfileClass throws ProfileClassInUseError when a profile references the class", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      await tx((trx) => store.setProfileClass(trx, profileId, "intimate"));
      await expect(tx((trx) => store.deleteProfileClass(trx, userId, "intimate"))).rejects.toThrow(
        /profile class in use/,
      );
    });

    it("deleteProfileClass succeeds after the references are cleared", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      await tx((trx) => store.setProfileClass(trx, profileId, "intimate"));
      await tx((trx) => store.setProfileClass(trx, profileId, null));
      const result = await tx((trx) => store.deleteProfileClass(trx, userId, "intimate"));
      expect(result.deleted).toBe(true);
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list).toHaveLength(0);
    });

    it("deleteProfileClass returns deleted:false for an unknown name (idempotent)", async () => {
      const { userId } = await seedClassed();
      const result = await tx((trx) => store.deleteProfileClass(trx, userId, "no-such"));
      expect(result.deleted).toBe(false);
    });

    it("createProfileClass defaults restricted=false; listProfileClasses surfaces it", async () => {
      const { userId } = await seedClassed();
      const created = await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      expect(created.restricted).toBe(false);
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list[0]?.restricted).toBe(false);
    });

    it("setProfileClassRestricted flips the flag and is idempotent", async () => {
      const { userId } = await seedClassed();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      const first = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", true),
      );
      expect(first.updated).toBe(true);
      const after = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(after[0]?.restricted).toBe(true);
      // Re-flipping to the same value is a no-op success — idempotent.
      const second = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", true),
      );
      expect(second.updated).toBe(true);
      const off = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", false),
      );
      expect(off.updated).toBe(true);
      const final = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(final[0]?.restricted).toBe(false);
    });

    it("setProfileClassRestricted returns updated:false for an unknown name", async () => {
      const { userId } = await seedClassed();
      const result = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "no-such", true),
      );
      expect(result.updated).toBe(false);
    });

    it("setProfileClassRestricted is independent of in-use status — restricting an attached class works", async () => {
      const { userId, profileId } = await seedClassed();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      await tx((trx) => store.setProfileClass(trx, profileId, "intimate"));
      const result = await tx((trx) =>
        store.setProfileClassRestricted(trx, userId, "intimate", true),
      );
      expect(result.updated).toBe(true);
      const list = await tx((trx) => store.listProfileClasses(trx, userId));
      expect(list[0]?.restricted).toBe(true);
    });
  });

  describe("custom compartments", () => {
    it("creates and lists, ordered by name", async () => {
      const userId = await seedUser();
      await tx((trx) =>
        store.createCustomCompartment(trx, { userId, name: "music", description: "music notes" }),
      );
      await tx((trx) =>
        store.createCustomCompartment(trx, { userId, name: "dnd", description: "dnd campaign" }),
      );
      const list = await tx((trx) => store.listCustomCompartments(trx, userId));
      expect(list.map((c) => c.name)).toEqual(["dnd", "music"]);
    });

    it("rejects names that don't match the canonical shape", async () => {
      const userId = await seedUser();
      // Uppercase, leading non-letter, special chars, too long, whitespace,
      // empty. Trailing hyphens / underscores are intentionally accepted —
      // the regex permits anything from the [a-z0-9_-] class after the
      // leading letter, so `dnd-` is valid (matches `compartment:dnd-` as a
      // tag value, even if it reads oddly).
      const badNames = ["Work", "1campaign", "dnd!", "x".repeat(33), "two words", "", "-leading"];
      for (const name of badNames) {
        await expect(
          tx((trx) => store.createCustomCompartment(trx, { userId, name, description: "x" })),
        ).rejects.toThrow(/invalid compartment name/);
      }
    });

    it("accepts canonical-shape names (lowercase + digits + - / _)", async () => {
      const userId = await seedUser();
      const ok = ["dnd", "music-prod", "side_project", "campaign1", "a"];
      for (const name of ok) {
        await tx((trx) => store.createCustomCompartment(trx, { userId, name, description: "x" }));
      }
      const list = await tx((trx) => store.listCustomCompartments(trx, userId));
      expect(list.map((c) => c.name).sort()).toEqual([...ok].sort());
    });

    it("rejects core-compartment names as reserved", async () => {
      const userId = await seedUser();
      await expect(
        tx((trx) =>
          store.createCustomCompartment(trx, {
            userId,
            name: "personal",
            description: "shadow",
          }),
        ),
      ).rejects.toThrow(/reserved/);
      await expect(
        tx((trx) =>
          store.createCustomCompartment(trx, {
            userId,
            name: "misc",
            description: "shadow",
          }),
        ),
      ).rejects.toThrow(/reserved/);
    });

    it("rejects duplicates within the same user", async () => {
      const userId = await seedUser();
      await tx((trx) =>
        store.createCustomCompartment(trx, { userId, name: "dnd", description: "first" }),
      );
      await expect(
        tx((trx) =>
          store.createCustomCompartment(trx, { userId, name: "dnd", description: "second" }),
        ),
      ).rejects.toThrow();
    });

    it("enforces the per-user cap and reports current count on overflow", async () => {
      const userId = await seedUser();
      for (let i = 0; i < 10; i++) {
        await tx((trx) =>
          store.createCustomCompartment(trx, {
            userId,
            name: `c${i}`,
            description: `desc-${i}`,
          }),
        );
      }
      await expect(
        tx((trx) =>
          store.createCustomCompartment(trx, {
            userId,
            name: "overflow",
            description: "x",
          }),
        ),
      ).rejects.toThrow(/cap exceeded: 10\/10/);
    });

    it("delete is forward-only and idempotent on unknown names", async () => {
      const userId = await seedUser();
      await tx((trx) =>
        store.createCustomCompartment(trx, { userId, name: "dnd", description: "x" }),
      );
      const r1 = await tx((trx) => store.deleteCustomCompartment(trx, userId, "dnd"));
      expect(r1.deleted).toBe(true);
      const r2 = await tx((trx) => store.deleteCustomCompartment(trx, userId, "dnd"));
      expect(r2.deleted).toBe(false);
    });

    it("scopes by user — one user's compartments are not visible to another", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      await tx((trx) =>
        store.createCustomCompartment(trx, { userId: u1, name: "dnd", description: "x" }),
      );
      const list1 = await tx((trx) => store.listCustomCompartments(trx, u1));
      const list2 = await tx((trx) => store.listCustomCompartments(trx, u2));
      expect(list1.map((c) => c.name)).toEqual(["dnd"]);
      expect(list2).toHaveLength(0);
    });
  });

  describe("conversations", () => {
    it("creates and retrieves a conversation with default 'active' status", async () => {
      const { userId, profileId, conversationId } = await seedConversation();

      const conv = await tx((trx) => store.getConversation(trx, conversationId));
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
      await tx((trx) => store.setConversationStatus(trx, conversationId, "errored"));
      const conv = await tx((trx) => store.getConversation(trx, conversationId));
      expect(conv?.status).toBe("errored");
      // Reversibility — future `/repair` (or manual psql) flips back
      await tx((trx) => store.setConversationStatus(trx, conversationId, "active"));
      const conv2 = await tx((trx) => store.getConversation(trx, conversationId));
      expect(conv2?.status).toBe("active");
    });

    it("returns null for unknown conversation", async () => {
      expect(
        await tx((trx) => store.getConversation(trx, "019d0000-0000-7000-8000-000000000000")),
      ).toBeUndefined();
    });

    it("rejects conversation with nonexistent userId", async () => {
      const profileId = await seedProfile();
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
      const userId = await seedUser();
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
      const { conversationId } = await seedConversation();
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
      const { conversationId } = await seedConversation();
      await tx((trx) => store.setConversationVoiceMode(trx, conversationId, "always"));
      await tx((trx) => store.setConversationVoiceMode(trx, conversationId, null));
      expect((await tx((trx) => store.getConversation(trx, conversationId)))?.voiceMode).toBeNull();
    });
  });

  describe("messages", () => {
    it("inserts and retrieves messages in order", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "Hello",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );
      // 2ms sleep — PGlite's pg_uuidv7 uses random bits, not monotonic counter
      await new Promise((r) => setTimeout(r, 2));
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "Hi there",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );

      const history = await tx((trx) => store.getHistory(trx, conversationId));
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: "user", content: "Hello" });
      expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
    });

    it("getMessage returns a single message", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const { id } = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: [{ type: "text", text: "structured" }],
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );

      const msg = await tx((trx) => store.getMessage(trx, id));
      expect(msg).toEqual({ id, role: "user", content: [{ type: "text", text: "structured" }] });
    });

    it("returns null for unknown message", async () => {
      expect(
        await tx((trx) => store.getMessage(trx, "019d0000-0000-7000-8000-000000000000")),
      ).toBeUndefined();
    });

    it("insertMessages batch inserts with tool_use/tool_result pairing", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      const result = await tx((trx) =>
        store.insertMessages(trx, {
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
        }),
      );

      expect(result.id).toBeDefined();
      expect(result.id).not.toBe("");

      const history = await tx((trx) => store.getHistory(trx, conversationId));
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
        tx((trx) =>
          store.insertMessages(trx, {
            conversationId,
            messages: [],
            lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
            lastMessageOutputTokens: 0,
            ...stamp,
          }),
        ),
      ).rejects.toThrow("insertMessages requires at least one message");
    });

    it("insertMessages writes token counts onto the last message only", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessages(trx, {
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
        }),
      );

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

      expect(await tx((trx) => store.getLastAssistantMessage(trx, conversationId))).toBeUndefined();

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "first",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );
      // UUIDv7 is time-ordered per millisecond — ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 2));
      const { id: secondId } = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "assistant",
          content: "second",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );

      const last = await tx((trx) => store.getLastAssistantMessage(trx, conversationId));
      expect(last?.id).toBe(secondId);
      expect(last?.lastInboundMessageId).toBe(inboundId);
    });

    it("getHistory returns empty array for no messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await tx((trx) => store.getHistory(trx, conversationId))).toEqual([]);
    });

    it("insertMessages persists both token counts and getLastTokens returns them", async () => {
      // After a turn with input=N, output=M, getLastTokens should report
      // both — the fast path needs both terms to estimate next-turn input.
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "response" }] }],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 5432,
          lastMessageOutputTokens: 321,
          ...stamp,
        }),
      );

      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toEqual({
        inputTokens: 5432,
        outputTokens: 321,
      });
    });

    it("getLastTokens returns null when no assistant messages", async () => {
      const { conversationId } = await seedConversation();
      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toBeUndefined();
    });

    it("getLastTokens returns the most recent assistant row's tokens", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "first" }] }],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 1000,
          lastMessageOutputTokens: 100,
          ...stamp,
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
      await tx((trx) =>
        store.insertMessages(trx, {
          conversationId,
          messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] }],
          lastInboundMessageId: inboundId,
          lastMessageInputTokens: 2000,
          lastMessageOutputTokens: 200,
          ...stamp,
        }),
      );

      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toEqual({
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

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "no tokens",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );

      const rows = await db
        .select({ outputTokens: messages.outputTokens })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outputTokens).toBe(-1);

      // And getLastTokens still returns null — no assistant row exists.
      expect(await tx((trx) => store.getLastTokens(trx, conversationId))).toBeUndefined();
    });
  });

  describe("steering rules", () => {
    it("returns active rules for profile + global, ordered by priority", async () => {
      const profileId = await seedProfile();
      const otherProfileId = (
        await tx((trx) =>
          store.createProfile(trx, {
            userId: null,
            name: "other",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
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

      const rules = await tx((trx) => store.getActiveRules(trx, profileId, []));
      expect(rules).toEqual([{ rule: "Global safety rule" }, { rule: "Be concise" }]);
    });

    it("returns empty array when no active rules", async () => {
      const profileId = await seedProfile();
      expect(await tx((trx) => store.getActiveRules(trx, profileId, []))).toEqual([]);
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
      expect(await tx((trx) => store.getActiveRules(trx, profileId, []))).toEqual([
        { rule: "Global rule" },
      ]);

      // Telegram active — global + telegram
      expect(await tx((trx) => store.getActiveRules(trx, profileId, ["telegram"]))).toEqual([
        { rule: "Global rule" },
        { rule: "Telegram rule" },
      ]);

      // Both channels — union
      expect(
        await tx((trx) => store.getActiveRules(trx, profileId, ["telegram", "slack"])),
      ).toEqual([{ rule: "Global rule" }, { rule: "Telegram rule" }, { rule: "Slack rule" }]);
    });
  });

  describe("core memory blocks", () => {
    it("upsert creates a new block", async () => {
      const userId = await seedUser();
      await tx((trx) =>
        store.upsertCoreMemoryBlock(trx, { userId, key: "user_profile", content: "Name: Tim" }),
      );

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId));
      expect(blocks).toEqual([{ key: "user_profile", content: "Name: Tim" }]);
    });

    it("upsert updates existing block", async () => {
      const userId = await seedUser();
      await tx((trx) =>
        store.upsertCoreMemoryBlock(trx, { userId, key: "user_profile", content: "Name: Tim" }),
      );
      await tx((trx) =>
        store.upsertCoreMemoryBlock(trx, {
          userId,
          key: "user_profile",
          content: "Name: Tim\nRole: Engineer",
        }),
      );

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId));
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.content).toBe("Name: Tim\nRole: Engineer");
    });

    it("returns blocks ordered by key", async () => {
      const userId = await seedUser();
      await tx((trx) =>
        store.upsertCoreMemoryBlock(trx, { userId, key: "preferences", content: "Dark mode" }),
      );
      await tx((trx) =>
        store.upsertCoreMemoryBlock(trx, { userId, key: "active_projects", content: "Assistant" }),
      );
      await tx((trx) =>
        store.upsertCoreMemoryBlock(trx, { userId, key: "user_profile", content: "Tim" }),
      );

      const blocks = await tx((trx) => store.getCoreMemoryBlocks(trx, userId));
      expect(blocks.map((b) => b.key)).toEqual(["active_projects", "preferences", "user_profile"]);
    });

    it("returns empty array for unknown user", async () => {
      const blocks = await tx((trx) =>
        store.getCoreMemoryBlocks(trx, "00000000-0000-0000-0000-000000000000"),
      );
      expect(blocks).toEqual([]);
    });
  });

  describe("getLastMessageTime", () => {
    it("returns the most recent message timestamp", async () => {
      const { conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";

      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "hello",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );

      const time = await tx((trx) => store.getLastMessageTime(trx, conversationId));
      expect(time).toBeInstanceOf(Date);
    });

    it("returns undefined for conversation with no messages", async () => {
      const { conversationId } = await seedConversation();
      const time = await tx((trx) => store.getLastMessageTime(trx, conversationId));
      expect(time).toBeUndefined();
    });
  });

  describe("providers", () => {
    async function seedProvider(name = "test-provider") {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: `${name}_key`,
          plaintext: "sk-test",
        }),
      );
      return tx((trx) =>
        store.createProvider(trx, {
          name,
          type: "anthropic",
          secretId,
          attrs: {},
        }),
      );
    }

    it("creates and retrieves a provider", async () => {
      const { id } = await seedProvider();
      const provider = await tx((trx) => store.getProvider(trx, id));
      expect(provider).toMatchObject({ name: "test-provider", type: "anthropic" });
    });

    it("lists providers", async () => {
      await seedProvider("p1");
      await seedProvider("p2");
      const list = await tx((trx) => store.listProviders(trx));
      expect(list.map((p) => p.name).sort()).toEqual(["p1", "p2"]);
    });

    it("deleteProvider cascades to model_providers", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-test",
          providerId,
          position: 0,
          userSelectable: true,
        }),
      );

      await tx((trx) => store.deleteProvider(trx, providerId));

      expect(await tx((trx) => store.getProvider(trx, providerId))).toBeUndefined();
      expect(await tx((trx) => store.listProvidersForModel(trx, "claude-test"))).toEqual([]);
    });
  });

  describe("model_providers", () => {
    async function seedProviderWithSecret(name: string) {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: `${name}_key`,
          plaintext: "sk-test",
        }),
      );
      return tx((trx) =>
        store.createProvider(trx, { name, type: "anthropic", secretId, attrs: {} }),
      );
    }

    it("resolves the lowest-position provider for a model", async () => {
      const { id: fallbackId } = await seedProviderWithSecret("fallback");
      const { id: primaryId } = await seedProviderWithSecret("primary");

      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-sonnet-4",
          providerId: fallbackId,
          position: 1,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-sonnet-4",
          providerId: primaryId,
          position: 0,
          userSelectable: true,
        }),
      );

      const rows = await tx((trx) => store.listProvidersForModel(trx, "claude-sonnet-4"));
      expect(rows[0]?.name).toBe("primary");
    });

    it("returns an empty list when no provider is registered for a model", async () => {
      const rows = await tx((trx) => store.listProvidersForModel(trx, "nonexistent-model"));
      expect(rows).toEqual([]);
    });

    it("removes model_providers by provider", async () => {
      const { id: providerId } = await seedProviderWithSecret("removable");
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-a",
          providerId,
          position: 0,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-b",
          providerId,
          position: 0,
          userSelectable: true,
        }),
      );

      await tx((trx) => store.removeModelProvidersByProvider(trx, providerId));

      expect(await tx((trx) => store.listProvidersForModel(trx, "model-a"))).toEqual([]);
      expect(await tx((trx) => store.listProvidersForModel(trx, "model-b"))).toEqual([]);
    });

    it("enforces unique (model, position)", async () => {
      const { id: p1 } = await seedProviderWithSecret("p1");
      const { id: p2 } = await seedProviderWithSecret("p2");

      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-test",
          providerId: p1,
          position: 0,
          userSelectable: true,
        }),
      );

      await expect(
        tx((trx) =>
          store.addModelProvider(trx, {
            model: "claude-test",
            providerId: p2,
            position: 0,
            userSelectable: true,
          }),
        ),
      ).rejects.toThrow();
    });

    it("listProvidersForModel returns all providers in position ASC order", async () => {
      const { id: pZero } = await seedProviderWithSecret("pri");
      const { id: pOne } = await seedProviderWithSecret("sec");
      const { id: pTwo } = await seedProviderWithSecret("ter");

      // Insert out-of-order to verify sort isn't insertion-order-dependent.
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-x",
          providerId: pZero,
          position: 0,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-x",
          providerId: pTwo,
          position: 2,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-x",
          providerId: pOne,
          position: 1,
          userSelectable: true,
        }),
      );

      const list = await tx((trx) => store.listProvidersForModel(trx, "claude-x"));
      expect(list.map((p) => p.name)).toEqual(["pri", "sec", "ter"]);
    });

    it("listProvidersForModel returns empty array when model has no providers", async () => {
      expect(await tx((trx) => store.listProvidersForModel(trx, "unknown-model"))).toEqual([]);
    });

    it("listDistinctUserSelectableModels excludes internal-only models", async () => {
      const { id: p } = await seedProviderWithSecret("p");
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-public",
          providerId: p,
          position: 0,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-internal",
          providerId: p,
          position: 1,
          userSelectable: false,
        }),
      );

      expect(await tx((trx) => store.listDistinctUserSelectableModels(trx))).toEqual([
        "model-public",
      ]);
      expect(await tx((trx) => store.isModelUserSelectable(trx, "model-public"))).toBe(true);
      expect(await tx((trx) => store.isModelUserSelectable(trx, "model-internal"))).toBe(false);
      expect(await tx((trx) => store.isModelUserSelectable(trx, "model-missing"))).toBe(false);
    });
  });

  // --- Admin methods: profile CRUD, conversation listing, aliases ---

  describe("profile admin", () => {
    it("createProfile defaults memoryScope to null when not supplied", async () => {
      const userId = await seedUser();
      const profile = await tx((trx) =>
        store.createProfile(trx, {
          userId,
          name: "no-scope",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      expect(profile.memoryScope).toBeNull();
    });

    it("createProfile + getProfile round-trip a memoryScope", async () => {
      const userId = await seedUser();
      const created = await tx((trx) =>
        store.createProfile(trx, {
          userId,
          name: "coder",
          basePrompt: "p",
          model: "m",
          toolSet: [],
          memoryScope: {
            compartments: ["work", "technical"],
            trust: ["first-party"],
          },
        }),
      );
      expect(created.memoryScope).toEqual({
        compartments: ["work", "technical"],
        trust: ["first-party"],
      });
      const loaded = await tx((trx) => store.getProfile(trx, created.id));
      expect(loaded?.memoryScope).toEqual(created.memoryScope);
    });

    it("updateProfile can set and clear memoryScope", async () => {
      const userId = await seedUser();
      const { id } = await tx((trx) =>
        store.createProfile(trx, {
          userId,
          name: "p",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );

      const set = await tx((trx) =>
        store.updateProfile(trx, id, {
          memoryScope: { compartments: ["health"], trust: ["first-party"] },
        }),
      );
      expect(set.memoryScope).toEqual({ compartments: ["health"], trust: ["first-party"] });

      const cleared = await tx((trx) => store.updateProfile(trx, id, { memoryScope: null }));
      expect(cleared.memoryScope).toBeNull();
    });

    it("createProfile rejects empty compartments or trust arrays at the store boundary", async () => {
      const userId = await seedUser();
      await expect(
        tx((trx) =>
          store.createProfile(trx, {
            userId,
            name: "bad",
            basePrompt: "p",
            model: "m",
            toolSet: [],
            memoryScope: { compartments: [], trust: ["first-party"] } as any,
          }),
        ),
      ).rejects.toThrow();
    });

    it("listProfiles returns org profiles + caller's own, not other users'", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const org = (
        await tx((trx) =>
          store.createProfile(trx, {
            userId: null,
            name: "default",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      const mine = (
        await tx((trx) =>
          store.createProfile(trx, {
            userId: u1,
            name: "mine",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      await tx((trx) =>
        store.createProfile(trx, {
          userId: u2,
          name: "theirs",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );

      const visible = await tx((trx) => store.listProfiles(trx, u1));
      expect(visible.map((p) => p.id).sort()).toEqual([org, mine].sort());
    });

    it("getProfileOwner returns userId (or null for org)", async () => {
      const u = await seedUser();
      const orgId = (
        await tx((trx) =>
          store.createProfile(trx, {
            userId: null,
            name: "org",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      const mineId = (
        await tx((trx) =>
          store.createProfile(trx, {
            userId: u,
            name: "mine",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          }),
        )
      ).id;
      expect(await tx((trx) => store.getProfileOwner(trx, orgId))).toEqual({ userId: null });
      expect(await tx((trx) => store.getProfileOwner(trx, mineId))).toEqual({ userId: u });
      expect(
        await tx((trx) => store.getProfileOwner(trx, "019d0000-0000-7000-8000-000000000000")),
      ).toBeUndefined();
    });

    it("updateProfile applies partial changes and preserves unlisted fields", async () => {
      const u = await seedUser();
      const { id } = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "before",
          basePrompt: "before-prompt",
          model: "m",
          toolSet: ["a"],
        }),
      );
      const updated = await tx((trx) =>
        store.updateProfile(trx, id, { name: "after", model: "m2" }),
      );
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
      const created = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "voice-test",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      expect(created.voiceMode).toBe("auto");

      const updated = await tx((trx) =>
        store.updateProfile(trx, created.id, { voiceMode: "always" }),
      );
      expect(updated.voiceMode).toBe("always");
    });

    it("updateProfile translates unique-name collision to UniqueViolationError", async () => {
      const u = await seedUser();
      await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "taken",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      const { id: other } = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "free",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      const { UniqueViolationError } = await import("./errors.js");
      await expect(tx((trx) => store.updateProfile(trx, other, { name: "taken" }))).rejects.toThrow(
        UniqueViolationError,
      );
    });

    it("countProfileReferences counts both conversations and messages", async () => {
      const u = await seedUser();
      const { id: profileId } = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "p",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      expect(await tx((trx) => store.countProfileReferences(trx, profileId))).toEqual({
        conversations: 0,
        messages: 0,
      });

      const { id: c1 } = await tx((trx) =>
        store.createConversation(trx, { userId: u, profileId, isPrivate: true }),
      );
      await tx((trx) => store.createConversation(trx, { userId: u, profileId, isPrivate: true }));
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId: c1,
          role: "user",
          content: "hi",
          profileId,
          model: "m",
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
        }),
      );
      expect(await tx((trx) => store.countProfileReferences(trx, profileId))).toEqual({
        conversations: 2,
        messages: 1,
      });
    });

    it("deleteProfile removes the row when no references exist", async () => {
      const u = await seedUser();
      const { id } = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "temp",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) => store.deleteProfile(trx, id));
      expect(await tx((trx) => store.getProfile(trx, id))).toBeUndefined();
    });

    it("deleteProfile throws ProfileInUseError when conversations reference it", async () => {
      const u = await seedUser();
      const { id: profileId } = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "busy",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) => store.createConversation(trx, { userId: u, profileId, isPrivate: true }));
      const { ProfileInUseError } = await import("./errors.js");
      await expect(tx((trx) => store.deleteProfile(trx, profileId))).rejects.toThrow(
        ProfileInUseError,
      );
      // Profile still exists — delete rolled back.
      expect(await tx((trx) => store.getProfile(trx, profileId))).not.toBeUndefined();
    });

    it("deleteProfile throws ProfileInUseError when only message history references it", async () => {
      // The conversation has been switched away (profileId pointer gone) but stamped messages remain.
      const u = await seedUser();
      const { id: oldProfileId } = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "old",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      const { id: newProfileId } = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "new",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      const { id: convId } = await tx((trx) =>
        store.createConversation(trx, {
          userId: u,
          profileId: oldProfileId,
          isPrivate: true,
        }),
      );
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId: convId,
          role: "user",
          content: "hi",
          profileId: oldProfileId,
          model: "m",
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
        }),
      );
      // Switch the conversation to new profile — old profile now only referenced by stamped msg
      await tx((trx) => store.setConversationProfile(trx, convId, newProfileId));

      const { ProfileInUseError } = await import("./errors.js");
      await expect(tx((trx) => store.deleteProfile(trx, oldProfileId))).rejects.toThrow(
        ProfileInUseError,
      );
    });
  });

  describe("conversation admin", () => {
    it("listConversationsForUser returns user's private conversations with alias + last message preview", async () => {
      const { userId, profileId, conversationId, stamp } = await seedConversation();
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "hello there this is the last message",
          lastInboundMessageId: inboundId,
          ...stamp,
        }),
      );
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work"));

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

    it("listConversationsForUser excludes conversations from other users", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const profileId = await seedProfile();
      const c1 = (
        await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: true }))
      ).id;
      const c2 = (
        await tx((trx) => store.createConversation(trx, { userId: u2, profileId, isPrivate: true }))
      ).id;
      const inboundId = "019d0000-0000-7000-8000-000000000001";
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId: c1,
          role: "user",
          content: "u1",
          lastInboundMessageId: inboundId,
          profileId,
          model: TEST_MODEL,
        }),
      );
      await tx((trx) =>
        store.insertMessage(trx, {
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
      const userId = await seedUser();
      const profileId = await seedProfile();
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
        store.insertMessage(trx, {
          conversationId: nonPrivate,
          role: "user",
          content: "noisy",
          lastInboundMessageId: inboundId,
          profileId,
          model: TEST_MODEL,
        }),
      );
      await tx((trx) =>
        store.insertMessage(trx, {
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
      const { userId, conversationId } = await seedConversation();
      const { id: newProfileId } = await tx((trx) =>
        store.createProfile(trx, {
          userId,
          name: "other",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) => store.setConversationProfile(trx, conversationId, newProfileId));
      const conv = await tx((trx) => store.getConversation(trx, conversationId));
      expect(conv?.profileId).toBe(newProfileId);
    });
  });

  describe("aliases", () => {
    it("setAlias inserts, then updates on same conversationId", async () => {
      const { userId, conversationId } = await seedConversation();
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work"));
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "work"))).toEqual({
        conversationId,
      });

      await tx((trx) => store.setAlias(trx, userId, conversationId, "personal"));
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "work"))).toBeUndefined();
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "personal"))).toEqual({
        conversationId,
      });
    });

    it("setAlias with null clears the alias", async () => {
      const { userId, conversationId } = await seedConversation();
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work"));
      await tx((trx) => store.setAlias(trx, userId, conversationId, null));
      expect(await tx((trx) => store.findConversationByAlias(trx, userId, "work"))).toBeUndefined();
    });

    it("setAlias collision across conversations throws UniqueViolationError", async () => {
      const userId = await seedUser();
      const profileId = await seedProfile();
      const c1 = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
      ).id;
      const c2 = (
        await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
      ).id;
      await tx((trx) => store.setAlias(trx, userId, c1, "work"));
      const { UniqueViolationError } = await import("./errors.js");
      await expect(tx((trx) => store.setAlias(trx, userId, c2, "work"))).rejects.toThrow(
        UniqueViolationError,
      );
    });

    it("findConversationByAlias scopes to user", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const profileId = await seedProfile();
      const conv = (
        await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: true }))
      ).id;
      await tx((trx) => store.setAlias(trx, u1, conv, "shared"));
      // u2 searching for same alias should see nothing
      expect(await tx((trx) => store.findConversationByAlias(trx, u2, "shared"))).toBeUndefined();
    });

    it("getAliasForConversation returns the alias when set, undefined when cleared", async () => {
      const { userId, conversationId } = await seedConversation();
      expect(
        await tx((trx) => store.getAliasForConversation(trx, userId, conversationId)),
      ).toBeUndefined();
      await tx((trx) => store.setAlias(trx, userId, conversationId, "work"));
      expect(await tx((trx) => store.getAliasForConversation(trx, userId, conversationId))).toBe(
        "work",
      );
      await tx((trx) => store.setAlias(trx, userId, conversationId, null));
      expect(
        await tx((trx) => store.getAliasForConversation(trx, userId, conversationId)),
      ).toBeUndefined();
    });

    it("getAliasForConversation scopes to user (other users see undefined)", async () => {
      const u1 = await seedUser();
      const u2 = await seedUser();
      const profileId = await seedProfile();
      const conv = (
        await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: true }))
      ).id;
      await tx((trx) => store.setAlias(trx, u1, conv, "owned-by-u1"));
      expect(await tx((trx) => store.getAliasForConversation(trx, u2, conv))).toBeUndefined();
      expect(await tx((trx) => store.getAliasForConversation(trx, u1, conv))).toBe("owned-by-u1");
    });
  });

  describe("getConversationStats", () => {
    it("returns createdAt + zero counts for a fresh conversation with no messages", async () => {
      const { conversationId } = await seedConversation();
      const stats = await tx((trx) => store.getConversationStats(trx, conversationId));
      expect(stats).toBeDefined();
      expect(stats?.messageCount).toBe(0);
      expect(stats?.lastMessageAt).toBeNull();
      expect(stats?.createdAt).toBeInstanceOf(Date);
    });

    it("counts messages and surfaces the most recent createdAt", async () => {
      const { profileId, conversationId } = await seedConversation();
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: "user",
          content: "hi",
          profileId,
          model: "claude-sonnet-4-6",
          lastInboundMessageId: "00000000-0000-7000-8000-000000000001",
        }),
      );
      await tx((trx) =>
        store.insertMessage(trx, {
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

  describe("evolution: corrections", () => {
    it("getCorrections returns correction-sourced rules with channelType for profile + global", async () => {
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
          rule: "No long voice notes",
          category: "style",
          active: true,
          source: "correction",
          priority: 100,
          observationCount: 2,
          profileId: null,
          channelType: "telegram",
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

      const corrections = await tx((trx) => store.getCorrections(trx, profileId));
      expect(corrections).toHaveLength(2);
      expect(corrections.map((c) => ({ rule: c.rule, channelType: c.channelType }))).toEqual([
        { rule: "Be concise", channelType: null },
        { rule: "No long voice notes", channelType: "telegram" },
      ]);
    });

    it("upsertCorrection inserts new rule as inactive with observationCount 1", async () => {
      const result = await tx((trx) =>
        store.upsertCorrection(trx, {
          rule: "Prefer bullet points",
          category: "style",
          profileId: null,
        }),
      );

      expect(result.promoted).toBe(false);

      const { steeringRules } = await import("./schema.js");
      const rows = await db
        .select({
          rule: steeringRules.rule,
          active: steeringRules.active,
          source: steeringRules.source,
          observationCount: steeringRules.observationCount,
          priority: steeringRules.priority,
          channelType: steeringRules.channelType,
        })
        .from(steeringRules)
        .where(eq(steeringRules.id, result.id));

      expect(rows[0]).toEqual({
        rule: "Prefer bullet points",
        active: false,
        source: "correction",
        observationCount: 1,
        priority: 100,
        channelType: null,
      });
    });

    it("upsertCorrection persists channelType on a new rule when supplied", async () => {
      const result = await tx((trx) =>
        store.upsertCorrection(trx, {
          rule: "Skip markdown headings here",
          category: "style",
          profileId: null,
          channelType: "telegram",
        }),
      );

      const { steeringRules } = await import("./schema.js");
      const rows = await db
        .select({ channelType: steeringRules.channelType })
        .from(steeringRules)
        .where(eq(steeringRules.id, result.id));

      expect(rows[0]?.channelType).toBe("telegram");
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

      const result = await tx((trx) =>
        store.upsertCorrection(trx, {
          rule: "Test rule",
          category: "style",
          profileId: null,
          existingRuleId: inserted!.id,
        }),
      );

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

      const result = await tx((trx) =>
        store.upsertCorrection(trx, {
          rule: "Be concise",
          category: "style",
          profileId: null,
          existingRuleId: inserted!.id,
        }),
      );

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

      const result = await tx((trx) =>
        store.upsertCorrection(trx, {
          rule: "Already active",
          category: "domain",
          profileId: null,
          existingRuleId: inserted!.id,
        }),
      );

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

      expect(await tx((trx) => store.countActiveRules(trx, profileId))).toBe(2);
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

      const result = await tx((trx) =>
        store.replaceRules(trx, {
          oldIds,
          newRule: {
            rule: "Combined rule A+B",
            category: "style",
            profileId: null,
            channelType: null,
            priority: 100,
            observationCount: 5,
          },
        }),
      );

      // Old rules deleted
      const remaining = await db.select({ id: steeringRules.id }).from(steeringRules);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(result.id);

      // New rule has correct values, channelType persists as null
      const rows = await db
        .select({
          rule: steeringRules.rule,
          source: steeringRules.source,
          active: steeringRules.active,
          observationCount: steeringRules.observationCount,
          channelType: steeringRules.channelType,
        })
        .from(steeringRules)
        .where(eq(steeringRules.id, result.id));

      expect(rows[0]).toEqual({
        rule: "Combined rule A+B",
        source: "evolution",
        active: true,
        observationCount: 5,
        channelType: null,
      });
    });

    it("replaceRules persists channelType when supplied", async () => {
      const { steeringRules } = await import("./schema.js");
      const inserted = await db
        .insert(steeringRules)
        .values([
          {
            rule: "Avoid markdown headings on Telegram",
            category: "style",
            active: true,
            source: "correction",
            priority: 100,
            observationCount: 3,
            channelType: "telegram",
          },
          {
            rule: "Skip headings in Telegram replies",
            category: "style",
            active: true,
            source: "correction",
            priority: 100,
            observationCount: 2,
            channelType: "telegram",
          },
        ])
        .returning({ id: steeringRules.id });

      const oldIds = inserted.map((r) => r.id);

      const result = await tx((trx) =>
        store.replaceRules(trx, {
          oldIds,
          newRule: {
            rule: "Avoid markdown headings in Telegram replies",
            category: "style",
            profileId: null,
            channelType: "telegram",
            priority: 100,
            observationCount: 5,
          },
        }),
      );

      const rows = await db
        .select({
          rule: steeringRules.rule,
          channelType: steeringRules.channelType,
          source: steeringRules.source,
        })
        .from(steeringRules)
        .where(eq(steeringRules.id, result.id));

      expect(rows[0]).toEqual({
        rule: "Avoid markdown headings in Telegram replies",
        channelType: "telegram",
        source: "evolution",
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

      await tx((trx) =>
        store.replaceRules(trx, {
          oldIds: [inserted[0]!.id],
          newRule: {
            rule: "New consolidated rule",
            category: "style",
            profileId: null,
            channelType: null,
            priority: 100,
            observationCount: 2,
          },
        }),
      );

      const rules = await tx((trx) => store.getActiveRules(trx, profileId, []));
      expect(rules).toEqual([{ rule: "New consolidated rule" }]);
    });
  });

  describe("voice config", () => {
    it("returns undefined when no row is present", async () => {
      expect(await tx((trx) => store.getVoiceConfig(trx))).toBeUndefined();
    });

    it("returns the singleton row when present", async () => {
      // FK precondition: voice_config.tts_secret_id / stt_secret_id reference
      // the `secrets` table. Seed one row first; the same id is used for both
      // columns since the wizard stores a single OpenAI key for voice.
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: "openai_voice_key",
          plaintext: "sk-test-voice",
        }),
      );
      await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretId,
          sttSecretId: secretId,
          ttsProvider: "openai",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );

      const cfg = await tx((trx) => store.getVoiceConfig(trx));
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
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: "openai_voice_key",
          plaintext: "sk-test-voice",
        }),
      );
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

    it("upsertVoiceConfig rotates the singleton row in place — same id, new values", async () => {
      const { id: secretA } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key_a", plaintext: "sk-a" }),
      );
      const { id: secretB } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key_b", plaintext: "sk-b" }),
      );

      const first = await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretA,
          sttSecretId: secretA,
          ttsProvider: "openai",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );
      const firstCfg = expectDefined(
        await tx((trx) => store.getVoiceConfig(trx)),
        "first getVoiceConfig",
      );

      const second = await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretB,
          sttSecretId: secretB,
          ttsProvider: "openai_compatible",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "nova",
          ttsBaseUrl: "https://example.invalid/v1",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );

      // Same row id — UNIQUE on `singleton` forces ON CONFLICT DO UPDATE
      // to overwrite rather than insert.
      expect(second.id).toBe(first.id);

      const secondCfg = expectDefined(
        await tx((trx) => store.getVoiceConfig(trx)),
        "second getVoiceConfig",
      );
      expect(secondCfg).toMatchObject({
        id: first.id,
        ttsSecretId: secretB,
        sttSecretId: secretB,
        ttsProvider: "openai_compatible",
        ttsVoice: "nova",
        ttsBaseUrl: "https://example.invalid/v1",
      });
      // created_at survives the upsert — the row reflects when voice was
      // first configured, not last rotated. ON CONFLICT DO UPDATE only
      // writes the columns in its SET clause; created_at isn't there.
      expect(secondCfg.createdAt).toEqual(firstCfg.createdAt);
    });

    it("rejects nonsensical (provider, base_url) combos at write time", async () => {
      // CHECK constraints `chk_voice_config_{tts,stt}_base_url` enforce the
      // resolver's expectations at the DB level: openai/elevenlabs require
      // NULL base_url, openai_compatible requires NOT NULL. Hand-edited rows
      // can't sneak through and produce a silent "voice disabled until
      // construction succeeds" state at runtime.
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key", plaintext: "sk-test" }),
      );
      // PGlite's thrown Error.message is "Failed query: …"; the actual
      // postgres notice (with the constraint name) is on `.cause`. Match
      // there so the regression message names which constraint blocked
      // each row.
      const expectCheck = (promise: Promise<unknown>, constraint: string) =>
        expect(promise).rejects.toMatchObject({ cause: expect.objectContaining({ constraint }) });

      // openai + base_url IS NOT NULL → CHECK violation.
      await expectCheck(
        db.execute(sql`
          INSERT INTO voice_config (
            tts_secret_id, stt_secret_id,
            tts_provider, tts_model, tts_voice, tts_base_url,
            stt_provider, stt_model
          ) VALUES (
            ${secretId}, ${secretId},
            'openai', 'gpt-4o-mini-tts', 'alloy', 'https://example.invalid/v1',
            'openai', 'gpt-4o-mini-transcribe'
          )
        `),
        "chk_voice_config_tts_base_url",
      );
      // openai_compatible + base_url IS NULL → CHECK violation.
      await expectCheck(
        db.execute(sql`
          INSERT INTO voice_config (
            tts_secret_id, stt_secret_id,
            tts_provider, tts_model, tts_voice,
            stt_provider, stt_model
          ) VALUES (
            ${secretId}, ${secretId},
            'openai', 'gpt-4o-mini-tts', 'alloy',
            'openai_compatible', 'gpt-4o-mini-transcribe'
          )
        `),
        "chk_voice_config_stt_base_url",
      );
    });

    it("deleteVoiceConfig removes the singleton row", async () => {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "openai_voice_key", plaintext: "sk-test" }),
      );
      await tx((trx) =>
        store.upsertVoiceConfig(trx, {
          ttsSecretId: secretId,
          sttSecretId: secretId,
          ttsProvider: "openai",
          ttsModel: "gpt-4o-mini-tts",
          ttsVoice: "alloy",
          sttProvider: "openai",
          sttModel: "gpt-4o-mini-transcribe",
        }),
      );
      expect(await tx((trx) => store.getVoiceConfig(trx))).toBeDefined();

      await tx((trx) => store.deleteVoiceConfig(trx));
      expect(await tx((trx) => store.getVoiceConfig(trx))).toBeUndefined();

      // Idempotent — deleting again is a no-op, not an error.
      await tx((trx) => store.deleteVoiceConfig(trx));
    });
  });

  describe("pending_memories", () => {
    it("stages a row with content + source and returns its id", async () => {
      const userId = await seedUser();

      const { id } = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "homelab IP is 10.0.10.10",
          source: "live_retain",
        }),
      );

      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id,
        content: "homelab IP is 10.0.10.10",
        context: null,
        source: "live_retain",
        profileClass: null,
      });
      expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    });

    it("getPendingMemories surfaces the staging profile's CURRENT class via JOIN", async () => {
      // Regression for the speaker-isolation leak: rows staged by
      // profile A must drain with A's class, not the class of whichever
      // conversation triggered the Observer fire. The JOIN reads the
      // profile's current class so a class rename re-flows pending rows
      // without a backfill.
      const userId = await seedUser();
      // Seed a class and a profile bound to it.
      await tx((trx) =>
        store.createProfileClass(trx, {
          userId,
          name: "intimate",
          description: "for emotional / relationship topics",
        }),
      );
      const profile = await tx((trx) =>
        store.createProfile(trx, {
          userId,
          name: "intimate-profile",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) => store.setProfileClass(trx, profile.id, "intimate"));

      // Stage a pending row tied to that profile.
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: profile.id,
          content: "we made up after the argument",
          source: "live_retain",
        }),
      );
      // And another with no profile lineage (migration-style).
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "wife's birthday is March 15",
          source: "migration",
        }),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(2);
      const intimate = rows.find((r) => r.content === "we made up after the argument");
      const legacy = rows.find((r) => r.content === "wife's birthday is March 15");
      expect(intimate?.profileClass).toBe("intimate");
      expect(legacy?.profileClass).toBeNull();
    });

    it("getPendingMemories scopes the profile JOIN by user_id — no cross-user class contamination", async () => {
      // Defence in depth: if a `pending_memories.profile_id` ever
      // points at a profile owned by a different user (manual SQL,
      // future bug, restored backup), the JOIN must NOT surface that
      // user's `profile_class`. The composite predicate
      // (profiles.id = pm.profile_id AND profiles.user_id = pm.user_id)
      // makes such rows fall through to the LEFT JOIN's NULL on the
      // class dimension.
      const userA = await seedUser();
      const userB = await seedUser();
      // Create a class + profile under userB.
      await tx((trx) =>
        store.createProfileClass(trx, { userId: userB, name: "intimate", description: "x" }),
      );
      const profileB = await tx((trx) =>
        store.createProfile(trx, {
          userId: userB,
          name: "p",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) => store.setProfileClass(trx, profileB.id, "intimate"));
      // Stage a pending row for userA but maliciously pointing at userB's profile.
      // This shape can't arise via the supported store API, but we simulate
      // it via a raw insert to test the JOIN's defence.
      await db.execute(sql`
        INSERT INTO pending_memories (user_id, profile_id, content, source)
        VALUES (${userA}::uuid, ${profileB.id}::uuid, 'cross-user payload', 'live_retain')
      `);

      const rows = await tx((trx) => store.getPendingMemories(trx, userA));
      expect(rows).toHaveLength(1);
      // Class MUST NOT leak across the user boundary even though the
      // profile_id points at a real (other-user) profile with a class.
      expect(rows[0]?.profileClass).toBeNull();
    });

    it("getPendingMemories surfaces the staging profile's CURRENT class — re-flows on reassignment", async () => {
      // Documents the JOIN's read-current-class semantic: the pending
      // row stores `profile_id`, NOT a snapshot of `profile_class`. So
      // changing the profile's class (via setProfileClass) before the
      // drain runs means the row picks up the new class label on its
      // next read — no backfill of pending rows needed when the user
      // reorganises which profile belongs to which class.
      const userId = await seedUser();
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "intimate", description: "x" }),
      );
      await tx((trx) =>
        store.createProfileClass(trx, { userId, name: "general", description: "y" }),
      );
      const profile = await tx((trx) =>
        store.createProfile(trx, {
          userId,
          name: "p",
          basePrompt: "p",
          model: "m",
          toolSet: [],
        }),
      );
      await tx((trx) => store.setProfileClass(trx, profile.id, "intimate"));
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: profile.id,
          content: "fact staged under intimate",
          source: "live_retain",
        }),
      );
      const before = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(before[0]?.profileClass).toBe("intimate");

      // Reassign the profile to a different class — the pending row's
      // profile_id is unchanged, but the JOIN now resolves to "general".
      await tx((trx) => store.setProfileClass(trx, profile.id, "general"));
      const after = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(after[0]?.profileClass).toBe("general");

      // Clearing the class on the profile drops the row to untagged on
      // the class dimension — drain stamps no profile_class:* tag.
      await tx((trx) => store.setProfileClass(trx, profile.id, null));
      const cleared = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(cleared[0]?.profileClass).toBeNull();
    });

    it("preserves optional context", async () => {
      const userId = await seedUser();

      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "wife's birthday is March 15",
          context: "while planning a gift",
          source: "live_retain",
        }),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows[0]?.context).toBe("while planning a gift");
    });

    it("returns rows ordered oldest-first (FIFO)", async () => {
      const userId = await seedUser();

      const { id: first } = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "first",
          source: "live_retain",
        }),
      );
      // Brief delay so created_at differs measurably under PGlite.
      await new Promise((r) => setTimeout(r, 5));
      const { id: second } = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "second",
          source: "migration",
        }),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows.map((r) => r.id)).toEqual([first, second]);
    });

    it("respects the limit parameter and returns the oldest rows first", async () => {
      const userId = await seedUser();

      for (let i = 0; i < 5; i++) {
        await tx((trx) =>
          store.stagePendingMemory(trx, {
            userId,
            profileId: null,
            content: `fact ${i}`,
            source: "live_retain",
          }),
        );
        await new Promise((r) => setTimeout(r, 2));
      }

      const limited = await tx((trx) => store.getPendingMemories(trx, userId, 2));
      expect(limited).toHaveLength(2);
      expect(limited.map((r) => r.content)).toEqual(["fact 0", "fact 1"]);

      const unbounded = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(unbounded).toHaveLength(5);
    });

    it("scopes rows by userId — never returns another user's pending rows", async () => {
      const userA = await seedUser();
      const userB = await seedUser();

      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId: userA,
          profileId: null,
          content: "A's fact",
          source: "live_retain",
        }),
      );
      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId: userB,
          profileId: null,
          content: "B's fact",
          source: "live_retain",
        }),
      );

      const rowsA = await tx((trx) => store.getPendingMemories(trx, userA));
      const rowsB = await tx((trx) => store.getPendingMemories(trx, userB));
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]?.content).toBe("A's fact");
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]?.content).toBe("B's fact");
    });

    it("deletes specified rows by id", async () => {
      const userId = await seedUser();

      const a = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "fact A",
          source: "live_retain",
        }),
      );
      const b = await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "fact B",
          source: "live_retain",
        }),
      );

      await tx((trx) => store.deletePendingMemories(trx, [a.id]));

      const remaining = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(remaining.map((r) => r.id)).toEqual([b.id]);
    });

    it("deletePendingMemories with empty list is a no-op", async () => {
      const userId = await seedUser();

      await tx((trx) =>
        store.stagePendingMemory(trx, {
          userId,
          profileId: null,
          content: "fact",
          source: "live_retain",
        }),
      );

      await tx((trx) => store.deletePendingMemories(trx, []));

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(1);
    });

    it("bulk-stages multiple rows in one statement", async () => {
      const userId = await seedUser();

      await tx((trx) =>
        store.bulkStagePendingMemories(trx, [
          { userId, content: "fact A", source: "migration" },
          { userId, content: "fact B", context: "with context", source: "migration" },
          { userId, content: "fact C", source: "migration" },
        ]),
      );

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.content).sort()).toEqual(["fact A", "fact B", "fact C"]);
      expect(rows.find((r) => r.content === "fact B")?.context).toBe("with context");
      expect(rows.every((r) => r.source === "migration")).toBe(true);
    });

    it("bulkStagePendingMemories with empty array is a no-op", async () => {
      const userId = await seedUser();

      await tx((trx) => store.bulkStagePendingMemories(trx, []));

      const rows = await tx((trx) => store.getPendingMemories(trx, userId));
      expect(rows).toEqual([]);
    });

    it("rejects unknown source values", async () => {
      const userId = await seedUser();

      await expect(
        tx((trx) =>
          store.stagePendingMemory(trx, {
            userId,
            profileId: null,
            content: "fact",
            source: "bogus" as any,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("image providers", () => {
    async function seedSecret(name: string) {
      return tx((trx) => secretsStore.putSecret(trx, { name, plaintext: "sk-test" }));
    }

    it("creates a fal provider (base_url null)", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      const { id } = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "fal",
          type: "fal",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      );
      const row = await tx((trx) => store.getImageProvider(trx, id));
      expect(row).toMatchObject({ name: "fal", type: "fal", baseUrl: null });
    });

    it("creates an openai_compatible provider with base_url", async () => {
      const { id: secretId } = await seedSecret("venice_api_key");
      const { id } = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "venice",
          type: "openai_compatible",
          baseUrl: "https://api.venice.ai/api/v1",
          secretId,
          attrs: {},
        }),
      );
      const row = await tx((trx) => store.findImageProviderByName(trx, "venice"));
      expect(row).toMatchObject({
        id,
        name: "venice",
        type: "openai_compatible",
        baseUrl: "https://api.venice.ai/api/v1",
      });
    });

    it("rejects fal with a base_url at the store boundary (InvalidProviderConfigError)", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      const { InvalidProviderConfigError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.createImageProvider(trx, {
            name: "fal",
            type: "fal",
            baseUrl: "https://fal.run",
            secretId,
            attrs: {},
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidProviderConfigError);
    });

    it("rejects openai_compatible without base_url at the store boundary", async () => {
      const { id: secretId } = await seedSecret("venice_api_key");
      const { InvalidProviderConfigError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.createImageProvider(trx, {
            name: "venice",
            type: "openai_compatible",
            baseUrl: null,
            secretId,
            attrs: {},
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidProviderConfigError);
    });

    it("rejects non-https base_url", async () => {
      const { id: secretId } = await seedSecret("rogue_api_key");
      const { InvalidProviderConfigError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.createImageProvider(trx, {
            name: "rogue",
            type: "openai_compatible",
            baseUrl: "http://insecure.example.com/v1",
            secretId,
            attrs: {},
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidProviderConfigError);
    });

    it("rejects trailing-slash base_url", async () => {
      const { id: secretId } = await seedSecret("rogue_api_key");
      const { InvalidProviderConfigError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.createImageProvider(trx, {
            name: "rogue",
            type: "openai_compatible",
            baseUrl: "https://api.venice.ai/api/v1/",
            secretId,
            attrs: {},
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidProviderConfigError);
    });

    it("rejects duplicate provider names (UniqueViolationError)", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      await tx((trx) =>
        store.createImageProvider(trx, {
          name: "fal",
          type: "fal",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      );
      const { UniqueViolationError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.createImageProvider(trx, {
            name: "fal",
            type: "fal",
            baseUrl: null,
            secretId,
            attrs: {},
          }),
        ),
      ).rejects.toBeInstanceOf(UniqueViolationError);
    });

    it("lists providers ordered by name", async () => {
      const { id: s1 } = await seedSecret("fal_api_key");
      const { id: s2 } = await seedSecret("venice_api_key");
      await tx((trx) =>
        store.createImageProvider(trx, {
          name: "venice",
          type: "openai_compatible",
          baseUrl: "https://api.venice.ai/api/v1",
          secretId: s2,
          attrs: {},
        }),
      );
      await tx((trx) =>
        store.createImageProvider(trx, {
          name: "fal",
          type: "fal",
          baseUrl: null,
          secretId: s1,
          attrs: {},
        }),
      );
      const rows = await tx((trx) => store.listImageProviders(trx));
      expect(rows.map((r) => r.name)).toEqual(["fal", "venice"]);
    });

    it("deleteImageProvider cascades to image_models", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      const { id: providerId } = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "fal",
          type: "fal",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      );
      await tx((trx) =>
        store.createImageModel(trx, {
          providerId,
          name: "fal/flux-dev",
          modelString: "fal-ai/flux/dev",
          description: "default",
          capabilities: { aspectRatios: ["1:1"], seed: true },
          userSelectable: true,
        }),
      );

      await tx((trx) => store.deleteImageProvider(trx, providerId));

      expect(await tx((trx) => store.getImageProvider(trx, providerId))).toBeUndefined();
      expect(await tx((trx) => store.listImageModels(trx))).toEqual([]);
    });
  });

  describe("image models", () => {
    async function seedProvider(name = "fal") {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: `${name}_api_key`, plaintext: "sk-test" }),
      );
      return tx((trx) =>
        store.createImageProvider(trx, {
          name,
          type: "fal",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      );
    }

    it("creates and lists image models", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store.createImageModel(trx, {
          providerId,
          name: "fal/flux-dev",
          modelString: "fal-ai/flux/dev",
          description: "default",
          capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
          userSelectable: true,
        }),
      );
      const rows = await tx((trx) => store.listImageModels(trx));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "fal/flux-dev",
        modelString: "fal-ai/flux/dev",
        capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
      });
    });

    it("rejects duplicate model names (UniqueViolationError)", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store.createImageModel(trx, {
          providerId,
          name: "fal/flux-dev",
          modelString: "fal-ai/flux/dev",
          description: "default",
          capabilities: {},
          userSelectable: true,
        }),
      );
      const { UniqueViolationError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.createImageModel(trx, {
            providerId,
            name: "fal/flux-dev",
            modelString: "fal-ai/flux/dev",
            description: "duplicate",
            capabilities: {},
            userSelectable: true,
          }),
        ),
      ).rejects.toBeInstanceOf(UniqueViolationError);
    });

    it("createImageModel rejects a slug collision with a distinct existing name", async () => {
      // Two distinct full names (`fal-ai/flux-pro` and `replicate/flux-pro`)
      // both reduce to slug `flux-pro` — the LLM-facing identifier. Catch
      // at the insert boundary instead of at next-boot createImageTools.
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store.createImageModel(trx, {
          providerId,
          name: "fal-ai/flux-pro",
          modelString: "fal-ai/flux-pro",
          description: "first",
          capabilities: {},
          userSelectable: true,
        }),
      );
      const { ImageModelSlugCollisionError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.createImageModel(trx, {
            providerId,
            name: "replicate/flux-pro",
            modelString: "replicate/flux-pro",
            description: "second",
            capabilities: {},
            userSelectable: true,
          }),
        ),
      ).rejects.toBeInstanceOf(ImageModelSlugCollisionError);
    });

    it("upsertImageModelsByName rejects a slug collision in the batch", async () => {
      const { id: providerId } = await seedProvider();
      const { ImageModelSlugCollisionError } = await import("./errors.js");
      await expect(
        tx((trx) =>
          store.upsertImageModelsByName(trx, [
            {
              providerId,
              name: "fal-ai/flux-pro",
              modelString: "fal-ai/flux-pro",
              description: "first",
              capabilities: {},
              userSelectable: true,
            },
            {
              providerId,
              name: "replicate/flux-pro",
              modelString: "replicate/flux-pro",
              description: "second",
              capabilities: {},
              userSelectable: true,
            },
          ]),
        ),
      ).rejects.toBeInstanceOf(ImageModelSlugCollisionError);
    });

    it("upsertImageModelsByName skips existing names (idempotent)", async () => {
      const { id: providerId } = await seedProvider();
      const rows = [
        {
          providerId,
          name: "fal/a",
          modelString: "fal-ai/a",
          description: "first",
          capabilities: {},
          userSelectable: true,
        },
        {
          providerId,
          name: "fal/b",
          modelString: "fal-ai/b",
          description: "second",
          capabilities: {},
          userSelectable: true,
        },
      ];
      const first = await tx((trx) => store.upsertImageModelsByName(trx, rows));
      expect(first).toBe(2);

      // Re-run with the same names plus a new one. Existing rows are
      // preserved (no overwrite of `description`); only the new row is
      // inserted.
      const second = await tx((trx) =>
        store.upsertImageModelsByName(trx, [
          {
            providerId,
            name: "fal/a",
            modelString: "fal-ai/a",
            description: "edited", // would-be edit; must be ignored
            capabilities: {},
            userSelectable: true,
          },
          {
            providerId,
            name: "fal/c",
            modelString: "fal-ai/c",
            description: "third",
            capabilities: {},
            userSelectable: true,
          },
        ]),
      );
      expect(second).toBe(1);

      const all = await tx((trx) => store.listImageModels(trx));
      expect(all.map((m) => m.name).sort()).toEqual(["fal/a", "fal/b", "fal/c"]);
      const a = all.find((m) => m.name === "fal/a");
      expect(a?.description).toBe("first"); // preserved across the conflict-skip path
    });

    it("listImageModelsWithProvider filters to user_selectable when asked", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store.upsertImageModelsByName(trx, [
          {
            providerId,
            name: "fal/visible",
            modelString: "fal-ai/x",
            description: "shown",
            capabilities: {},
            userSelectable: true,
          },
          {
            providerId,
            name: "fal/hidden",
            modelString: "fal-ai/y",
            description: "hidden",
            capabilities: {},
            userSelectable: false,
          },
        ]),
      );
      const all = await tx((trx) => store.listImageModelsWithProvider(trx));
      const onlySelectable = await tx((trx) =>
        store.listImageModelsWithProvider(trx, { userSelectableOnly: true }),
      );
      expect(all.map((m) => m.name).sort()).toEqual(["fal/hidden", "fal/visible"]);
      expect(onlySelectable.map((m) => m.name)).toEqual(["fal/visible"]);
      expect(onlySelectable[0]?.provider.name).toBe("fal");
    });

    it("deleteImageModel removes a single row without touching siblings", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store.upsertImageModelsByName(trx, [
          {
            providerId,
            name: "fal/keep",
            modelString: "x",
            description: "keep",
            capabilities: {},
            userSelectable: true,
          },
          {
            providerId,
            name: "fal/drop",
            modelString: "y",
            description: "drop",
            capabilities: {},
            userSelectable: true,
          },
        ]),
      );
      const allBefore = await tx((trx) => store.listImageModels(trx));
      const drop = allBefore.find((m) => m.name === "fal/drop");
      expect(drop).toBeDefined();
      await tx((trx) => store.deleteImageModel(trx, drop!.id));
      const after = await tx((trx) => store.listImageModels(trx));
      expect(after.map((m) => m.name)).toEqual(["fal/keep"]);
    });
  });
});
