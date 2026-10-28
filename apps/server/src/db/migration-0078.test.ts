/**
 * The `steering_rule_status` migration moves a steering rule's lifecycle from
 * `active` and `retracted_at` to the `steering_rule_status` enum and records
 * why a rule is retired, in one transaction: it adds `status` and
 * `retired_reason`, backfills both from `(active, retracted_at, source)` and
 * the contradiction record, clears that record on rows neither learning nor
 * retired, makes `status` NOT NULL, rebuilds `uq_steering_rules_instruction`
 * on it, drops `active` and adds the status `chk_steering_rules_lifecycle`.
 * Runs the file's SQL against PGlite over rows in the pre-migration shape
 * (the pushed schema's new columns and enums dropped, `active` put back, the
 * 0067 CHECK and index restored) and asserts where every combination the 0067
 * CHECK allowed lands, that the new CHECK holds each status to its sources and
 * its data, that a hand-edited row the CHECK refuses rolls the whole file
 * back, and that the store reads the rows.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleAgentStore } from "../agent/store/index.js";
import {
  profiles,
  type SteeringRuleRetiredReasonValue,
  type SteeringRuleSourceValue,
  type SteeringRuleStatusValue,
  users,
} from "../agent/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0078_steering_rule_status.sql", import.meta.url)),
  "utf8",
);
const STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** A row as the pre-migration writers left it. */
interface LegacyRule {
  rule: string;
  source: string;
  active: boolean;
  retired: boolean;
  observationCount: number;
  channelType: string | null;
  userId: string | null;
  /** The conversation a contradiction recorded. */
  contradictedIn: string | null;
}

/** A row in the migrated shape. */
interface MigratedRule {
  rule: string;
  source: SteeringRuleSourceValue;
  status: SteeringRuleStatusValue;
  retired: boolean;
  reason: SteeringRuleRetiredReasonValue | null;
  userId: string | null;
  contradictedIn: string | null;
}

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const MigratedRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      retracted_at: z.string().nullable(),
      retired_reason: z.string().nullable(),
      contradicted_in_conversation_id: z.string().nullable(),
    }),
  ),
});
const ColumnRowsSchema = z.object({ rows: z.array(z.object({ column_name: z.string() })) });
const TypeRowsSchema = z.object({ rows: z.array(z.object({ typname: z.string() })) });
/** The SQLSTATE a driver error carries, one `cause` down from what Drizzle throws. */
const SqlStateSchema = z.object({ cause: z.object({ code: z.string() }) });

/** The SQLSTATE `promise` rejects with; what it rejected with when it is no Postgres error; null on success. */
async function sqlStateOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => {
      const parsed = SqlStateSchema.safeParse(error);
      return parsed.success ? parsed.data.cause.code : String(error);
    },
  );
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleAgentStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`DROP INDEX IF EXISTS uq_steering_rules_instruction`);
  await db.execute(
    sql`ALTER TABLE steering_rules DROP CONSTRAINT IF EXISTS chk_steering_rules_lifecycle`,
  );
  await db.execute(sql`
    ALTER TABLE steering_rules DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS retired_reason
  `);
  await db.execute(sql`DROP TYPE IF EXISTS steering_rule_status`);
  await db.execute(sql`DROP TYPE IF EXISTS steering_rule_retired_reason`);
  await db.execute(sql`
    ALTER TABLE steering_rules ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true
  `);
  await db.execute(sql`ALTER TABLE steering_rules ALTER COLUMN active DROP DEFAULT`);
  await db.execute(sql`
    ALTER TABLE steering_rules ADD CONSTRAINT chk_steering_rules_lifecycle CHECK (
      NOT (active AND retracted_at IS NOT NULL)
      AND (source <> 'instruction' OR active OR retracted_at IS NOT NULL)
      AND ((source = 'instruction') = (user_id IS NOT NULL))
      AND ((source = 'instruction') = (quote IS NOT NULL)))
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX uq_steering_rules_instruction ON steering_rules
      (lower(btrim(regexp_replace(rule, '[[:space:]]+', ' ', 'g'))), user_id,
        COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(channel_type, ''))
      WHERE source = 'instruction' AND retracted_at IS NULL
  `);
});

afterAll(async () => {
  await close();
});

