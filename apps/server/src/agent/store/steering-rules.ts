import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import {
  RULE_SECTIONS,
  type RuleSection,
  ruleSection,
  type SectionedRule,
} from "../rule-sections.js";
import { inSavepoint, type RuleGroupChanged } from "./errors.js";
import {
  INSTRUCTION_RULE_KEY,
  LIVE_INSTRUCTION_RULE,
  normalizedRuleText,
  type SteeringRuleSourceValue,
  steeringRules,
} from "./schema.js";

/**
 * The most live instruction rules a user holds, which keeps `# Rules` near 45
 * rules (design/evolution.md → Explicit Instructions → Tools). Two concurrent
 * sets can pass it by one: snapshot isolation doesn't predicate-lock, and the
 * residual is benign at single-user scale.
 */
export const INSTRUCTION_RULE_LIMIT = 20;

/** The retired rules `listRules` returns, most recently retired first. */
const RETIRED_RULES_LISTED = 20;

/**
 * The rules one turn can see: global and `profileId`'s own, and among
 * instruction rules only `userId`'s. A null `userId` sees none, which is how a
 * third-party or unloadable profile withholds them.
 */
export interface RuleScope {
  profileId: string;
  userId: string | null;
}

/** A standing instruction the user stated; see `setInstructionRule`. */
export interface InstructionRuleParams {
  rule: string;
  category: "style" | "domain" | "memory";
  userId: string;
  /** Null for every profile; a restricted-class profile's own id otherwise. */
  profileId: string | null;
  /** Null for every channel. */
  channelType: string | null;
  /** The user's words that state it. */
  quote: string;
}

/**
 * The live instruction rule a set wrote (`new`) or found (`existing`), whether
 * an earlier call or a retry of this one wrote it; `createdAt` tells them apart.
 */
export interface InstructionRuleRow {
  kind: "new" | "existing";
  id: string;
  createdAt: Date;
}

/**
 * `at_limit`: the user holds `INSTRUCTION_RULE_LIMIT` live rules and nothing
 * was written. A value, not a throw: `rule_set` turns it into a tool error,
 * throwing it only to roll back its `replaces` retirements.
 */
export type SetInstructionRuleResult = InstructionRuleRow | { kind: "at_limit"; live: number };

/** A rule whose text matched, as `retireRulesByText` returns it. */
export interface RuleMatch {
  id: string;
  rule: string;
  source: SteeringRuleSourceValue;
  profileId: string | null;
  channelType: string | null;
  /** When the rule was retired; null while it is live. */
  retractedAt: Date | null;
}

/** The rules visible to a scope whose text matched, by what retiring did to them. */
export interface RetireRulesResult {
  /** Retired by this call. */
  retired: ReadonlyArray<RuleMatch>;
  /** Retired before it, so a repeat finds what the first call retired. */
  alreadyRetired: ReadonlyArray<RuleMatch>;
  /** Live, and not the scope's to retire: an operator rule, a channel default, or a wider rule in a restricted class. */
  notRemovable: ReadonlyArray<RuleMatch>;
}

/** A steering rule with what review shows of it. */
export interface ReviewedRule {
  id: string;
  rule: string;
  category: string;
  source: SteeringRuleSourceValue;
  section: RuleSection;
  profileId: string | null;
  channelType: string | null;
  observationCount: number;
  quote: string | null;
  createdAt: Date;
  retractedAt: Date | null;
}

/** The rules a scope sees: live in `# Rules` order, then learning, then the latest retired. */
export interface RuleReview {
  live: ReadonlyArray<ReviewedRule>;
  learning: ReadonlyArray<ReviewedRule>;
  retired: ReadonlyArray<ReviewedRule>;
}

/** The sources a user may retire: their instructions and what was learned from them. */
const REMOVABLE_RULE_SOURCES: ReadonlyArray<SteeringRuleSourceValue> = [
  "instruction",
  "correction",
  "evolution",
];

/** The sources consolidation merges. */
const LEARNED_RULE_SOURCES: ReadonlyArray<SteeringRuleSourceValue> = ["correction", "evolution"];

/**
 * `# Rules` order within a section: `safety` first (only operators write it),
 * then the narrower scope, so it is listed before a wider rule it conflicts
 * with, then priority, then the newest, which supersedes an older rule on
 * equal scope and priority. The `id` also keeps the order fixed across an
 * in-place update, which moves a row in the heap.
 */
