/**
 * Instruction rules and retirement in `DrizzleAgentStore`
 * (design/evolution.md → Explicit Instructions): who sees a rule, setting and
 * retiring it, the review list, and the learned-rule paths that skip a
 * retired row.
 */

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { assertKind, expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { RuleGroupChangedError } from "./errors.js";
import { DrizzleAgentStore, INSTRUCTION_RULE_LIMIT } from "./index.js";
import { type SteeringRuleSourceValue, steeringRules, users } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleAgentStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

async function seedUser(): Promise<string> {
  return (await tx((trx) => store.createUser(trx))).id;
}

async function seedProfile(name = "main"): Promise<string> {
  return (
    await tx((trx) =>
      store.createProfile(trx, { userId: null, name, basePrompt: "", model: "m", toolSet: [] }),
    )
  ).id;
}

interface RowParams {
  rule: string;
  source: SteeringRuleSourceValue;
  active?: boolean;
  /** When it was retired; `true` for now. */
  retired?: true | Date;
  userId?: string | null;
  profileId?: string | null;
  channelType?: string | null;
  category?: string;
  priority?: number;
  observationCount?: number;
}

/** A row written past the store, as an operator, seeding or the Observer left it. */
async function row(params: RowParams): Promise<string> {
  const instruction = params.source === "instruction";
  const [inserted] = await db
    .insert(steeringRules)
    .values({
      rule: params.rule,
      category: params.category ?? "style",
      active: params.active ?? params.retired === undefined,
      source: params.source,
      priority: params.priority ?? 100,
      observationCount: params.observationCount ?? 2,
      profileId: params.profileId ?? null,
      channelType: params.channelType ?? null,
      userId: instruction ? expectDefined(params.userId, "instruction user") : null,
      quote: instruction ? `quoted: ${params.rule}` : null,
      retractedAt:
        params.retired === undefined ? null : params.retired === true ? new Date() : params.retired,
    })
    .returning({ id: steeringRules.id });
  return expectDefined(inserted, params.rule).id;
}

async function stateOf(id: string) {
  const [state] = await db
    .select({ active: steeringRules.active, retractedAt: steeringRules.retractedAt })
    .from(steeringRules)
    .where(eq(steeringRules.id, id));
  const { active, retractedAt } = expectDefined(state, id);
  return active ? "live" : retractedAt === null ? "learning" : "retired";
}

function set(params: {
  rule: string;
  userId: string;
  profileId?: string | null;
  channelType?: string | null;
}) {
  return tx((trx) =>
    store.setInstructionRule(trx, {
      rule: params.rule,
      category: "style",
      userId: params.userId,
      profileId: params.profileId ?? null,
      channelType: params.channelType ?? null,
      quote: `please: ${params.rule}`,
    }),
  );
}

async function rendered(scope: { profileId: string; userId: string | null }) {
  return (await tx((trx) => store.getActiveRules(trx, scope))).map((r) => r.rule);
}

describe("getActiveRules", () => {
  it("renders the conversation user's instruction rules and no other user's", async () => {
    const profileId = await seedProfile();
    const userId = await seedUser();
    const otherUserId = await seedUser();
    await row({ rule: "Mine", source: "instruction", userId });
    await row({ rule: "Theirs", source: "instruction", userId: otherUserId });
    await row({ rule: "Learned", source: "correction" });

    expect((await rendered({ profileId, userId })).sort()).toEqual(["Learned", "Mine"]);
    expect((await rendered({ profileId, userId: otherUserId })).sort()).toEqual([
      "Learned",
      "Theirs",
    ]);
  });

  it("renders no instruction rule for a scope that withholds them", async () => {
    const profileId = await seedProfile();
    const userId = await seedUser();
    await row({ rule: "Mine", source: "instruction", userId });
    await row({ rule: "Operator", source: "manual", observationCount: 0 });

    expect(await rendered({ profileId, userId: null })).toEqual(["Operator"]);
  });

  it("lists the newest first on equal scope and priority", async () => {
    const profileId = await seedProfile();
    await row({ rule: "Older", source: "correction" });
    await row({ rule: "Newer", source: "correction" });
    await row({ rule: "Default, older", source: "seed", priority: 50, channelType: "telegram" });
    await row({ rule: "Default, newer", source: "seed", priority: 50, channelType: "telegram" });

    expect(await rendered({ profileId, userId: null })).toEqual([
      "Default, newer",
      "Default, older",
      "Newer",
      "Older",
    ]);
  });

  it("never renders a retired rule", async () => {
    const profileId = await seedProfile();
    const userId = await seedUser();
    await row({ rule: "Retired instruction", source: "instruction", userId, retired: true });
    await row({ rule: "Retired learned", source: "correction", retired: true });

    expect(await rendered({ profileId, userId })).toEqual([]);
  });
});

describe("setInstructionRule", () => {
  it("writes a live instruction rule for the user and scope", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();

    const result = await set({
      rule: "No bullet points.",
      userId,
      profileId,
      channelType: "telegram",
    });

    assertKind(result, "new");
    const [written] = await db.select().from(steeringRules).where(eq(steeringRules.id, result.id));
    expect(written).toMatchObject({
      rule: "No bullet points.",
      category: "style",
      source: "instruction",
      active: true,
      priority: 100,
      observationCount: 1,
      userId,
      profileId,
      channelType: "telegram",
      quote: "please: No bullet points.",
      retractedAt: null,
      createdAt: result.createdAt,
    });
  });

  it("is idempotent: a second set returns the first row", async () => {
    const userId = await seedUser();

    const first = await set({ rule: "No bullet points.", userId });
    const second = await set({ rule: "No bullet points.", userId });

    assertKind(first, "new");
    expect(second).toEqual({ kind: "existing", id: first.id, createdAt: first.createdAt });
    expect(await db.select().from(steeringRules)).toHaveLength(1);
  });

  it("meets the unique index on normalized text, so a respelled set returns the live row", async () => {
    const userId = await seedUser();

    const first = await set({ rule: "No bullet points.", userId });
    const respelled = await set({ rule: "  no BULLET\n points. ", userId });

    assertKind(first, "new");
    expect(respelled).toMatchObject({ kind: "existing", id: first.id });
  });

  it("keeps one row per scope and per user", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const profileId = await seedProfile();

    const kinds = [
      await set({ rule: "Be brief.", userId }),
      await set({ rule: "Be brief.", userId, channelType: "telegram" }),
      await set({ rule: "Be brief.", userId, profileId }),
      await set({ rule: "Be brief.", userId: otherUserId }),
    ].map((r) => r.kind);

    expect(kinds).toEqual(["new", "new", "new", "new"]);
  });

  it("sets a rule again after it was retired", async () => {
    const userId = await seedUser();
    const retired = await row({ rule: "Be brief.", source: "instruction", userId, retired: true });

    const result = await set({ rule: "Be brief.", userId });

    assertKind(result, "new");
    expect(result.id).not.toBe(retired);
  });

  it("retires a learned rule with the same text and scope, active or learning", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    const active = await row({ rule: "no emoji", source: "correction" });
    const learning = await row({
      rule: "No  emoji",
      source: "correction",
      active: false,
      observationCount: 1,
    });
    const merged = await row({ rule: "No emoji", source: "evolution" });
    const otherChannel = await row({
      rule: "No emoji",
      source: "correction",
      channelType: "telegram",
    });
    const otherProfile = await row({ rule: "No emoji", source: "correction", profileId });
    const operator = await row({ rule: "No emoji", source: "manual", observationCount: 0 });

    await set({ rule: "No emoji", userId });

    expect({
      active: await stateOf(active),
      learning: await stateOf(learning),
      merged: await stateOf(merged),
      otherChannel: await stateOf(otherChannel),
      otherProfile: await stateOf(otherProfile),
      operator: await stateOf(operator),
    }).toEqual({
      active: "retired",
      learning: "retired",
      merged: "retired",
      otherChannel: "live",
      otherProfile: "live",
      operator: "live",
    });
  });

  describe("the limit", () => {
    /** `count` live instruction rules for the user, the first in a restricted persona on Telegram. */
    async function fill(userId: string, count: number): Promise<void> {
      const profileId = await seedProfile("restricted");
      for (let i = 0; i < count; i++) {
        await set({
          rule: `Rule ${i}`,
          userId,
          ...(i === 0 && { profileId, channelType: "telegram" }),
        });
      }
    }

    it("writes nothing at the limit, counting only the user's live instruction rules", async () => {
      const userId = await seedUser();
      const otherUserId = await seedUser();
      await fill(userId, INSTRUCTION_RULE_LIMIT - 1);
      await row({ rule: "Retired", source: "instruction", userId, retired: true });
      await row({ rule: "Theirs", source: "instruction", userId: otherUserId });
      await row({ rule: "Learned", source: "correction" });

      expect(await set({ rule: "Last", userId })).toMatchObject({ kind: "new" });
      expect(await set({ rule: "Past it", userId })).toEqual({
        kind: "at_limit",
        live: INSTRUCTION_RULE_LIMIT,
      });
      expect(
        await db.select().from(steeringRules).where(eq(steeringRules.rule, "Past it")),
      ).toEqual([]);
    });

    it("still answers a set of a rule the user holds", async () => {
      const userId = await seedUser();
      const first = await set({ rule: "One", userId });
      await fill(userId, INSTRUCTION_RULE_LIMIT - 1);

      assertKind(first, "new");
      expect(await set({ rule: " one ", userId })).toEqual({
        kind: "existing",
        id: first.id,
        createdAt: first.createdAt,
      });
    });

    it("answers the same text in another scope, another user's or a retired one with the limit", async () => {
      const userId = await seedUser();
      const otherUserId = await seedUser();
      await fill(userId, INSTRUCTION_RULE_LIMIT - 1);
      await set({ rule: "On Telegram", userId, channelType: "telegram" });
      await row({ rule: "Theirs", source: "instruction", userId: otherUserId });
      await row({ rule: "Withdrawn", source: "instruction", userId, retired: true });
      const atLimit = { kind: "at_limit", live: INSTRUCTION_RULE_LIMIT };

      expect(await set({ rule: "On Telegram", userId })).toEqual(atLimit);
      expect(await set({ rule: "Theirs", userId })).toEqual(atLimit);
      expect(await set({ rule: "Withdrawn", userId })).toEqual(atLimit);
    });

    it("retires a learned twin of a rule the user holds", async () => {
      const userId = await seedUser();
      await set({ rule: "No emoji", userId });
      await fill(userId, INSTRUCTION_RULE_LIMIT - 1);
      const twin = await row({ rule: "No emoji", source: "correction" });

      expect(await set({ rule: "No emoji", userId })).toMatchObject({ kind: "existing" });
      expect(await stateOf(twin)).toBe("retired");
    });

    it("leaves a learned twin live when the set is refused", async () => {
      const userId = await seedUser();
      await fill(userId, INSTRUCTION_RULE_LIMIT);
      const twin = await row({ rule: "No emoji", source: "correction" });

      expect(await set({ rule: "No emoji", userId })).toMatchObject({ kind: "at_limit" });
      expect(await stateOf(twin)).toBe("live");
    });
  });

  it("retires a learned twin of a rule already set", async () => {
    const userId = await seedUser();
    await set({ rule: "No emoji", userId });
    const twin = await row({ rule: "No emoji", source: "evolution" });

    expect(await set({ rule: "No emoji", userId })).toMatchObject({ kind: "existing" });
    expect(await stateOf(twin)).toBe("retired");
  });

  it("keeps an already retired learned twin's retirement time", async () => {
    const userId = await seedUser();
    const retiredAt = new Date("2026-01-01T00:00:00Z");
    const twin = await row({ rule: "No emoji", source: "correction", retired: retiredAt });

    await set({ rule: "No emoji", userId });

    const [after] = await db
      .select({ retractedAt: steeringRules.retractedAt })
      .from(steeringRules)
      .where(eq(steeringRules.id, twin));
    expect(after?.retractedAt).toEqual(retiredAt);
  });

  it("goes when its user is deleted", async () => {
    const userId = await seedUser();
    await set({ rule: "No emoji", userId });

    await db.delete(users).where(eq(users.id, userId));

    expect(await db.select().from(steeringRules)).toEqual([]);
  });
});

