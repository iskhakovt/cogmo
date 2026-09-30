/**
 * Migration 0067 adds `retracted_at`, `user_id` and `quote` to
 * `steering_rules`, with `chk_steering_rules_lifecycle` and
 * `uq_steering_rules_instruction`. Runs the raw migration SQL against PGlite
 * over rows written in the pre-migration shape (the pushed schema's columns,
 * CHECK and index dropped first) and asserts that every existing row survives
 * with the new columns NULL, that the constraints hold afterwards, and that an
 * `instruction` row, which no pre-migration writer produces, fails the CHECK.
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
  fileURLToPath(new URL("../../migrations/0067_steering_rule_instructions.sql", import.meta.url)),
  "utf8",
);

interface LegacyRule {
  rule: string;
  source: string;
  category: string;
  priority: number;
  observationCount: number;
  active: boolean;
  profileId: string | null;
  channelType: string | null;
}

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const MigratedRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      rule: z.string(),
      source: z.string(),
      category: z.string(),
      active: z.boolean(),
      priority: z.number(),
      observation_count: z.number(),
      profile_id: z.string().nullable(),
      channel_type: z.string().nullable(),
      retracted_at: z.null(),
      user_id: z.null(),
      quote: z.null(),
    }),
  ),
});

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
  await db.execute(sql`
    ALTER TABLE steering_rules
      DROP COLUMN IF EXISTS retracted_at,
      DROP COLUMN IF EXISTS user_id,
      DROP COLUMN IF EXISTS quote
  `);
});

afterAll(async () => {
  await close();
});

function legacy(rule: string, overrides: Partial<LegacyRule>): LegacyRule {
  return {
    rule,
    source: "correction",
    category: "style",
    priority: 100,
    observationCount: 2,
    active: true,
    profileId: null,
    channelType: null,
    ...overrides,
  };
}

async function seedProfile(): Promise<string> {
  const [row] = await db
    .insert(profiles)
    .values({ userId: null, name: "p", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  return expectDefined(row, "profile").id;
}

async function seedUser(): Promise<string> {
  const [row] = await db.insert(users).values({}).returning({ id: users.id });
  return expectDefined(row, "user").id;
}

/** Insert each labelled rule in the pre-migration shape; returns id → label. */
async function insert(rules: Readonly<Record<string, LegacyRule>>): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const [label, r] of Object.entries(rules)) {
    const { rows } = IdRowsSchema.parse(
      await db.execute(sql`
        INSERT INTO steering_rules
          (rule, category, active, source, priority, observation_count, profile_id, channel_type)
        VALUES (${r.rule}, ${r.category}, ${r.active}, ${r.source}, ${r.priority},
          ${r.observationCount}, ${r.profileId}, ${r.channelType})
        RETURNING id
      `),
    );
    labels.set(expectDefined(rows[0], label).id, label);
  }
  return labels;
}

async function applyMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

/** A live instruction row written straight to the table, past the store. */
function insertInstruction(params: {
  rule: string;
  userId: string | null;
  quote: string | null;
  active?: boolean;
  retracted?: boolean;
}) {
  return db.execute(sql`
    INSERT INTO steering_rules
      (rule, category, active, source, priority, observation_count, user_id, quote, retracted_at)
    VALUES (${params.rule}, 'style', ${params.active ?? true}, 'instruction', 100, 1,
      ${params.userId}, ${params.quote}, ${params.retracted === true ? sql`now()` : null})
  `);
}