const RULE_ORDER = [
  desc(eq(steeringRules.category, "safety")),
  asc(isNull(steeringRules.profileId)),
  asc(isNull(steeringRules.channelType)),
  asc(steeringRules.priority),
  desc(steeringRules.id),
];

function visibleTo(scope: RuleScope): SQL | undefined {
  return and(
    or(isNull(steeringRules.profileId), eq(steeringRules.profileId, scope.profileId)),
    scope.userId === null
      ? isNull(steeringRules.userId)
      : or(isNull(steeringRules.userId), eq(steeringRules.userId, scope.userId)),
  );
}

/** The user's live instruction rules. */
function liveInstructionRulesOf(userId: string): SQL | undefined {
  return and(
    eq(steeringRules.source, "instruction"),
    isNull(steeringRules.retractedAt),
    eq(steeringRules.userId, userId),
  );
}

/** What correction extraction reads of a rule. */
const EXTRACTION_RULE_COLUMNS = {
  id: steeringRules.id,
  rule: steeringRules.rule,
  category: steeringRules.category,
  active: steeringRules.active,
  observationCount: steeringRules.observationCount,
  priority: steeringRules.priority,
  channelType: steeringRules.channelType,
};

/** A steering rule as correction extraction reads it. */
export type ExtractionRule = Pick<
  typeof steeringRules.$inferSelect,
  keyof typeof EXTRACTION_RULE_COLUMNS
>;

/** A live `memory`-category rule, as `getMemoryRules` returns it. */
export interface MemoryRule {
  rule: string;
  /** Null for every profile. */
  profileId: string | null;
  /** An instruction rule the user set, which a third-party profile doesn't see. */
  fromUser: boolean;
}

/** The rules of `rules` that a staging profile sees; a null profile sees the global ones. */
export function memoryRulesFor(
  rules: ReadonlyArray<MemoryRule>,
  profileId: string | null,
): ReadonlyArray<MemoryRule> {
  return rules.filter((r) => r.profileId === null || r.profileId === profileId);
}

/**
 * Whether `rules` hold one of the user's own rules that a profile not seeing
 * the user's instruction rules (`seesUserRules` false) would be bound by
 * without being shown it.
 */
export function bindsUnseenUserRule(
  rules: ReadonlyArray<MemoryRule>,
  seesUserRules: boolean,
): boolean {
  return !seesUserRules && rules.some((r) => r.fromUser);
}

function textMatches(text: string): SQL {
  return eq(normalizedRuleText(steeringRules.rule), normalizedRuleText(sql`${text}`));
}

/**
 * `''` shares `uq_steering_rules_instruction`'s key with NULL (every channel)
 * but matches only itself in `inScope`, so a set would answer `existing` for
 * another scope's rule.
 */
function assertChannelType(channelType: string | null): void {
  if (channelType === "") {
    throw new Error("empty channel type: pass null for every channel");
  }
}

/** Exactly this profile and channel scope, NULL matching NULL. */
function inScope(profileId: string | null, channelType: string | null): SQL | undefined {
  return and(
    profileId === null ? isNull(steeringRules.profileId) : eq(steeringRules.profileId, profileId),
    channelType === null
      ? isNull(steeringRules.channelType)
      : eq(steeringRules.channelType, channelType),
  );
}

/**
 * Keyed insert on `uq_steering_rules_instruction`: see `.claude/rules/inngest.md`.
 * Raw SQL because `onConflictDoUpdate` takes column targets only, and the
 * index's key is expressions.
 */
async function upsertInstructionRule(
  tx: Transaction,
  params: InstructionRuleParams,
): Promise<InstructionRuleRow> {
  const upserted = tx
    .$with("upserted", {
      id: sql<string>`id`.as("id"),
      createdAt: sql<Date>`created_at`.mapWith(steeringRules.createdAt).as("created_at"),
      inserted: sql<boolean>`inserted`.as("inserted"),
    })
    .as(sql`
      INSERT INTO ${steeringRules}
        (rule, category, active, source, priority, observation_count, user_id, profile_id,
          channel_type, quote)
      VALUES (${params.rule}, ${params.category}, true, 'instruction', 100, 1, ${params.userId},
        ${params.profileId}, ${params.channelType}, ${params.quote})
      ON CONFLICT (${sql.join([...INSTRUCTION_RULE_KEY], sql`, `)}) WHERE ${LIVE_INSTRUCTION_RULE}
      DO UPDATE SET user_id = excluded.user_id
      RETURNING id, created_at, (xmax = 0) AS inserted
    `);
  const { inserted, ...row } = single(await tx.with(upserted).select().from(upserted));
  return { kind: inserted ? "new" : "existing", ...row };
}

