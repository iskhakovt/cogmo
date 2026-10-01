import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import {
  boolean,
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
export const LIVE_INSTRUCTION_RULE: SQL = sql`source = 'instruction' AND retracted_at IS NULL`;

/**
 * A live rule is active and unretired. An inactive, unretired rule is learning
 * when learned (`correction`, `evolution`) and switched off when an operator's
 * or a channel default (`manual`, `seed`), which review leaves out. A retired
 * one is inactive with `retracted_at` set. `user_id` and `quote` belong to
 * `instruction` rows, which are never inactive unless retired.
 */
export const steeringRules = pgTable(
  "steering_rules",
  {
    id: pk(),
    rule: text("rule").notNull(),
    category: text("category").notNull(), // 'safety' | 'style' | 'domain' | 'memory'
    active: boolean("active").notNull(),
    source: steeringRuleSource("source").notNull(),
    priority: integer("priority").notNull(),
    observationCount: integer("observation_count").notNull(),
    profileId: uuid("profile_id").references(() => profiles.id), // NULL = applies to all profiles
    channelType: text("channel_type"), // NULL = applies to all channels
    retractedAt: timestamp("retracted_at", { withTimezone: true }), // NULL = not retired
    // NULL = every user; set on every instruction row, so one user's
    // instructions stay out of another's prompt.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    quote: text("quote"), // the user's words `rule_set` quoted; set on every instruction row
    // NULL = never contradicted while learning. The conversation whose
    // contradiction reset the learning rule's count, then the one whose
    // contradiction retired it; one from the recorded conversation changes
    // nothing, so a retried or repeated extraction of one conversation applies
    // once. Any other retirement, and a deleted conversation, clears it; the
    // latter only costs one more reset.
    contradictedInConversationId: uuid("contradicted_in_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    createdAt: ts(),
  },
  (t) => [
    check(
      "chk_steering_rules_lifecycle",
      sql`NOT (${t.active} AND ${t.retractedAt} IS NOT NULL)
        AND (${t.source} <> 'instruction' OR ${t.active} OR ${t.retractedAt} IS NOT NULL)
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