describe("retireRulesByText", () => {
  function retire(params: {
    text: string;
    userId: string;
    profileId: string;
    restricted?: boolean;
  }) {
    return tx((trx) =>
      store.retireRulesByText(trx, {
        text: params.text,
        userId: params.userId,
        profileId: params.profileId,
        restricted: params.restricted ?? false,
      }),
    );
  }

  it("retires every visible live match of a removable source, whatever its spelling or scope", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    const instruction = await row({ rule: "No emoji.", source: "instruction", userId });
    const onTelegram = await row({
      rule: "no  EMOJI.",
      source: "instruction",
      userId,
      channelType: "telegram",
    });
    const learned = await row({ rule: "No emoji.", source: "correction", profileId });
    const merged = await row({ rule: "No emoji.", source: "evolution" });

    const result = await retire({ text: " No emoji. ", userId, profileId });

    expect(result.retired.map((r) => r.id).sort()).toEqual(
      [instruction, onTelegram, learned, merged].sort(),
    );
    expect(result.kept).toEqual([]);
    for (const r of result.retired) {
      expect(r.retractedAt).toBeInstanceOf(Date);
      expect(await stateOf(r.id)).toBe("retired");
    }
    expect(await rendered({ profileId, userId })).toEqual([]);
  });

  it("is idempotent: a second retire changes nothing and returns the retired rows as kept", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    const id = await row({ rule: "No emoji.", source: "instruction", userId });

    const first = await retire({ text: "No emoji.", userId, profileId });
    const second = await retire({ text: "No emoji.", userId, profileId });

    const retired = expectDefined(first.retired[0], "retired");
    expect(retired.id).toBe(id);
    expect(second).toEqual({ retired: [], kept: [retired] });
  });

  it("can't retire an operator rule or a channel default", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    const operator = await row({ rule: "Avoid tables.", source: "manual", observationCount: 0 });
    const channelDefault = await row({
      rule: "Avoid tables.",
      source: "seed",
      priority: 50,
      observationCount: 0,
      channelType: "telegram",
    });

    const result = await retire({ text: "Avoid tables.", userId, profileId });

    expect(result.retired).toEqual([]);
    expect(result.kept.map((r) => [r.id, r.source, r.retractedAt])).toEqual([
      [channelDefault, "seed", null],
      [operator, "manual", null],
    ]);
    expect([await stateOf(operator), await stateOf(channelDefault)]).toEqual(["live", "live"]);
  });

  it("leaves a rule still learning, another user's and another profile's", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const profileId = await seedProfile();
    const otherProfileId = await seedProfile("other");
    const learning = await row({
      rule: "No emoji.",
      source: "correction",
      active: false,
      observationCount: 1,
    });
    const theirs = await row({ rule: "No emoji.", source: "instruction", userId: otherUserId });
    const otherProfile = await row({
      rule: "No emoji.",
      source: "instruction",
      userId,
      profileId: otherProfileId,
    });

    const result = await retire({ text: "No emoji.", userId, profileId });

    expect(result).toEqual({ retired: [], kept: [] });
    expect([await stateOf(learning), await stateOf(theirs), await stateOf(otherProfile)]).toEqual([
      "learning",
      "live",
      "live",
    ]);
  });

  it("in a restricted scope, retires only the rules scoped to the profile", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    const own = await row({ rule: "No emoji.", source: "instruction", userId, profileId });
    const wider = await row({ rule: "No emoji.", source: "instruction", userId });

    const result = await retire({ text: "No emoji.", userId, profileId, restricted: true });

    expect(result.retired.map((r) => r.id)).toEqual([own]);
    expect(result.kept.map((r) => [r.id, r.profileId, r.retractedAt])).toEqual([
      [wider, null, null],
    ]);
  });
});

