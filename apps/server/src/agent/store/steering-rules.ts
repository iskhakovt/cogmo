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
import { match } from "ts-pattern";
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
  type SteeringRuleRetireReason,
  type SteeringRuleSourceValue,
  type SteeringRuleStatusValue,
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
  status: SteeringRuleStatusValue;
  profileId: string | null;
  channelType: string | null;
  /** When a retired rule was retired; null in every other status. */
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
  status: SteeringRuleStatusValue;
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

/**
 * What `upsertCorrection` did: wrote a learning row, counted a reinforcement,
 * promoted a learning rule to live, or found no live or learning row to
 * reinforce and wrote nothing.
 */
export type UpsertCorrectionResult =
  | { kind: "inserted"; id: string }
  | { kind: "reinforced"; id: string }
  | { kind: "promoted"; id: string }
  | { kind: "stale" };

/** The sources a user may retire: their instructions and what was learned from them. */
const REMOVABLE_RULE_SOURCES: ReadonlyArray<SteeringRuleSourceValue> = [
  "instruction",
  "correction",
  "evolution",
];

/** The sources consolidation merges. */
const LEARNED_RULE_SOURCES: ReadonlyArray<SteeringRuleSourceValue> = ["correction", "evolution"];

/**
 * The statuses the Observer reads, reinforces and consolidates: live or
 * learning. A disabled rule is the operator's, a retired one the record.
 */
const OBSERVER_STATUSES: ReadonlyArray<ObserverStatus> = ["live", "learning"];
type ObserverStatus = Extract<SteeringRuleStatusValue, "live" | "learning">;

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
    eq(steeringRules.status, "live"),
    eq(steeringRules.userId, userId),
  );
}

/** What correction extraction reads of a rule. */
const EXTRACTION_RULE_COLUMNS = {
  id: steeringRules.id,
  rule: steeringRules.rule,
  category: steeringRules.category,
  status: steeringRules.status,
  observationCount: steeringRules.observationCount,
  priority: steeringRules.priority,
  channelType: steeringRules.channelType,
};

type ExtractionRuleRow = Pick<
  typeof steeringRules.$inferSelect,
  keyof typeof EXTRACTION_RULE_COLUMNS
>;

/** A steering rule as correction extraction reads it: live or learning. */
export interface ExtractionRule extends Omit<ExtractionRuleRow, "status"> {
  status: ObserverStatus;
}

