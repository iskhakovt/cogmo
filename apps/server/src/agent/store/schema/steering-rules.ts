import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { conversations } from "./conversations.js";
import { profiles } from "./profiles.js";
import { users } from "./users.js";

/**
 * `steering_rules.source` — who wrote the rule, which decides its `# Rules`
 * section (`rule-sections.ts`). `manual` = an operator's insert, the only
 * source of `safety` rules; `seed` = a channel default from
 * `seedChannelRules`; `instruction` = a standing instruction the user stated
 * (design/evolution.md → Explicit Instructions); `correction` = the Observer's
 * extraction; `evolution` = consolidation's merge.
 */
export const steeringRuleSource = pgEnum("steering_rule_source", [
  "manual",
  "seed",
  "instruction",
  "correction",
  "evolution",
]);
export type SteeringRuleSourceValue = (typeof steeringRuleSource.enumValues)[number];

/**
 * `steering_rules.status` — where a rule is in its lifecycle
 * (design/evolution.md → Explicit Instructions → Lifecycle). `live` renders in
 * `# Rules`; `learning` is a learned rule short of its second observation;
 * `disabled` is an operator's rule or a channel default switched off by hand;
 * `retired` keeps the row as the record of a withdrawn rule, with
 * `retracted_at` and `retired_reason` set.
 */
export const steeringRuleStatus = pgEnum("steering_rule_status", [
  "live",
  "learning",
  "disabled",
  "retired",
]);
export type SteeringRuleStatusValue = (typeof steeringRuleStatus.enumValues)[number];

/**
 * Why a rule is `retired`: a second contradiction while learning, an
 * instruction with its text and scope superseding it, or the user's removal
 * (`rule_remove`, `/rules`). `unknown` is written by nothing but the status
 * migration, on rows retired before the column existed.
 */
export const steeringRuleRetiredReason = pgEnum("steering_rule_retired_reason", [
  "contradicted",
  "superseded",
  "removed_by_user",
  "unknown",
]);
export type SteeringRuleRetiredReasonValue = (typeof steeringRuleRetiredReason.enumValues)[number];
/** The reasons a retirement in code records. */
export type SteeringRuleRetireReason = Exclude<SteeringRuleRetiredReasonValue, "unknown">;

/**
 * A rule's text as rules compare: lower-cased, trimmed, each run of whitespace
 * one space. The one normalization, for the instruction index and every match
 * by text (design/evolution.md → Explicit Instructions → Data Model).
 */
export function normalizedRuleText(text: SQLWrapper): SQL {
  return sql`lower(btrim(regexp_replace(${text}, '[[:space:]]+', ' ', 'g')))`;
}

/**
 * `uq_steering_rules_instruction`'s key and predicate: one live instruction
 * per user, text and scope. An `ON CONFLICT` on the index names both. The
 * COALESCEs stand in for NULLS NOT DISTINCT, which Drizzle can't declare on an
 * expression or partial index.
 */
export const INSTRUCTION_RULE_KEY: readonly [SQL, SQL, SQL, SQL] = [
  normalizedRuleText(sql`rule`),
  sql`user_id`,
  sql`COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
  sql`COALESCE(channel_type, '')`,
];
export const LIVE_INSTRUCTION_RULE: SQL = sql`source = 'instruction' AND status = 'live'`;

/**
 * Which statuses each source can hold, as `chk_steering_rules_lifecycle`
 * enforces it: a learned rule (`correction`, `evolution`) is live, learning or
 * retired; an operator's rule or a channel default (`manual`, `seed`) is live,
 * disabled or retired; an instruction is live or retired. `retracted_at` and
 * `retired_reason` are set on a retired row and on no other;
 * `contradicted_in_conversation_id` only on a learning or retired one.
 * `user_id` and `quote` belong to `instruction` rows.
 */
export const steeringRules = pgTable(
  "steering_rules",
  {
    id: pk(),
    rule: text("rule").notNull(),
    category: text("category").notNull(), // 'safety' | 'style' | 'domain' | 'memory'
    status: steeringRuleStatus("status").notNull(),
    source: steeringRuleSource("source").notNull(),
    priority: integer("priority").notNull(),
    observationCount: integer("observation_count").notNull(),
    profileId: uuid("profile_id").references(() => profiles.id), // NULL = applies to all profiles
    channelType: text("channel_type"), // NULL = applies to all channels
    retractedAt: timestamp("retracted_at", { withTimezone: true }), // when a retired row was retired; NULL otherwise
    retiredReason: steeringRuleRetiredReason("retired_reason"), // why a retired row was retired; NULL otherwise
    // NULL = every user; set on every instruction row, so one user's
    // instructions stay out of another's prompt.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    quote: text("quote"), // the user's words `rule_set` quoted; set on every instruction row
    // NULL = never contradicted while learning. The conversation whose
    // contradiction reset the learning rule's count, then the one whose
    // contradiction retired it; one from the recorded conversation changes
    // nothing, so a retried or repeated extraction of one conversation applies
    // once. Graduation, any other retirement, and a deleted conversation clear
    // it; the last only costs one more reset.
    contradictedInConversationId: uuid("contradicted_in_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    createdAt: ts(),
  },
  (t) => [
    check(
      "chk_steering_rules_lifecycle",
      sql`((${t.status} = 'retired') = (${t.retractedAt} IS NOT NULL))
        AND ((${t.status} = 'retired') = (${t.retiredReason} IS NOT NULL))
        AND (${t.contradictedInConversationId} IS NULL OR ${t.status} IN ('learning', 'retired'))
        AND (${t.status} <> 'learning' OR ${t.source} IN ('correction', 'evolution'))
        AND (${t.status} <> 'disabled' OR ${t.source} IN ('manual', 'seed'))
        AND ((${t.source} = 'instruction') = (${t.userId} IS NOT NULL))
        AND ((${t.source} = 'instruction') = (${t.quote} IS NOT NULL))`,
    ),
    uniqueIndex("uq_steering_rules_instruction")
      .on(...INSTRUCTION_RULE_KEY)
      .where(LIVE_INSTRUCTION_RULE),
    // For the FK's ON DELETE SET NULL: a conversation delete finds its rows.
    index("idx_steering_rules_contradicted_in_conversation")
      .on(t.contradictedInConversationId)
      .where(sql`contradicted_in_conversation_id IS NOT NULL`),
  ],
);