describe("listRules", () => {
  it("lists the live rules in render order, the learning ones, and the latest retired", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const profileId = await seedProfile();
    const otherProfileId = await seedProfile("other");
    await row({ rule: "Operator", source: "manual", observationCount: 0 });
    await row({ rule: "Mine", source: "instruction", userId });
    await row({ rule: "Theirs", source: "instruction", userId: otherUserId });
    await row({ rule: "Elsewhere", source: "instruction", userId, profileId: otherProfileId });
    await row({ rule: "Learned", source: "correction" });
    await row({ rule: "Learning", source: "correction", active: false, observationCount: 1 });
    await row({
      rule: "Learning elsewhere",
      source: "correction",
      active: false,
      observationCount: 1,
      profileId: otherProfileId,
    });
    await row({ rule: "Switched off", source: "seed", active: false, channelType: "telegram" });
    await row({ rule: "Retired second", source: "correction", retired: new Date(2_000) });
    await row({ rule: "Retired first", source: "instruction", userId, retired: new Date(1_000) });
    await row({
      rule: "Retired theirs",
      source: "instruction",
      userId: otherUserId,
      retired: true,
    });

    const review = await tx((trx) => store.listRules(trx, { profileId, userId }));

    expect(review.live.map((r) => [r.rule, r.section])).toEqual([
      ["Operator", "always"],
      ["Mine", "from_user"],
      ["Learned", "learned"],
    ]);
    expect(review.learning.map((r) => r.rule)).toEqual(["Learning"]);
    expect(review.retired.map((r) => r.rule)).toEqual(["Retired second", "Retired first"]);
    expect(expectDefined(review.live[1], "mine")).toMatchObject({
      source: "instruction",
      category: "style",
      profileId: null,
      channelType: null,
      observationCount: 2,
      quote: "quoted: Mine",
      retractedAt: null,
    });
  });

  it("lists the 20 most recently retired", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    for (let i = 0; i < 21; i++) {
      await row({ rule: `Retired ${i}`, source: "correction", retired: true });
    }

    const { retired } = await tx((trx) => store.listRules(trx, { profileId, userId }));

    expect(retired).toHaveLength(20);
    expect(retired.map((r) => r.rule)).not.toContain("Retired 0");
  });
});