/** A row an extraction read selected, its status narrowed to the ones its WHERE admits. */
function toExtractionRule(row: ExtractionRuleRow): ExtractionRule {
  return match(row.status)
    .with("live", "learning", (status) => ({ ...row, status }))
    .with("disabled", "retired", (status) => {
      throw new Error(`steering rule ${row.id} read for extraction as ${status}`);
    })
    .exhaustive();
}

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
 * Keyed insert on `uq_steering_rules_instruction`: see `.agents/rules/inngest.md`.
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
        (rule, category, status, source, priority, observation_count, user_id, profile_id,
          channel_type, quote)
      VALUES (${params.rule}, ${params.category}, 'live', 'instruction', 100, 1, ${params.userId},
        ${params.profileId}, ${params.channelType}, ${params.quote})
      ON CONFLICT (${sql.join([...INSTRUCTION_RULE_KEY], sql`, `)}) WHERE ${LIVE_INSTRUCTION_RULE}
      DO UPDATE SET user_id = excluded.user_id
      RETURNING id, created_at, (xmax = 0) AS inserted
    `);
  const { inserted, ...row } = single(await tx.with(upserted).select().from(upserted));
  return { kind: inserted ? "new" : "existing", ...row };
}

/** The columns a retirement writes; a contradiction's also records its turn. */
function retirement(reason: SteeringRuleRetireReason) {
  return { status: "retired" as const, retractedAt: sql`now()`, retiredReason: reason };
}

/**
 * `contradicted_in_conversation_id`, cleared by every write of the turn
 * marker, so a value a rolled-back build wrote never outlives the next write
 * and never meets the CHECK on a rule that left learning.
 */
const LEGACY_MARKER_CLEARED = { contradictedInConversationId: null } as const;

/** No contradiction record, for a retirement that isn't one. */
const NO_CONTRADICTION_MARKER = { contradictedInTurnId: null, ...LEGACY_MARKER_CLEARED } as const;

const RULE_MATCH_COLUMNS = {
  id: steeringRules.id,
  rule: steeringRules.rule,
  source: steeringRules.source,
  status: steeringRules.status,
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
 * The `steering_rules` rows through their lifecycle (design/evolution.md →
 * Explicit Instructions → Lifecycle): operator and channel defaults, the
 * user's standing instructions, and the corrections the Observer learns,
 * promotes, consolidates and retires.
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

  /** Insert a live channel default (`source = 'seed'`) for every profile. */
  insertSeedRule(
    tx: Transaction,
    params: {
      rule: string;
      category: string;
      channelType: string;
      priority: number;
    },
  ): Promise<{ id: string }>;

  /** The live and learning learned rules, for extraction and consolidation. */
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
   * Insert a new correction, learning (`inserted`), or reinforce an existing
   * rule (`reinforced`), which promotes a learning rule to live when its
   * observation count reaches 2 and clears its contradiction record
   * (`promoted`); reinforcing a live rule only counts. `stale` when
   * `existingRuleId` names no live or learning rule: it was retired or merged
   * since the caller read it, and nothing is written.
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
  ): Promise<UpsertCorrectionResult>;

  /**
   * Apply a contradiction from the turn whose `corrections` observation row
   * is `turnObservationId` to a learned rule still learning. The first resets
   * its observation count to 0 and records the turn (`reset`); one from any
   * other turn, in the same conversation or another, retires it and records
   * that turn instead (`retired`). A contradiction from the recorded turn
   * writes nothing and reports what that turn did. Every other retirement
   * clears the record, so one against a rule that is live, retired otherwise
   * or not learned writes nothing (`unchanged`).
   */
  contradictLearningRule(
    tx: Transaction,
    params: { id: string; turnObservationId: string },
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

  /** Count the live learned rules (`correction`, `evolution`) a profile sees: what consolidation merges. */
  countLiveLearnedRules(tx: Transaction, profileId: string): Promise<number>;

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
   * live and learning learned rules with the same text and scope: the
   * instruction supersedes them. Keyed on `uq_steering_rules_instruction`: a
   * concurrent identical set fails with 40001, and the transactor's retry
   * returns the winner's row as `existing`.
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
   * recently retired. A disabled rule is the operator's and is left out.
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
      .where(and(eq(steeringRules.status, "live"), visibleTo(scope)))
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
          status: "live",
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
          inArray(steeringRules.status, OBSERVER_STATUSES),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
        ),
      )
      .orderBy(asc(steeringRules.priority), asc(steeringRules.id))
      .then(R.map(toExtractionRule));
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
      .orderBy(asc(steeringRules.priority), asc(steeringRules.id))
      .then(R.map(toExtractionRule));
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
    params: { id: string; turnObservationId: string },
  ): Promise<"reset" | "retired" | "unchanged"> {
    const learning = and(
      eq(steeringRules.id, params.id),
      eq(steeringRules.status, "learning"),
      inArray(steeringRules.source, LEARNED_RULE_SOURCES),
    );
    const marker = { contradictedInTurnId: params.turnObservationId, ...LEGACY_MARKER_CLEARED };
    const retired = await tx
      .update(steeringRules)
      .set({ ...retirement("contradicted"), ...marker })
      .where(
        and(
          learning,
          isNotNull(steeringRules.contradictedInTurnId),
          ne(steeringRules.contradictedInTurnId, params.turnObservationId),
        ),
      )
      .returning({ id: steeringRules.id });
    if (retired.length > 0) return "retired";
    const reset = await tx
      .update(steeringRules)
      .set({ observationCount: 0, ...marker })
      .where(and(learning, isNull(steeringRules.contradictedInTurnId)))
      .returning({ id: steeringRules.id });
    if (reset.length > 0) return "reset";
    const [applied] = await tx
      .select({ status: steeringRules.status })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.id, params.id),
          eq(steeringRules.contradictedInTurnId, params.turnObservationId),
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
        ),
      );
    if (applied === undefined) return "unchanged";
    return match(applied.status)
      .with("learning", () => "reset" as const)
      .with("retired", () => "retired" as const)
      .with("live", "disabled", (status) => {
        // The CHECK keeps a contradiction record to learning and retired rows.
        throw new Error(`steering rule ${params.id} is ${status} with a contradiction record`);
      })
      .exhaustive();
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
          eq(steeringRules.status, "live"),
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
  ): Promise<UpsertCorrectionResult> {
    if (params.existingRuleId) {
      // A learning rule graduates at its second observation, and leaves the
      // turn of its reset behind; a live one, an instruction included, is
      // reinforced in place. One statement, so `old` and `new` tell them apart.
      const graduates = sql`${steeringRules.status} = 'learning' AND ${steeringRules.observationCount} + 1 >= 2`;
      const [reinforced] = await tx
        .update(steeringRules)
        .set({
          observationCount: sql`${steeringRules.observationCount} + 1`,
          status: sql`CASE WHEN ${graduates} THEN 'live' ELSE ${steeringRules.status} END`,
          contradictedInTurnId: sql`CASE WHEN ${graduates} THEN NULL ELSE ${steeringRules.contradictedInTurnId} END`,
          ...LEGACY_MARKER_CLEARED,
        })
        .where(
          and(
            eq(steeringRules.id, params.existingRuleId),
            inArray(steeringRules.status, OBSERVER_STATUSES),
          ),
        )
        .returning({
          id: steeringRules.id,
          promoted: sql<boolean>`(old.status = 'learning' AND new.status = 'live')`,
        });
      if (reinforced === undefined) return { kind: "stale" };
      return reinforced.promoted
        ? { kind: "promoted", id: reinforced.id }
        : { kind: "reinforced", id: reinforced.id };
    }

    const row = single(
      await tx
        .insert(steeringRules)
        .values({
          rule: params.rule,
          category: params.category,
          source: "correction",
          status: "learning",
          priority: 100,
          observationCount: 1,
          profileId: params.profileId,
          channelType: params.channelType ?? null,
        })
        .returning({ id: steeringRules.id }),
    );
    return { kind: "inserted", id: row.id };
  }

  async countLiveLearnedRules(tx: Transaction, profileId: string): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.status, "live"),
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
            inArray(steeringRules.status, OBSERVER_STATUSES),
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
              status: "live",
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
      .where(liveInstructionRulesOf(params.userId));
    const live = held?.value ?? 0;
    let result: InstructionRuleRow;
    if (live >= INSTRUCTION_RULE_LIMIT) {
      const [existing] = await tx
        .select({ id: steeringRules.id, createdAt: steeringRules.createdAt })
        .from(steeringRules)
        .where(
          and(
            liveInstructionRulesOf(params.userId),
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
      // Not a contradiction's retirement: no turn recorded it.
      .set({ ...retirement("superseded"), ...NO_CONTRADICTION_MARKER })
      .where(
        and(
          inArray(steeringRules.source, LEARNED_RULE_SOURCES),
          inArray(steeringRules.status, OBSERVER_STATUSES),
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
      // Not a contradiction's retirement: no turn recorded it.
      .set({ ...retirement("removed_by_user"), ...NO_CONTRADICTION_MARKER })
      .where(
        and(
          textMatches(params.text),
          eq(steeringRules.status, "live"),
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
          inArray(steeringRules.status, ["live", "retired"]),
          visibleTo(scope),
        ),
      )
      .orderBy(...RULE_ORDER);
    const [alreadyRetired, notRemovable] = R.partition(
      others.filter((m) => !retiredIds.has(m.id)),
      (m) => m.status === "retired",
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
      .where(and(eq(steeringRules.status, "live"), visibleTo(scope)))
      .orderBy(...RULE_ORDER);
    const learning = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(and(eq(steeringRules.status, "learning"), visibleTo(scope)))
      .orderBy(desc(steeringRules.id));
    const retired = await tx
      .select(REVIEWED_RULE_COLUMNS)
      .from(steeringRules)
      .where(and(eq(steeringRules.status, "retired"), visibleTo(scope)))
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