describe("migration 0067 — steering rule instructions", () => {
  it("keeps every existing row as it was, with no retirement, user or quote", async () => {
    const profileId = await seedProfile();
    const existing = {
      operator: legacy("Never share the user's address.", {
        source: "manual",
        category: "safety",
        priority: 1,
        observationCount: 0,
      }),
      "operator, off": legacy("Sign off with a name.", {
        source: "manual",
        active: false,
        observationCount: 0,
      }),
      default: legacy("Avoid tables.", {
        source: "seed",
        priority: 50,
        observationCount: 0,
        channelType: "telegram",
      }),
      learned: legacy("Keep it short.", {}),
      learning: legacy("Use metric units.", { active: false, observationCount: 1 }),
      merged: legacy("No emoji.", { source: "evolution", profileId }),
    };
    const labels = await insert(existing);

    await applyMigration();

    const { rows } = MigratedRowsSchema.parse(
      await db.execute(sql`
        SELECT id, rule, source::text AS source, category, active, priority, observation_count,
          profile_id, channel_type, retracted_at, user_id, quote
        FROM steering_rules
      `),
    );
    const migrated: Record<string, LegacyRule> = Object.fromEntries(
      rows.map((r) => [
        expectDefined(labels.get(r.id), r.id),
        {
          rule: r.rule,
          source: r.source,
          category: r.category,
          priority: r.priority,
          observationCount: r.observation_count,
          active: r.active,
          profileId: r.profile_id,
          channelType: r.channel_type,
        },
      ]),
    );
    expect(migrated).toEqual(existing);
  });

  it("fails on an instruction row, which carries no user or quote to keep", async () => {
    await insert({ stated: legacy("Reply in British English.", { source: "instruction" }) });

    await expect(applyMigration()).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/chk_steering_rules_lifecycle/) },
    });
  });

  it("then holds a retired rule inactive, an instruction live or retired, and user and quote to instructions", async () => {
    await applyMigration();
    const userId = await seedUser();
    const violation = { cause: { message: expect.stringMatching(/chk_steering_rules_lifecycle/) } };

    await expect(
      db.execute(sql`
        INSERT INTO steering_rules (rule, category, active, source, priority, observation_count, retracted_at)
        VALUES ('Retired but active', 'style', true, 'correction', 100, 2, now())
      `),
    ).rejects.toMatchObject(violation);
    await expect(
      insertInstruction({ rule: "Learning", userId, quote: "q", active: false }),
    ).rejects.toMatchObject(violation);
    await expect(
      insertInstruction({ rule: "No owner", userId: null, quote: "q" }),
    ).rejects.toMatchObject(violation);
    await expect(
      insertInstruction({ rule: "No quote", userId, quote: null }),
    ).rejects.toMatchObject(violation);
    await expect(
      db.execute(sql`
        INSERT INTO steering_rules (rule, category, active, source, priority, observation_count, user_id)
        VALUES ('Learned, owned', 'style', true, 'correction', 100, 2, ${userId})
      `),
    ).rejects.toMatchObject(violation);
    await expect(
      db.execute(sql`
        INSERT INTO steering_rules (rule, category, active, source, priority, observation_count, quote)
        VALUES ('Learned, quoted', 'style', true, 'correction', 100, 2, 'q')
      `),
    ).rejects.toMatchObject(violation);

    await insertInstruction({
      rule: "Retired",
      userId,
      quote: "q",
      active: false,
      retracted: true,
    });
  });

  it("then allows one live instruction per user, normalized text and scope", async () => {
    await applyMigration();
    const userId = await seedUser();
    const otherUserId = await seedUser();

    await insertInstruction({ rule: "No bullet points.", userId, quote: "q" });
    await expect(
      insertInstruction({ rule: "  no   BULLET\tpoints. ", userId, quote: "q" }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/uq_steering_rules_instruction/) },
    });

    await insertInstruction({ rule: "No bullet points.", userId: otherUserId, quote: "q" });
    await insertInstruction({
      rule: "No bullet points.",
      userId,
      quote: "q",
      active: false,
      retracted: true,
    });
  });

  it("leaves rows the store reads into their sections", async () => {
    await insert({
      operator: legacy("Never share the user's address.", {
        source: "manual",
        category: "safety",
        priority: 1,
      }),
      learned: legacy("Keep it short.", {}),
    });

    await applyMigration();

    const profileId = await seedProfile();
    const store = new DrizzleAgentStore();
    const rules = await tx((trx) => store.getActiveRules(trx, { profileId, userId: null }));
    expect(Object.fromEntries(rules.map((r) => [r.rule, r.section]))).toEqual({
      "Never share the user's address.": "always",
      "Keep it short.": "learned",
    });
  });
});