describe("learned rules skip a retired row", () => {
  it("getCorrections lists none", async () => {
    const profileId = await seedProfile();
    await row({ rule: "Live", source: "correction" });
    await row({ rule: "Learning", source: "correction", active: false, observationCount: 1 });
    await row({ rule: "Retired", source: "correction", retired: true });
    await row({ rule: "Retired merge", source: "evolution", retired: true });

    const corrections = await tx((trx) => store.getCorrections(trx, profileId));

    expect(corrections.map((c) => c.rule)).toEqual(["Live", "Learning"]);
  });

  it("upsertCorrection doesn't reinforce one, and reports it", async () => {
    const id = await row({
      rule: "Retired",
      source: "correction",
      retired: true,
      observationCount: 1,
    });

    const result = await tx((trx) =>
      store.upsertCorrection(trx, {
        rule: "Retired",
        category: "style",
        profileId: null,
        existingRuleId: id,
      }),
    );

    expect(result).toBeNull();
    const [after] = await db
      .select({ observationCount: steeringRules.observationCount })
      .from(steeringRules)
      .where(eq(steeringRules.id, id));
    expect(after?.observationCount).toBe(1);
    expect(await stateOf(id)).toBe("retired");
  });

  it("countActiveLearnedRules counts only live correction and evolution rules", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    await row({ rule: "Learned", source: "correction" });
    await row({ rule: "Merged", source: "evolution", profileId });
    await row({ rule: "Learning", source: "correction", active: false, observationCount: 1 });
    await row({ rule: "Retired", source: "correction", retired: true });
    await row({ rule: "Mine", source: "instruction", userId });
    await row({ rule: "Operator", source: "manual", observationCount: 0 });
    await row({ rule: "Default", source: "seed", channelType: "telegram" });

    expect(await tx((trx) => store.countActiveLearnedRules(trx, profileId))).toBe(2);
  });

  describe("replaceRules", () => {
    const merged = {
      rule: "Merged",
      category: "style",
      profileId: null,
      channelType: null,
      priority: 100,
      observationCount: 4,
    };

    it("rolls back when a rule in the group was retired, and every row survives", async () => {
      const live = await row({ rule: "Live", source: "correction" });
      const retired = await row({ rule: "Retired", source: "correction", retired: true });

      const attempt = tx((trx) =>
        store.replaceRules(trx, { oldIds: [live, retired], newRule: merged }),
      );

      await expect(attempt).rejects.toBeInstanceOf(RuleGroupChangedError);
      expect(
        (await db.select({ id: steeringRules.id }).from(steeringRules)).map((r) => r.id).sort(),
      ).toEqual([live, retired].sort());
      expect([await stateOf(live), await stateOf(retired)]).toEqual(["live", "retired"]);
    });

    it("rolls back on a group holding a rule that isn't learned", async () => {
      const userId = await seedUser();
      const live = await row({ rule: "Live", source: "correction" });
      const instruction = await row({ rule: "Mine", source: "instruction", userId });

      await expect(
        tx((trx) => store.replaceRules(trx, { oldIds: [live, instruction], newRule: merged })),
      ).rejects.toBeInstanceOf(RuleGroupChangedError);
      expect(await db.select({ id: steeringRules.id }).from(steeringRules)).toHaveLength(2);
    });
  });
});
