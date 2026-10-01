/**
 * `resolveSkillRunAs` promises a skill run the same memory scoping and
 * staging a chat turn gets, so this runs it over the real agent store and
 * the real `buildTurnService` on PGlite: the profile's `memoryScope`, the
 * restricted classes and the `pending_memories` row all come from the
 * database, as in a turn. Only Hindsight and the file store are mocked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { type ProfileMemoryScope, pendingMemories } from "../agent/store/schema.js";
import type { Database, Transactor } from "../db/index.js";
import { expectOk } from "../test/assertions.js";
import { mockFilesService, mockMemoryProvider } from "../test/factories.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { resolveSkillRunAs } from "./run-as.js";
import type { SkillRunIdentity } from "./store/index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const agentStore = new DrizzleAgentStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

async function seedIdentity(
  opts: { memoryScope?: ProfileMemoryScope; profileClass?: string; restrictedClass?: string } = {},
): Promise<SkillRunIdentity> {
  return tx(async (trx) => {
    const user = await agentStore.createUser(trx);
    const profile = await agentStore
      .createProfile(trx, {
        userId: user.id,
        name: "persona",
        basePrompt: "",
        model: "m",
        toolSet: [],
        ...(opts.memoryScope && { memoryScope: opts.memoryScope }),
      })
      .then(expectOk);
    for (const name of [opts.profileClass, opts.restrictedClass]) {
      if (name === undefined) continue;
      await agentStore
        .createProfileClass(trx, { userId: user.id, name, description: name })
        .then(expectOk);
    }
    if (opts.profileClass !== undefined) {
      await agentStore.setProfileClass(trx, profile.id, opts.profileClass).then(expectOk);
    }
    if (opts.restrictedClass !== undefined) {
      await agentStore.setProfileClassRestricted(trx, user.id, opts.restrictedClass, true);
    }
    return { userId: user.id, profileId: profile.id };
  });
}

function deps() {
  return {
    runInTx: tx,
    agentStore,
    memory: mockMemoryProvider(),
    fileService: mockFilesService(),
  };
}

describe("resolveSkillRunAs", () => {
  it("runs as the stored user, on the shared file workspace", async () => {
    const identity = await seedIdentity();
    const d = deps();

    const runAs = await resolveSkillRunAs(d, identity);

    expect(runAs.userId).toBe(identity.userId);
    expect(runAs.service.files).toBe(d.fileService);
  });

  it("recalls from the user's bank under the profile's memoryScope", async () => {
    const identity = await seedIdentity({
      memoryScope: { compartments: ["work"], trust: ["first-party"] },
    });
    const d = deps();

    const runAs = await resolveSkillRunAs(d, identity);
    await runAs.service.memory.recall("standup notes");

    expect(d.memory.recall).toHaveBeenCalledWith(identity.userId, "standup notes", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:work"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
          ],
        },
      ],
    });
  });

  it("recall excludes the user's restricted classes", async () => {
    const identity = await seedIdentity({ restrictedClass: "intimate" });
    const d = deps();

    const runAs = await resolveSkillRunAs(d, identity);
    await runAs.service.memory.recall("anything");

    expect(d.memory.recall).toHaveBeenCalledWith(identity.userId, "anything", {
      tagGroups: [{ and: [{ not: { tags: ["profile_class:intimate"], match: "any" } }] }],
    });
  });

  it("remember stages into pending_memories under the user and profile, not Hindsight", async () => {
    const identity = await seedIdentity({ profileClass: "work" });
    const d = deps();

    const runAs = await resolveSkillRunAs(d, identity);
    await runAs.service.memory.stageRetain("the build is green", {
      context: "from skill 'ci_watch'",
      source: "skill",
      skillName: "ci_watch",
    });

    expect(d.memory.retain).not.toHaveBeenCalled();
    const rows = await db.select().from(pendingMemories);
    expect(rows).toMatchObject([
      {
        userId: identity.userId,
        profileId: identity.profileId,
        content: "the build is green",
        context: "from skill 'ci_watch'",
        source: "skill",
        skillName: "ci_watch",
      },
    ]);
    const pending = await tx((trx) => agentStore.getPendingMemories(trx, identity.userId));
    expect(pending.map((p) => [p.profileClass, p.skillName])).toEqual([["work", "ci_watch"]]);
  });

  it("refuses a profile that no longer exists rather than run unscoped", async () => {
    const identity = await seedIdentity();

    await expect(
      resolveSkillRunAs(deps(), {
        userId: identity.userId,
        profileId: "019d0000-0000-7000-8000-00000000dead",
      }),
    ).rejects.toThrow(/profile 019d0000-0000-7000-8000-00000000dead not found/);
  });
});
