/**
 * Instruction rules and retirement in `DrizzleAgentStore`
 * (design/evolution.md → Explicit Instructions): who sees a rule, setting and
 * retiring it, the review list, and the learned-rule paths that skip a
 * retired row.
 */

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { RuleGroupChangedError } from "./errors.js";
import {
  DrizzleAgentStore,
  INSTRUCTION_RULE_LIMIT,
  type InstructionRuleRow,
  type MemoryRule,
  memoryRulesFor,
  type SetInstructionRuleResult,
} from "./index.js";
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

/** Narrow a set's result to a rule it wrote. */
function assertNew(result: SetInstructionRuleResult): asserts result is InstructionRuleRow {
  if (result.kind !== "new") throw new Error(`expected a new rule, got ${result.kind}`);
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

    assertNew(result);
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

    assertNew(first);
    expect(second).toEqual({ kind: "existing", id: first.id, createdAt: first.createdAt });
    expect(await db.select().from(steeringRules)).toHaveLength(1);
  });

  it("meets the unique index on normalized text, so a respelled set returns the live row", async () => {
    const userId = await seedUser();

    const first = await set({ rule: "No bullet points.", userId });
    const respelled = await set({ rule: "  no BULLET\n points. ", userId });

    assertNew(first);
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

    assertNew(result);
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

      assertNew(first);
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

  it("rejects an empty channel type, which the index can't tell from every channel", async () => {
    const userId = await seedUser();
    await set({ rule: "No emoji", userId });

    await expect(set({ rule: "No emoji", userId, channelType: "" })).rejects.toThrow(
      /channel type/,
    );
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
    expect(result.alreadyRetired).toEqual([]);
    expect(result.notRemovable).toEqual([]);
    for (const r of result.retired) {
      expect(r.retractedAt).toBeInstanceOf(Date);
      expect(await stateOf(r.id)).toBe("retired");
    }
    expect(await rendered({ profileId, userId })).toEqual([]);
  });

  it("is idempotent: a second retire changes nothing and finds what the first retired", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile();
    const id = await row({ rule: "No emoji.", source: "instruction", userId });

    const first = await retire({ text: "No emoji.", userId, profileId });
    const second = await retire({ text: "No emoji.", userId, profileId });

    const retired = expectDefined(first.retired[0], "retired");
    expect(retired.id).toBe(id);
    expect(second).toEqual({ retired: [], alreadyRetired: [retired], notRemovable: [] });
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
    expect(result.alreadyRetired).toEqual([]);
    expect(result.notRemovable.map((r) => [r.id, r.source, r.retractedAt])).toEqual([
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

    expect(result).toEqual({ retired: [], alreadyRetired: [], notRemovable: [] });
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
    expect(result.alreadyRetired).toEqual([]);
    expect(result.notRemovable.map((r) => [r.id, r.profileId, r.retractedAt])).toEqual([
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

describe("the Observer's rule reads", () => {
  it("getInstructionRules lists the user's live instruction rules the profile sees", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const profileId = await seedProfile();
    const otherProfileId = await seedProfile("other");
    await row({ rule: "Everywhere", source: "instruction", userId });
    await row({ rule: "Here", source: "instruction", userId, profileId, channelType: "telegram" });
    await row({ rule: "Other persona", source: "instruction", userId, profileId: otherProfileId });
    await row({ rule: "Other user", source: "instruction", userId: otherUserId });
    await row({ rule: "Withdrawn", source: "instruction", userId, retired: true });
    await row({ rule: "Learned", source: "correction" });
    await row({ rule: "Operator", source: "manual", observationCount: 0 });

    const rules = await tx((trx) => store.getInstructionRules(trx, { profileId, userId }));

    expect(rules.map((r) => [r.rule, r.channelType, r.active])).toEqual([
      ["Everywhere", null, true],
      ["Here", "telegram", true],
    ]);
  });

  it("hasInstructionRule matches the user's live instruction rules on normalized text", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const profileId = await seedProfile();
    await row({ rule: "No bullet points", source: "instruction", userId });
    await row({ rule: "Mine withdrawn", source: "instruction", userId, retired: true });
    await row({ rule: "Theirs", source: "instruction", userId: otherUserId });
    await row({ rule: "Learned", source: "correction" });
    const has = (text: string) =>
      tx((trx) => store.hasInstructionRule(trx, { userId, text, profileId, channelType: null }));

    expect(await has("  no BULLET\n points ")).toBe(true);
    expect(await has("Mine withdrawn")).toBe(false);
    expect(await has("Theirs")).toBe(false);
    expect(await has("Learned")).toBe(false);
  });

  describe("hasInstructionRule covers a correction's scope", () => {
    async function setup() {
      const userId = await seedUser();
      const profileId = await seedProfile();
      const otherProfileId = await seedProfile("other");
      const has = (text: string, scope: { profileId: string; channelType: string | null }) =>
        tx((trx) => store.hasInstructionRule(trx, { userId, text, ...scope }));
      return { userId, profileId, otherProfileId, has };
    }

    it("doesn't let a channel's rule cover another channel or every channel", async () => {
      const { userId, profileId, has } = await setup();
      await row({ rule: "No emojis", source: "instruction", userId, channelType: "telegram" });

      expect(await has("No emojis", { profileId, channelType: "telegram" })).toBe(true);
      expect(await has("No emojis", { profileId, channelType: "web" })).toBe(false);
      expect(await has("No emojis", { profileId, channelType: null })).toBe(false);
    });

    it("lets a rule on every channel cover a channel's correction", async () => {
      const { userId, profileId, has } = await setup();
      await row({ rule: "No emojis", source: "instruction", userId });

      expect(await has("No emojis", { profileId, channelType: "telegram" })).toBe(true);
      expect(await has("No emojis", { profileId, channelType: null })).toBe(true);
    });

    it("lets a persona's own rule cover a correction in its conversation, and only there", async () => {
      const { userId, profileId, otherProfileId, has } = await setup();
      await row({ rule: "Short replies", source: "instruction", userId, profileId });

      expect(await has("Short replies", { profileId, channelType: null })).toBe(true);
      expect(await has("Short replies", { profileId: otherProfileId, channelType: null })).toBe(
        false,
      );
    });
  });

  it("upsertCorrection reinforces an instruction rule without promoting it", async () => {
    const userId = await seedUser();
    const id = await row({ rule: "Mine", source: "instruction", userId, observationCount: 1 });

    const result = await tx((trx) =>
      store.upsertCorrection(trx, {
        rule: "Mine",
        category: "style",
        profileId: null,
        existingRuleId: id,
      }),
    );

    expect(result).toEqual({ id, promoted: false });
    const [after] = await db
      .select({ observationCount: steeringRules.observationCount })
      .from(steeringRules)
      .where(eq(steeringRules.id, id));
    expect(after?.observationCount).toBe(2);
    expect(await stateOf(id)).toBe("live");
  });

  it("upsertCorrection promotes a learned rule at its second observation", async () => {
    const id = await row({
      rule: "Learning",
      source: "correction",
      active: false,
      observationCount: 1,
    });

    const result = await tx((trx) =>
      store.upsertCorrection(trx, {
        rule: "Learning",
        category: "style",
        profileId: null,
        existingRuleId: id,
      }),
    );

    expect(result).toEqual({ id, promoted: true });
    expect(await stateOf(id)).toBe("live");
  });

  it("retireLearningRule retires a rule still learning and nothing else", async () => {
    const userId = await seedUser();
    const learning = await row({
      rule: "Learning",
      source: "correction",
      active: false,
      observationCount: 1,
    });
    const active = await row({ rule: "Active", source: "correction" });
    const retired = await row({ rule: "Retired", source: "correction", retired: true });
    const instruction = await row({ rule: "Mine", source: "instruction", userId });
    const retire = (id: string) => tx((trx) => store.retireLearningRule(trx, id));

    expect(await retire(learning)).toBe(true);
    expect(await retire(learning)).toBe(false);
    expect(await retire(active)).toBe(false);
    expect(await retire(retired)).toBe(false);
    expect(await retire(instruction)).toBe(false);
    expect([
      await stateOf(learning),
      await stateOf(active),
      await stateOf(retired),
      await stateOf(instruction),
    ]).toEqual(["retired", "live", "retired", "live"]);
  });

  it("getMemoryRules lists the live memory rules the staging profiles see, of every source", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const profileId = await seedProfile();
    const otherProfileId = await seedProfile("other");
    const unseenProfileId = await seedProfile("unseen");
    const memory = { category: "memory" };
    await row({ ...memory, rule: "Operator", source: "manual", observationCount: 0 });
    await row({ ...memory, rule: "Mine", source: "instruction", userId });
    await row({ ...memory, rule: "Persona", source: "instruction", userId, profileId });
    await row({ ...memory, rule: "Learned", source: "correction" });
    await row({
      ...memory,
      rule: "Other persona",
      source: "correction",
      profileId: otherProfileId,
    });
    await row({ ...memory, rule: "Theirs", source: "instruction", userId: otherUserId });
    await row({ ...memory, rule: "Learning", source: "correction", active: false });
    await row({ ...memory, rule: "Withdrawn", source: "instruction", userId, retired: true });
    await row({ ...memory, rule: "Unseen", source: "correction", profileId: unseenProfileId });
    await row({ rule: "Style", source: "instruction", userId });

    const both = await tx((trx) =>
      store.getMemoryRules(trx, { profileIds: [profileId, otherProfileId], userId }),
    );
    const none = await tx((trx) => store.getMemoryRules(trx, { profileIds: [], userId }));
    const texts = (rules: ReadonlyArray<MemoryRule>) => rules.map((r) => r.rule).sort();

    expect(texts(both)).toEqual(["Learned", "Mine", "Operator", "Other persona", "Persona"]);
    expect(texts(memoryRulesFor(both, profileId))).toEqual([
      "Learned",
      "Mine",
      "Operator",
      "Persona",
    ]);
    expect(texts(memoryRulesFor(both, null))).toEqual(["Learned", "Mine", "Operator"]);
    expect(texts(none)).toEqual(["Learned", "Mine", "Operator"]);
    expect(
      both
        .filter((r) => r.fromUser)
        .map((r) => r.rule)
        .sort(),
    ).toEqual(["Mine", "Persona"]);
  });
});