const RULE_MATCH_COLUMNS = {
  id: steeringRules.id,
  rule: steeringRules.rule,
  source: steeringRules.source,
  profileId: steeringRules.profileId,
  channelType: steeringRules.channelType,
  retractedAt: steeringRules.retractedAt,
};

const REVIEWED_RULE_COLUMNS = {
  ...RULE_MATCH_COLUMNS,
  category: steeringRules.category,
  observationCount: steeringRules.observationCount,
  quote: steeringRules.quote,
  createdAt: steeringRules.createdAt,
};

/**
 * The `steering_rules` rows through their lifecycle: operator and channel
 * defaults, the user's standing instructions, and the corrections the
 * Observer learns, promotes, consolidates and retires.
 */
export interface SteeringRuleStore {
  /**
   * The live steering rules `scope` sees, every channel's included, each with
   * its `# Rules` section and channel, in the order `# Rules` lists them
   * within a section.
   */
  getActiveRules(tx: Transaction, scope: RuleScope): Promise<ReadonlyArray<SectionedRule>>;

  // --- Evolution: correction extraction ---

  /** Whether a channel's defaults have been seeded. */
  hasChannelDefaults(tx: Transaction, channelType: string): Promise<boolean>;

  /** Insert an active channel default (`source = 'seed'`) for every profile. */
  insertSeedRule(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      channelType: string;
      priority: number;
    },
  ): Promise<{ id: string }>;

  /** The unretired learned rules, active and learning, for extraction and consolidation. */
  getCorrections(tx: Transaction, profileId: string): Promise<ReadonlyArray<ExtractionRule>>;

  /**
   * The user's live instruction rules the profile sees, for extraction:
   * listed apart from `getCorrections` so consolidation never loads them.
   */
  getInstructionRules(
    tx: Transaction,
    scope: { profileId: string; userId: string },
  ): Promise<ReadonlyArray<ExtractionRule>>;

  /**
   * Whether a live instruction rule of the user's with this text (normalized)
   * covers a rule in `channelType` (null for every channel), seen from
   * `profileId`'s conversation: the instruction is global or that profile's,
   * and on every channel or that one. A channel rule doesn't cover another
   * channel or every channel.
   */
  hasInstructionRule(
    tx: Transaction,
    params: { userId: string; text: string; profileId: string; channelType: string | null },
  ): Promise<boolean>;

  /**
   * Insert a new correction or reinforce an existing one, which promotes a
   * learned rule to active when observationCount reaches 2; reinforcing an
   * instruction rule only counts. Null when `existingRuleId` names no
   * unretired rule: it was retired or merged since the caller read it, and
   * nothing is written.
   */
  upsertCorrection(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      profileId: string | null;
      channelType?: string | null;
      existingRuleId?: string;
    },
  ): Promise<{ id: string; promoted: boolean } | null>;

  /**
   * Apply a contradiction from `conversationId` to a learned rule still
   * learning. The first resets its observation count to 0 and records the
   * conversation (`reset`); one from another conversation retires it and
   * records that conversation instead (`retired`). A contradiction from the
   * recorded conversation writes nothing and reports what that conversation
   * did, so a retried or repeated extraction applies once and counts the
   * same. Every other retirement clears the record, so one against a rule that
   * is active, retired otherwise or not learned writes nothing (`unchanged`).
   */
  contradictLearningRule(
    tx: Transaction,
    params: { id: string; conversationId: string },
  ): Promise<"reset" | "retired" | "unchanged">;

  /**
   * The live `memory`-category rules, of every source, that any of
   * `profileIds` sees: global ones and each profile's own, among instruction
   * rules only `userId`'s. `memoryRulesFor` picks one profile's out of them.
   */
  getMemoryRules(
    tx: Transaction,
    scope: { profileIds: ReadonlyArray<string>; userId: string },
  ): Promise<ReadonlyArray<MemoryRule>>;

  /** Count the active learned rules (`correction`, `evolution`) a profile sees: what consolidation merges. */
  countActiveLearnedRules(tx: Transaction, profileId: string): Promise<number>;

  /**
   * Replace a group of learned rules with one consolidated rule, or, when a
   * rule in the group is retired, gone, or not a learned rule, change
   * nothing and return `rule_group_changed`.
   */
  replaceRules(
    tx: Transaction,
    params: {
      oldIds: string[];
      newRule: {
        rule: string;
        category: string;
        profileId: string | null;
        channelType: string | null;
        priority: number;
        observationCount: number;
      };
    },
  ): Promise<Result<{ id: string }, RuleGroupChanged>>;

  // --- Explicit instructions ---

  /**
   * Set a standing instruction as a live rule, unless a live instruction rule
   * with the same text (normalized) and scope is already there, or the user
   * holds `INSTRUCTION_RULE_LIMIT`. Throws on an empty `channelType`. A set or an existing rule retires the
   * unretired learned rules with the same text and scope: the instruction
   * supersedes them. Keyed on `uq_steering_rules_instruction`: a concurrent
   * identical set fails with 40001, and the transactor's retry returns the
   * winner's row as `existing`.
   */
  setInstructionRule(
    tx: Transaction,
    params: InstructionRuleParams,
  ): Promise<SetInstructionRuleResult>;

  /**
   * Retire the live `instruction`, `correction` and `evolution` rules visible
   * to the scope whose text matches `text` (normalized); `restricted` limits
   * that to the rules scoped to `profileId`. Returns every live or retired
   * visible match. Fits `rule_remove`; `replaces` needs its own shape
   * (design/evolution.md → Implementation Outline, step 3).
   */
  retireRulesByText(
    tx: Transaction,
    params: { text: string; userId: string; profileId: string; restricted: boolean },
  ): Promise<RetireRulesResult>;

  /**
   * The rules a profile shows its user, for review: every live rule it sees,
   * the user's instruction rules included, the learning ones and the most
   * recently retired.
   */
  listRules(tx: Transaction, scope: { profileId: string; userId: string }): Promise<RuleReview>;
}