/** Apply the file as `migratePerFile` does: every statement in one transaction. */
async function applyMigration(): Promise<void> {
  await db.transaction(async (trx) => {
    for (const stmt of STATEMENTS) {
      await trx.execute(sql.raw(stmt));
    }
  });
}

function legacy(rule: string, overrides: Partial<LegacyRule>): LegacyRule {
  return {
    rule,
    source: "correction",
    active: true,
    retired: false,
    observationCount: 2,
    channelType: null,
    userId: null,
    contradictedIn: null,
    ...overrides,
  };
}

function migrated(rule: string, overrides: Partial<MigratedRule>): MigratedRule {
  return {
    rule,
    source: "correction",
    status: "live",
    retired: false,
    reason: null,
    userId: null,
    contradictedIn: null,
    ...overrides,
  };
}

async function seedUser(): Promise<string> {
  const [row] = await db.insert(users).values({}).returning({ id: users.id });
  return expectDefined(row, "user").id;
}

async function seedProfile(): Promise<string> {
  const [row] = await db
    .insert(profiles)
    .values({ userId: null, name: `p-${Math.random()}`, basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  return expectDefined(row, "profile").id;
}

async function seedConversation(): Promise<string> {
  const userId = await seedUser();
  const profileId = await seedProfile();
  return (await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true })))
    .id;
}

/** Insert each labelled rule in the pre-migration shape; returns id → label. */
async function insert(rules: Readonly<Record<string, LegacyRule>>): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const [label, r] of Object.entries(rules)) {
    const { rows } = IdRowsSchema.parse(
      await db.execute(sql`
        INSERT INTO steering_rules
          (rule, category, active, source, priority, observation_count, channel_type,
            retracted_at, user_id, quote, contradicted_in_conversation_id)
        VALUES (${r.rule}, 'style', ${r.active}, ${r.source}, 100, ${r.observationCount},
          ${r.channelType}, ${r.retired ? sql`now()` : null}, ${r.userId},
          ${r.userId === null ? null : `quoted: ${r.rule}`}, ${r.contradictedIn})
        RETURNING id
      `),
    );
    labels.set(expectDefined(rows[0], label).id, label);
  }
  return labels;
}

interface Landed {
  status: string;
  retired: boolean;
  reason: string | null;
  contradictedIn: string | null;
}

/** Each row after the migration, by label. */
async function landedBy(labels: ReadonlyMap<string, string>): Promise<Record<string, Landed>> {
  const { rows } = MigratedRowsSchema.parse(
    await db.execute(sql`
      SELECT id, status::text AS status, retracted_at, retired_reason::text AS retired_reason,
        contradicted_in_conversation_id
      FROM steering_rules
    `),
  );
  return Object.fromEntries(
    rows.map((r) => [
      expectDefined(labels.get(r.id), r.id),
      {
        status: r.status,
        retired: r.retracted_at !== null,
        reason: r.retired_reason,
        contradictedIn: r.contradicted_in_conversation_id,
      },
    ]),
  );
}

