/**
 * Migration 0076 moves a steering rule's lifecycle from `active` and
 * `retracted_at` to the `steering_rule_status` enum in one transaction: it
 * adds the column, backfills it from `(active, retracted_at, source)`, makes it
 * NOT NULL, rebuilds `uq_steering_rules_instruction` on it, drops `active` and
 * adds the status `chk_steering_rules_lifecycle`. Runs the file's SQL against
 * PGlite over rows in the pre-migration shape (the pushed schema's `status`
 * and its enum dropped, `active` put back, the 0067 CHECK and index restored)
 * and asserts the status every combination the 0067 CHECK allowed lands in,
 * that the new CHECK holds each status to its sources, that a row the backfill
 * can't place rolls the whole file back, and that the store reads the rows.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { profiles, users } from "../agent/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0076_steering_rule_status.sql", import.meta.url)),
  "utf8",
);
const STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** A row as the pre-0076 writers left it. */
interface LegacyRule {
  rule: string;
  source: string;
  active: boolean;
  retired: boolean;
  observationCount: number;
  channelType: string | null;
  userId: string | null;
}

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const StatusRowsSchema = z.object({
  rows: z.array(
    z.object({ id: z.string(), status: z.string(), retracted_at: z.string().nullable() }),
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

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`DROP INDEX IF EXISTS uq_steering_rules_instruction`);
  await db.execute(
    sql`ALTER TABLE steering_rules DROP CONSTRAINT IF EXISTS chk_steering_rules_lifecycle`,
  );
  await db.execute(sql`ALTER TABLE steering_rules DROP COLUMN IF EXISTS status`);
  await db.execute(sql`DROP TYPE IF EXISTS steering_rule_status`);
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
    .values({ userId: null, name: "p", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  return expectDefined(row, "profile").id;
}

/** Insert each labelled rule in the pre-migration shape; returns id → label. */
async function insert(rules: Readonly<Record<string, LegacyRule>>): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const [label, r] of Object.entries(rules)) {
    const { rows } = IdRowsSchema.parse(
      await db.execute(sql`
        INSERT INTO steering_rules
          (rule, category, active, source, priority, observation_count, channel_type,
            retracted_at, user_id, quote)
        VALUES (${r.rule}, 'style', ${r.active}, ${r.source}, 100, ${r.observationCount},
          ${r.channelType}, ${r.retired ? sql`now()` : null}, ${r.userId},
          ${r.userId === null ? null : `quoted: ${r.rule}`})
        RETURNING id
      `),
    );
    labels.set(expectDefined(rows[0], label).id, label);
  }
  return labels;
}

/** Each row's status after the migration, by label, with whether it keeps a retirement time. */
async function statusBy(
  labels: ReadonlyMap<string, string>,
): Promise<Record<string, { status: string; retired: boolean }>> {
  const { rows } = StatusRowsSchema.parse(
    await db.execute(sql`SELECT id, status::text AS status, retracted_at FROM steering_rules`),
  );
  return Object.fromEntries(
    rows.map((r) => [
      expectDefined(labels.get(r.id), r.id),
      { status: r.status, retired: r.retracted_at !== null },
    ]),
  );
}

/** The lifecycle columns `steering_rules` holds. */
async function lifecycleColumns(): Promise<string[]> {
  const { rows } = ColumnRowsSchema.parse(
    await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'steering_rules' AND column_name IN ('active', 'status')
      ORDER BY column_name
    `),
  );
  return rows.map((r) => r.column_name);
}

async function hasStatusType(): Promise<boolean> {
  const { rows } = TypeRowsSchema.parse(
    await db.execute(sql`SELECT typname FROM pg_type WHERE typname = 'steering_rule_status'`),
  );
  return rows.length > 0;
}

/** A row written straight to the table in the migrated shape. */
function insertMigrated(params: {
  rule: string;
  source: string;
  status: string;
  retired?: boolean;
  userId?: string | null;
}) {
  const userId = params.userId ?? null;
  return db.execute(sql`
    INSERT INTO steering_rules
      (rule, category, status, source, priority, observation_count, retracted_at, user_id, quote)
    VALUES (${params.rule}, 'style', ${params.status}, ${params.source}, 100, 1,
      ${params.retired === true ? sql`now()` : null}, ${userId},
      ${userId === null ? null : "q"})
  `);
}

describe("migration 0076 — steering rule status", () => {
  it("backfills the status every lifecycle the old columns encode, and drops active", async () => {
    const userId = await seedUser();
    const existing = {
      operator: legacy("Never share the address.", { source: "manual", observationCount: 0 }),
      "operator, off": legacy("Sign off with a name.", {
        source: "manual",
        active: false,
        observationCount: 0,
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
      learning: legacy("Use metric units.", { active: false, observationCount: 1 }),
      "learning, reset": legacy("No bold.", { active: false, observationCount: 0 }),
      "learned, retired": legacy("No headings.", { active: false, retired: true }),
      merged: legacy("No emoji.", { source: "evolution", observationCount: 5 }),
      "merged, inactive": legacy("Be brief.", { source: "evolution", active: false }),
      stated: legacy("Reply in British English.", { source: "instruction", userId }),
      "stated, retired": legacy("Reply in French.", {
        source: "instruction",
        userId,
        active: false,
        retired: true,
      }),
    };
    const labels = await insert(existing);

    await applyMigration();

    expect(await statusBy(labels)).toEqual({
      operator: { status: "live", retired: false },
      "operator, off": { status: "disabled", retired: false },
      "operator, retired": { status: "retired", retired: true },
      default: { status: "live", retired: false },
      "default, off": { status: "disabled", retired: false },
      learned: { status: "live", retired: false },
      learning: { status: "learning", retired: false },
      "learning, reset": { status: "learning", retired: false },
      "learned, retired": { status: "retired", retired: true },
      merged: { status: "live", retired: false },
      "merged, inactive": { status: "learning", retired: false },
      stated: { status: "live", retired: false },
      "stated, retired": { status: "retired", retired: true },
    });
    expect(await lifecycleColumns()).toEqual(["status"]);
  });

  it("rolls the whole file back on a row the backfill can't place, so the next boot retries it", async () => {
    // An inactive, unretired instruction row, which the 0067 CHECK refuses:
    // written past it, it backfills to `disabled`, which the status CHECK
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
    expect(await hasStatusType()).toBe(false);
    expect(labels.size).toBe(2);
    const { rows } = IdRowsSchema.parse(
      await db.execute(sql`SELECT id FROM steering_rules WHERE active = false`),
    );
    expect(rows.map((r) => labels.get(r.id))).toEqual(["unplaceable"]);
  });

  it("then holds each status to its sources and retracted_at to retired", async () => {
    await applyMigration();
    const userId = await seedUser();
    const refused = [
      insertMigrated({ rule: "Learned, off", source: "correction", status: "disabled" }),
      insertMigrated({ rule: "Merged, off", source: "evolution", status: "disabled" }),
      insertMigrated({ rule: "Operator, learning", source: "manual", status: "learning" }),
      insertMigrated({ rule: "Default, learning", source: "seed", status: "learning" }),
      insertMigrated({
        rule: "Stated, learning",
        source: "instruction",
        status: "learning",
        userId,
      }),
      insertMigrated({ rule: "Stated, off", source: "instruction", status: "disabled", userId }),
      insertMigrated({ rule: "Live, dated", source: "correction", status: "live", retired: true }),
      insertMigrated({ rule: "Retired, undated", source: "correction", status: "retired" }),
    ];
    for (const attempt of refused) {
      expect(await sqlStateOf(attempt)).toBe(CHECK_VIOLATION);
    }

    await insertMigrated({ rule: "Operator, off", source: "manual", status: "disabled" });
    await insertMigrated({ rule: "Default, off", source: "seed", status: "disabled" });
    await insertMigrated({ rule: "Learning", source: "correction", status: "learning" });
    await insertMigrated({
      rule: "Retired",
      source: "evolution",
      status: "retired",
      retired: true,
    });
    await insertMigrated({ rule: "Stated", source: "instruction", status: "live", userId });
    await insertMigrated({
      rule: "Stated, retired",
      source: "instruction",
      status: "retired",
      retired: true,
      userId,
    });
  });

  it("then keeps one live instruction per user, normalized text and scope", async () => {
    await applyMigration();
    const userId = await seedUser();

    await insertMigrated({
      rule: "No bullet points.",
      source: "instruction",
      status: "live",
      userId,
    });
    expect(
      await sqlStateOf(
        insertMigrated({
          rule: "  no   BULLET\tpoints. ",
          source: "instruction",
          status: "live",
          userId,
        }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    await insertMigrated({
      rule: "No bullet points.",
      source: "instruction",
      status: "retired",
      retired: true,
      userId,
    });
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
    const store = new DrizzleAgentStore();
    const rendered = await tx((trx) => store.getActiveRules(trx, { profileId, userId }));
    expect(rendered.map((r) => r.rule).sort()).toEqual([
      "Keep it short.",
      "Never share the address.",
      "Reply in British English.",
    ]);
    const review = await tx((trx) => store.listRules(trx, { profileId, userId }));
    expect(review.learning.map((r) => r.rule)).toEqual(["Use metric units."]);
    expect(review.retired.map((r) => r.rule)).toEqual(["No headings."]);
  });
});