export class DrizzleSteeringRuleStore implements SteeringRuleStore {
  async getActiveRules(tx: Transaction, scope: RuleScope): Promise<ReadonlyArray<SectionedRule>> {
    const rows = await tx
      .select({
        rule: steeringRules.rule,
        source: steeringRules.source,
        channelType: steeringRules.channelType,
      })
      .from(steeringRules)
      .where(and(eq(steeringRules.active, true), visibleTo(scope)))
      .orderBy(...RULE_ORDER);
    return rows.map((r) => ({
      rule: r.rule,
      section: ruleSection(r.source),
      channelType: r.channelType,
    }));
  }

  async hasChannelDefaults(tx: Transaction, channelType: string): Promise<boolean> {
    const rows = await tx
      .select({ id: steeringRules.id })
      .from(steeringRules)
      .where(and(eq(steeringRules.channelType, channelType), eq(steeringRules.source, "seed")))
      .limit(1);
    return rows.length > 0;
  }

  async insertSeedRule(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      channelType: string;
      priority: number;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(steeringRules)
        .values({
          rule: params.rule,
          category: params.category,
          source: "seed",
          active: true,
          priority: params.priority,
          observationCount: 0,
          profileId: null,
          channelType: params.channelType,
        })
        .returning({ id: steeringRules.id }),
    );
  }

  // --- Evolution: correction extraction ---

  async getCorrections(tx: Transaction, profileId: string): Promise<ReadonlyArray<ExtractionRule>> {
    return tx
      .select(EXTRACTION_RULE_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          isNull(steeringRules.retractedAt),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
        ),
      )
      .orderBy(asc(steeringRules.priority), asc(steeringRules.id));
  }

  async getInstructionRules(
    tx: Transaction,
    scope: { profileId: string; userId: string },
  ): Promise<ReadonlyArray<ExtractionRule>> {
    return tx
      .select(EXTRACTION_RULE_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          liveInstructionRulesOf(scope.userId),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, scope.profileId)),
        ),
      )
      .orderBy(asc(steeringRules.priority), asc(steeringRules.id));
  }

  async hasInstructionRule(
    tx: Transaction,
    params: { userId: string; text: string; profileId: string; channelType: string | null },
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: steeringRules.id })
      .from(steeringRules)
      .where(
        and(
          liveInstructionRulesOf(params.userId),
          textMatches(params.text),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, params.profileId)),
          params.channelType === null
            ? isNull(steeringRules.channelType)
            : or(
                isNull(steeringRules.channelType),
                eq(steeringRules.channelType, params.channelType),
              ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async contradictLearningRule(
    tx: Transaction,
    params: { id: string; conversationId: string },
  ): Promise<"reset" | "retired" | "unchanged"> {
    const learning = and(
      eq(steeringRules.id, params.id),
      eq(steeringRules.active, false),
      isNull(steeringRules.retractedAt),
      inArray(steeringRules.source, LEARNED_RULE_SOURCES),
    );
    const retired = await tx
      .update(steeringRules)
      .set({ retractedAt: sql`now()`, contradictedInConversationId: params.conversationId })
      .where(
        and(
          learning,
          isNotNull(steeringRules.contradictedInConversationId),
          ne(steeringRules.contradictedInConversationId, params.conversationId),
        ),
      )
      .returning({ id: steeringRules.id });
    if (retired.length > 0) return "retired";
    const reset = await tx
      .update(steeringRules)
      .set({ observationCount: 0, contradictedInConversationId: params.conversationId })
      .where(and(learning, isNull(steeringRules.contradictedInConversationId)))
      .returning({ id: steeringRules.id });
    if (reset.length > 0) return "reset";
    const [applied] = await tx
      .select({ active: steeringRules.active, retractedAt: steeringRules.retractedAt })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.id, params.id),
          eq(steeringRules.contradictedInConversationId, params.conversationId),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
        ),
      );
    if (applied === undefined || applied.active) return "unchanged";
    return applied.retractedAt === null ? "reset" : "retired";
  }

  async getMemoryRules(
    tx: Transaction,
    scope: { profileIds: ReadonlyArray<string>; userId: string },
  ): Promise<ReadonlyArray<MemoryRule>> {
    const rows = await tx
      .select({
        rule: steeringRules.rule,
        profileId: steeringRules.profileId,
        userId: steeringRules.userId,
      })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, true),
          eq(steeringRules.category, "memory"),
          scope.profileIds.length === 0
            ? isNull(steeringRules.profileId)
            : or(
                isNull(steeringRules.profileId),
                inArray(steeringRules.profileId, [...scope.profileIds]),
              ),
          or(isNull(steeringRules.userId), eq(steeringRules.userId, scope.userId)),
        ),
      )
      .orderBy(...RULE_ORDER);
    return rows.map((r) => ({ rule: r.rule, profileId: r.profileId, fromUser: r.userId !== null }));
  }

  async upsertCorrection(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      profileId: string | null;
      channelType?: string | null;
      existingRuleId?: string;
    },
  ): Promise<{ id: string; promoted: boolean } | null> {
    if (params.existingRuleId) {
      const rows = await tx
        .update(steeringRules)
        .set({
          observationCount: sql`${steeringRules.observationCount} + 1`,
          active: sql`CASE WHEN ${steeringRules.observationCount} + 1 >= 2 THEN true ELSE ${steeringRules.active} END`,
        })
        .where(and(eq(steeringRules.id, params.existingRuleId), isNull(steeringRules.retractedAt)))
        .returning({
          id: steeringRules.id,
          source: steeringRules.source,
          active: steeringRules.active,
          observationCount: steeringRules.observationCount,
        });
      const row = rows[0];
      if (row === undefined) return null;
      // An instruction rule is live from its set: a reinforcement never promotes it.
      const promoted = row.source !== "instruction" && row.observationCount === 2 && row.active;
      return { id: row.id, promoted };
    }

    const row = single(
      await tx
        .insert(steeringRules)
        .values({
          rule: params.rule,
          category: params.category,
          source: "correction",
          active: false,
          priority: 100,
          observationCount: 1,
          profileId: params.profileId,
          channelType: params.channelType ?? null,
        })
        .returning({ id: steeringRules.id }),
    );
    return { id: row.id, promoted: false };
  }

  async countActiveLearnedRules(tx: Transaction, profileId: string): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, true),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async replaceRules(
    tx: Transaction,
    params: {
      oldIds: string[];
      newRule: {
        rule: string;
        category: string;
        profileId: string | null;
        channelType: string | null;
        priority: number;
        observationCount: number;
      };
    },
  ): Promise<Result<{ id: string }, RuleGroupChanged>> {
    // A rule retired during consolidation's LLM call is never folded into a
    // live one: short of the whole group, the savepoint rolls the delete back.
    // A retirement committed after this snapshot fails the delete with 40001,
    // and the transactor's retry comes up short here.
    return inSavepoint(tx, async (sp) => {
      const deleted = await sp
        .delete(steeringRules)
        .where(
          and(
            inArray(steeringRules.id, params.oldIds),
            inArray(steeringRules.source, LEARNED_RULE_SOURCES),
            isNull(steeringRules.retractedAt),
          ),
        )
        .returning({ id: steeringRules.id });
      if (deleted.length !== params.oldIds.length) {
        return err({
          kind: "rule_group_changed" as const,
          deleted: deleted.length,
        });
      }
      return ok(
        single(
          await sp
            .insert(steeringRules)
            .values({
              rule: params.newRule.rule,
              category: params.newRule.category,
              source: "evolution",
              active: true,
              priority: params.newRule.priority,
              observationCount: params.newRule.observationCount,
              profileId: params.newRule.profileId,
              channelType: params.newRule.channelType,
            })
            .returning({ id: steeringRules.id }),
        ),
      );
    });
  }

  async setInstructionRule(
    tx: Transaction,
    params: InstructionRuleParams,
  ): Promise<SetInstructionRuleResult> {
    assertChannelType(params.channelType);
    const [held] = await tx
      .select({ value: count() })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.userId, params.userId),
          eq(steeringRules.source, "instruction"),
          isNull(steeringRules.retractedAt),
        ),
      );
    const live = held?.value ?? 0;
    let result: InstructionRuleRow;
    if (live >= INSTRUCTION_RULE_LIMIT) {
      const [existing] = await tx
        .select({ id: steeringRules.id, createdAt: steeringRules.createdAt })
        .from(steeringRules)
        .where(
          and(
            eq(steeringRules.userId, params.userId),
            eq(steeringRules.source, "instruction"),
            isNull(steeringRules.retractedAt),
            textMatches(params.rule),
            inScope(params.profileId, params.channelType),
          ),
        );
      if (existing === undefined) return { kind: "at_limit", live };
      result = { kind: "existing", ...existing };
    } else {
      result = await upsertInstructionRule(tx, params);
    }
    await tx
      .update(steeringRules)
      // Not a contradiction's retirement: no conversation recorded it.
      .set({ active: false, retractedAt: sql`now()`, contradictedInConversationId: null })
      .where(
        and(
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          isNull(steeringRules.retractedAt),
          textMatches(params.rule),
          inScope(params.profileId, params.channelType),
        ),
      );
    return result;
  }

  async retireRulesByText(
    tx: Transaction,
    params: { text: string; userId: string; profileId: string; restricted: boolean },
  ): Promise<RetireRulesResult> {
    const scope = { profileId: params.profileId, userId: params.userId };
    const retired = await tx
      .update(steeringRules)
      // Not a contradiction's retirement: no conversation recorded it.
      .set({ active: false, retractedAt: sql`now()`, contradictedInConversationId: null })
      .where(
        and(
          textMatches(params.text),
          eq(steeringRules.active, true),
          inArray(steeringRules.source, REMOVABLE_RULE_SOURCES),
          visibleTo(scope),
          params.restricted ? eq(steeringRules.profileId, params.profileId) : undefined,
        ),
      )
      .returning(RULE_MATCH_COLUMNS);
    const retiredIds = new Set(retired.map((r) => r.id));
    const others = await tx
      .select(RULE_MATCH_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          textMatches(params.text),
          or(eq(steeringRules.active, true), isNotNull(steeringRules.retractedAt)),
          visibleTo(scope),
        ),
      )
      .orderBy(...RULE_ORDER);
    const [alreadyRetired, notRemovable] = R.partition(
      others.filter((m) => !retiredIds.has(m.id)),
      (m) => m.retractedAt !== null,
    );
    return { retired, alreadyRetired, notRemovable };
  }

  async listRules(
    tx: Transaction,
    scope: { profileId: string; userId: string },
  ): Promise<RuleReview> {
    const live = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(and(eq(steeringRules.active, true), visibleTo(scope)))
      .orderBy(...RULE_ORDER);
    const learning = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, false),
          isNull(steeringRules.retractedAt),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          visibleTo(scope),
        ),
      )
      .orderBy(desc(steeringRules.id));
    const retired = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(and(isNotNull(steeringRules.retractedAt), visibleTo(scope)))
      .orderBy(desc(steeringRules.retractedAt), desc(steeringRules.id))
      .limit(RETIRED_RULES_LISTED);
    const reviewed = (rows: typeof live): ReadonlyArray<ReviewedRule> =>
      rows.map((r) => ({ ...r, section: ruleSection(r.source) }));
    return {
      live: R.sortBy(reviewed(live), (r) => RULE_SECTIONS.indexOf(r.section)),
      learning: reviewed(learning),
      retired: reviewed(retired),
    };
  }
}