/** The lifecycle columns `steering_rules` holds. */
async function lifecycleColumns(): Promise<string[]> {
  const { rows } = ColumnRowsSchema.parse(
    await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'steering_rules'
        AND column_name IN ('active', 'status', 'retired_reason')
      ORDER BY column_name
    `),
  );
  return rows.map((r) => r.column_name);
}

async function statusTypes(): Promise<string[]> {
  const { rows } = TypeRowsSchema.parse(
    await db.execute(sql`
      SELECT typname FROM pg_type
      WHERE typname IN ('steering_rule_status', 'steering_rule_retired_reason')
      ORDER BY typname
    `),
  );
  return rows.map((r) => r.typname);
}

/** A row written straight to the table in the migrated shape. */
function insertMigrated(r: MigratedRule) {
  return db.execute(sql`
    INSERT INTO steering_rules
      (rule, category, status, source, priority, observation_count, retracted_at,
        retired_reason, user_id, quote, contradicted_in_conversation_id)
    VALUES (${r.rule}, 'style', ${r.status}, ${r.source}, 100, 1,
      ${r.retired ? sql`now()` : null}, ${r.reason}, ${r.userId},
      ${r.userId === null ? null : "q"}, ${r.contradictedIn})
  `);
}

const live = (status: string): Landed => ({
  status,
  retired: false,
  reason: null,
  contradictedIn: null,
});
const retired = (reason: string, contradictedIn: string | null): Landed => ({
  status: "retired",
  retired: true,
  reason,
  contradictedIn,
});

describe("migration steering_rule_status", () => {
  it("backfills every lifecycle the old columns encode, and drops active", async () => {
    const userId = await seedUser();
    const convA = await seedConversation();
    const convB = await seedConversation();
    const labels = await insert({
      operator: legacy("Never share the address.", { source: "manual", observationCount: 0 }),
      "operator, off": legacy("Sign off with a name.", {
        source: "manual",
        active: false,
        observationCount: 0,
      }),
      "operator, off, marked": legacy("Sign with initials.", {
        source: "manual",
        active: false,
        observationCount: 0,
        contradictedIn: convA,
      }),
      "operator, retired": legacy("Use emoji.", {
        source: "manual",
        active: false,
        retired: true,
        observationCount: 0,
      }),
      default: legacy("Avoid tables.", {
        source: "seed",
        observationCount: 0,
        channelType: "telegram",
      }),
      "default, off": legacy("Keep lists flat.", {
        source: "seed",
        active: false,
        observationCount: 0,
        channelType: "telegram",
      }),
      learned: legacy("Keep it short.", {}),
      "learned, once reset": legacy("No tables.", { contradictedIn: convA }),
      learning: legacy("Use metric units.", { active: false, observationCount: 1 }),
      "learning, reset": legacy("No bold.", {
        active: false,
        observationCount: 0,
        contradictedIn: convA,
      }),
      "learned, retired by hand": legacy("No headings.", { active: false, retired: true }),
      "learned, contradicted": legacy("No lists.", {
        active: false,
        retired: true,
        contradictedIn: convB,
      }),
      merged: legacy("No emoji.", { source: "evolution", observationCount: 5 }),
      "merged, inactive": legacy("Be brief.", { source: "evolution", active: false }),
      stated: legacy("Reply in British English.", { source: "instruction", userId }),
      "stated, retired": legacy("Reply in French.", {
        source: "instruction",
        userId,
        active: false,
        retired: true,
      }),
    });

    await applyMigration();

    expect(await landedBy(labels)).toEqual({
      operator: live("live"),
      "operator, off": live("disabled"),
      "operator, off, marked": live("disabled"),
      "operator, retired": retired("unknown", null),
      default: live("live"),
      "default, off": live("disabled"),
      learned: live("live"),
      "learned, once reset": live("live"),
      learning: live("learning"),
      "learning, reset": { ...live("learning"), contradictedIn: convA },
      "learned, retired by hand": retired("unknown", null),
      "learned, contradicted": retired("contradicted", convB),
      merged: live("live"),
      "merged, inactive": live("learning"),
      stated: live("live"),
      "stated, retired": retired("unknown", null),
    });
    expect(await lifecycleColumns()).toEqual(["retired_reason", "status"]);
  });

  it("rolls the whole file back on a hand-edited row the CHECK refuses", async () => {
    // An inactive, unretired instruction row, which no build writes and the
    // 0067 CHECK refuses: written past it by hand, it backfills to `disabled`, which the status CHECK
    // refuses on an instruction.
    const userId = await seedUser();
    await db.execute(sql`ALTER TABLE steering_rules DROP CONSTRAINT chk_steering_rules_lifecycle`);
    const labels = await insert({
      learned: legacy("Keep it short.", {}),
      unplaceable: legacy("Reply in French.", { source: "instruction", userId, active: false }),
    });
    await db.execute(sql`
      ALTER TABLE steering_rules ADD CONSTRAINT chk_steering_rules_lifecycle CHECK (
        NOT (active AND retracted_at IS NOT NULL)
        AND (source <> 'instruction' OR active OR retracted_at IS NOT NULL)
        AND ((source = 'instruction') = (user_id IS NOT NULL))
        AND ((source = 'instruction') = (quote IS NOT NULL))) NOT VALID
    `);

    expect(await sqlStateOf(applyMigration())).toBe(CHECK_VIOLATION);

    expect(await lifecycleColumns()).toEqual(["active"]);
    expect(await statusTypes()).toEqual([]);
    expect(labels.size).toBe(2);
    const { rows } = IdRowsSchema.parse(
      await db.execute(sql`SELECT id FROM steering_rules WHERE active = false`),
    );
    expect(rows.map((r) => labels.get(r.id))).toEqual(["unplaceable"]);
  });

  it("then holds each status to its sources and its data", async () => {
    await applyMigration();
    const userId = await seedUser();
    const convId = await seedConversation();
    const refused = [
      migrated("Learned, off", { status: "disabled" }),
      migrated("Merged, off", { source: "evolution", status: "disabled" }),
      migrated("Operator, learning", { source: "manual", status: "learning" }),
      migrated("Default, learning", { source: "seed", status: "learning" }),
      migrated("Stated, learning", { source: "instruction", status: "learning", userId }),
      migrated("Stated, off", { source: "instruction", status: "disabled", userId }),
      migrated("Live, dated", { retired: true }),
      migrated("Live, reasoned", { reason: "removed_by_user" }),
      migrated("Live, contradicted", { contradictedIn: convId }),
      migrated("Off, contradicted", {
        source: "manual",
        status: "disabled",
        contradictedIn: convId,
      }),
      migrated("Retired, undated", { status: "retired", reason: "removed_by_user" }),
      migrated("Retired, unreasoned", { status: "retired", retired: true }),
    ];
    for (const row of refused) {
      expect(await sqlStateOf(insertMigrated(row)), row.rule).toBe(CHECK_VIOLATION);
    }

    await insertMigrated(migrated("Operator, off", { source: "manual", status: "disabled" }));
    await insertMigrated(migrated("Default, off", { source: "seed", status: "disabled" }));
    await insertMigrated(migrated("Learning", { status: "learning" }));
    await insertMigrated(
      migrated("Learning, reset", { status: "learning", contradictedIn: convId }),
    );
    await insertMigrated(
      migrated("Retired", {
        source: "evolution",
        status: "retired",
        retired: true,
        reason: "superseded",
      }),
    );
    await insertMigrated(
      migrated("Retired, contradicted", {
        status: "retired",
        retired: true,
        reason: "contradicted",
        contradictedIn: convId,
      }),
    );
    await insertMigrated(migrated("Stated", { source: "instruction", userId }));
    await insertMigrated(
      migrated("Stated, retired", {
        source: "instruction",
        status: "retired",
        retired: true,
        reason: "removed_by_user",
        userId,
      }),
    );
  });

  it("then keeps one live instruction per user, normalized text and scope", async () => {
    await applyMigration();
    const userId = await seedUser();

    await insertMigrated(migrated("No bullet points.", { source: "instruction", userId }));
    expect(
      await sqlStateOf(
        insertMigrated(migrated("  no   BULLET\tpoints. ", { source: "instruction", userId })),
      ),
    ).toBe(UNIQUE_VIOLATION);
    await insertMigrated(
      migrated("No bullet points.", {
        source: "instruction",
        status: "retired",
        retired: true,
        reason: "removed_by_user",
        userId,
      }),
    );
  });

  it("leaves rows the store reads by status", async () => {
    const userId = await seedUser();
    await insert({
      operator: legacy("Never share the address.", { source: "manual", observationCount: 0 }),
      "operator, off": legacy("Sign off.", {
        source: "manual",
        active: false,
        observationCount: 0,
      }),
      learned: legacy("Keep it short.", {}),
      learning: legacy("Use metric units.", { active: false, observationCount: 1 }),
      retired: legacy("No headings.", { active: false, retired: true }),
      stated: legacy("Reply in British English.", { source: "instruction", userId }),
    });

    await applyMigration();

    const profileId = await seedProfile();
    const rendered = await tx((trx) => store.getActiveRules(trx, { profileId, userId }));
    expect(rendered.map((r) => r.rule).sort()).toEqual([
      "Keep it short.",
      "Never share the address.",
      "Reply in British English.",
    ]);
    const review = await tx((trx) => store.listRules(trx, { profileId, userId }));
    expect(review.learning.map((r) => r.rule)).toEqual(["Use metric units."]);
    expect(review.retired.map((r) => r.rule)).toEqual(["No headings."]);
    const set = await tx((trx) =>
      store.setInstructionRule(trx, {
        rule: "Keep it short.",
        category: "style",
        userId,
        profileId: null,
        channelType: null,
        quote: "keep it short",
      }),
    );
    expect(set.kind).toBe("new");
  });
});
