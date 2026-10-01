import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { skills } from "../../skills/store/schema.js";
import { expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleConversationStore } from "./conversations.js";
import { DrizzleProfileStore } from "./profiles.js";
import { DrizzleScheduledTaskStore } from "./scheduled-tasks.js";
import { seedProfile, seedUser } from "./test-fixtures.js";
import { DrizzleTranscriptStore } from "./transcript.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleProfileStore();
const conversationStore = new DrizzleConversationStore();
const scheduledTaskStore = new DrizzleScheduledTaskStore();
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

describe("DrizzleProfileStore", () => {
  describe("profiles", () => {
    it("creates and retrieves a profile", async () => {
      const { id } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: null,
            name: "main",
            basePrompt: "Be helpful.",
            model: "claude-test",
            toolSet: ["memory_recall"],
          })
          .then(expectOk),
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
        streamChunkChars: 4000,
        streamEdits: true,
        codingAutoapproveMode: "off",
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
        store
          .createProfile(trx, {
            userId: null,
            name: "default",
            basePrompt: "prompt",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      expect((await tx((trx) => store.getDefaultProfile(trx)))?.id).toBe(id);
    });

    it("getDefaultProfile stays on the oldest profile after it is edited", async () => {
      const create = (name: string) =>
        tx((trx) =>
          store
            .createProfile(trx, {
              userId: null,
              name,
              basePrompt: "prompt",
              model: "m",
              toolSet: [],
            })
            .then(expectOk),
        );
      const { id: first } = await create("first");
      await create("second");
      // An in-place update writes a new row version after `second`'s.
      await tx((trx) => store.updateProfile(trx, first, { model: "m2" }).then(expectOk));

      expect((await tx((trx) => store.getDefaultProfile(trx)))?.id).toBe(first);
    });

    it("enforces unique org profile name (user_id null)", async () => {
      await tx((trx) =>
        store
          .createProfile(trx, {
            userId: null,
            name: "dup",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      const dup = await tx((trx) =>
        store.createProfile(trx, {
          userId: null,
          name: "dup",
          basePrompt: "p2",
          model: "m2",
          toolSet: [],
        }),
      );
      expect(dup).toEqual(err({ kind: "profile_name_taken" }));
    });

    it("allows same name across different users (and between org and user)", async () => {
      const u1 = await seedUser(tx);
      const u2 = await seedUser(tx);
      await tx((trx) =>
        store
          .createProfile(trx, {
            userId: null,
            name: "coder",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u1,
            name: "coder",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u2,
            name: "coder",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      // No throw — same name is allowed when (user_id, name) differs.
    });

    it("insertOrRecoverProfile recovers a repeated org profile name without overwriting it", async () => {
      const params = { userId: null, name: "assistant", model: "m", toolSet: [] };
      const first = await tx((trx) =>
        store.insertOrRecoverProfile(trx, { ...params, basePrompt: "first" }),
      );
      const second = await tx((trx) =>
        store.insertOrRecoverProfile(trx, { ...params, basePrompt: "second" }),
      );

      expect(first.kind).toBe("new");
      expect(second).toEqual({ kind: "recovered", id: first.id });
      const stored = await tx((trx) => store.getProfile(trx, first.id));
      expect(stored?.basePrompt).toBe("first");
    });

    it("insertOrRecoverProfile keys on the owner as well as the name", async () => {
      const userId = await seedUser(tx);
      const params = { name: "assistant", basePrompt: "p", model: "m", toolSet: [] };
      const org = await tx((trx) => store.insertOrRecoverProfile(trx, { ...params, userId: null }));
      const own = await tx((trx) => store.insertOrRecoverProfile(trx, { ...params, userId }));

      expect(own.kind).toBe("new");
      expect(own.id).not.toBe(org.id);
    });

    it("rejects duplicate name within the same user", async () => {
      const u = await seedUser(tx);
      await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "mine",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      const dup = await tx((trx) =>
        store.createProfile(trx, {
          userId: u,
          name: "mine",
          basePrompt: "p2",
          model: "m2",
          toolSet: [],
        }),
      );
      expect(dup).toEqual(err({ kind: "profile_name_taken" }));
    });
  });

  describe("profile admin", () => {
    it("createProfile defaults memoryScope to null when not supplied", async () => {
      const userId = await seedUser(tx);
      const profile = await tx((trx) =>
        store
          .createProfile(trx, {
            userId,
            name: "no-scope",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      expect(profile.memoryScope).toBeNull();
    });

    it("createProfile + getProfile round-trip a memoryScope", async () => {
      const userId = await seedUser(tx);
      const created = await tx((trx) =>
        store
          .createProfile(trx, {
            userId,
            name: "coder",
            basePrompt: "p",
            model: "m",
            toolSet: [],
            memoryScope: {
              compartments: ["work", "technical"],
              trust: ["first-party"],
            },
          })
          .then(expectOk),
      );
      expect(created.memoryScope).toEqual({
        compartments: ["work", "technical"],
        trust: ["first-party"],
      });
      const loaded = await tx((trx) => store.getProfile(trx, created.id));
      expect(loaded?.memoryScope).toEqual(created.memoryScope);
    });

    it("updateProfile can set and clear memoryScope", async () => {
      const userId = await seedUser(tx);
      const { id } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId,
            name: "p",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );

      const set = await tx((trx) =>
        store
          .updateProfile(trx, id, {
            memoryScope: { compartments: ["health"], trust: ["first-party"] },
          })
          .then(expectOk),
      );
      expect(set.memoryScope).toEqual({ compartments: ["health"], trust: ["first-party"] });

      const cleared = await tx((trx) =>
        store.updateProfile(trx, id, { memoryScope: null }).then(expectOk),
      );
      expect(cleared.memoryScope).toBeNull();
    });

    it("createProfile rejects empty compartments or trust arrays at the store boundary", async () => {
      const userId = await seedUser(tx);
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
      const u1 = await seedUser(tx);
      const u2 = await seedUser(tx);
      const org = (
        await tx((trx) =>
          store
            .createProfile(trx, {
              userId: null,
              name: "default",
              basePrompt: "p",
              model: "m",
              toolSet: [],
            })
            .then(expectOk),
        )
      ).id;
      const mine = (
        await tx((trx) =>
          store
            .createProfile(trx, {
              userId: u1,
              name: "mine",
              basePrompt: "p",
              model: "m",
              toolSet: [],
            })
            .then(expectOk),
        )
      ).id;
      await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u2,
            name: "theirs",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );

      const visible = await tx((trx) => store.listProfiles(trx, u1));
      expect(visible.map((p) => p.id).sort()).toEqual([org, mine].sort());
    });

    it("getProfileOwner returns userId (or null for org)", async () => {
      const u = await seedUser(tx);
      const orgId = (
        await tx((trx) =>
          store
            .createProfile(trx, {
              userId: null,
              name: "org",
              basePrompt: "p",
              model: "m",
              toolSet: [],
            })
            .then(expectOk),
        )
      ).id;
      const mineId = (
        await tx((trx) =>
          store
            .createProfile(trx, {
              userId: u,
              name: "mine",
              basePrompt: "p",
              model: "m",
              toolSet: [],
            })
            .then(expectOk),
        )
      ).id;
      expect(await tx((trx) => store.getProfileOwner(trx, orgId))).toEqual({ userId: null });
      expect(await tx((trx) => store.getProfileOwner(trx, mineId))).toEqual({ userId: u });
      expect(
        await tx((trx) => store.getProfileOwner(trx, "019d0000-0000-7000-8000-000000000000")),
      ).toBeUndefined();
    });

    it("updateProfile applies partial changes and preserves unlisted fields", async () => {
      const u = await seedUser(tx);
      const { id } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "before",
            basePrompt: "before-prompt",
            model: "m",
            toolSet: ["a"],
          })
          .then(expectOk),
      );
      const updated = await tx((trx) =>
        store.updateProfile(trx, id, { name: "after", model: "m2" }).then(expectOk),
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
      const u = await seedUser(tx);
      const created = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "voice-test",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      expect(created.voiceMode).toBe("auto");

      const updated = await tx((trx) =>
        store.updateProfile(trx, created.id, { voiceMode: "always" }).then(expectOk),
      );
      expect(updated.voiceMode).toBe("always");
    });

    it("updateProfile reports a unique-name collision as profile_name_taken", async () => {
      const u = await seedUser(tx);
      await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "taken",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      const { id: other } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "free",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      expect(await tx((trx) => store.updateProfile(trx, other, { name: "taken" }))).toEqual(
        err({ kind: "profile_name_taken" }),
      );
      expect((await tx((trx) => store.getProfile(trx, other)))?.name).toBe("free");
    });

    it("countProfileReferences counts both conversations and messages", async () => {
      const u = await seedUser(tx);
      const { id: profileId } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "p",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      expect(await tx((trx) => store.countProfileReferences(trx, profileId))).toEqual({
        conversations: 0,
        messages: 0,
      });

      const { id: c1 } = await tx((trx) =>
        conversationStore.createConversation(trx, { userId: u, profileId, isPrivate: true }),
      );
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId: u, profileId, isPrivate: true }),
      );
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
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
      const u = await seedUser(tx);
      const { id } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "temp",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) => store.deleteProfile(trx, id).then(expectOk));
      expect(await tx((trx) => store.getProfile(trx, id))).toBeUndefined();
    });

    it("deleteProfile refuses while conversations reference it", async () => {
      const u = await seedUser(tx);
      const { id: profileId } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "busy",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      await tx((trx) =>
        conversationStore.createConversation(trx, { userId: u, profileId, isPrivate: true }),
      );
      expect(await tx((trx) => store.deleteProfile(trx, profileId))).toEqual(
        err({ kind: "profile_in_use" }),
      );
      expect(await tx((trx) => store.getProfile(trx, profileId))).not.toBeUndefined();
    });

    it("deleteProfile refuses when only message history references it", async () => {
      // The conversation has been switched away (profileId pointer gone) but stamped messages remain.
      const u = await seedUser(tx);
      const { id: oldProfileId } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "old",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      const { id: newProfileId } = await tx((trx) =>
        store
          .createProfile(trx, {
            userId: u,
            name: "new",
            basePrompt: "p",
            model: "m",
            toolSet: [],
          })
          .then(expectOk),
      );
      const { id: convId } = await tx((trx) =>
        conversationStore.createConversation(trx, {
          userId: u,
          profileId: oldProfileId,
          isPrivate: true,
        }),
      );
      await tx((trx) =>
        transcriptStore.insertMessage(trx, {
          conversationId: convId,
          role: "user",
          content: "hi",
          profileId: oldProfileId,
          model: "m",
          lastInboundMessageId: "019d0000-0000-7000-8000-000000000001",
        }),
      );
      // Switch the conversation to new profile — old profile now only referenced by stamped msg
      await tx((trx) => conversationStore.setConversationProfile(trx, convId, newProfileId));

      expect(await tx((trx) => store.deleteProfile(trx, oldProfileId))).toEqual(
        err({ kind: "profile_in_use" }),
      );
    });

    it("deleteProfile refuses while a scheduled task runs as it", async () => {
      const userId = await seedUser(tx);
      const profileId = await seedProfile(tx);
      await tx((trx) =>
        scheduledTaskStore.createScheduledTask(trx, {
          userId,
          profileId,
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "brief me",
          nextRunAt: new Date("2026-06-01T09:00:00Z"),
          enabled: true,
          catchupMissed: false,
          source: "agent",
        }),
      );
      expect(await tx((trx) => store.deleteProfile(trx, profileId))).toEqual(
        err({ kind: "profile_in_use" }),
      );
    });

    it("deleteProfile refuses while a scheduled skill runs as it", async () => {
      const userId = await seedUser(tx);
      const profileId = await seedProfile(tx);
      await db.insert(skills).values({
        name: "briefing",
        tier: "wasm",
        riskTier: "notify",
        effects: [],
        schedule: "0 9 * * *",
        nextRunAt: new Date("2026-06-01T09:00:00Z"),
        runAsUserId: userId,
        runAsProfileId: profileId,
        gitSha: "sha",
        inputs: { type: "object" },
      });
      expect(await tx((trx) => store.deleteProfile(trx, profileId))).toEqual(
        err({ kind: "profile_in_use" }),
      );
      expect(await tx((trx) => store.getProfile(trx, profileId))).toBeDefined();
    });

    it("deleteProfile refuses while a steering rule is scoped to it", async () => {
      const profileId = await seedProfile(tx);
      const { steeringRules } = await import("./schema.js");
      await db.insert(steeringRules).values({
        rule: "Be concise",
        category: "style",
        active: true,
        source: "manual",
        priority: 2,
        observationCount: 0,
        profileId,
      });
      expect(await tx((trx) => store.deleteProfile(trx, profileId))).toEqual(
        err({ kind: "profile_in_use" }),
      );
    });
  });
});
