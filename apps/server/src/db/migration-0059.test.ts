/**
 * Migration 0059 turns `steering_rules.source` into the `steering_rule_source`
 * enum and moves the channel defaults `seedChannelRules` wrote as `manual` to
 * `seed`. Runs the raw migration SQL against PGlite over rows written in the
 * pre-migration shape (the column put back to text first, since the pushed
 * schema already has the enum) and asserts which rows become `seed`, and that
 * a source outside the enum fails the cast.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { profiles } from "../agent/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database, Transactor } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0059_steering_rule_source.sql", import.meta.url)),
  "utf8",
);

const TABLES = "Avoid tables — they don't render on this channel. Use bullet lists instead.";
const CONCISE = "Prefer concise replies. For longer answers, use headings and short paragraphs.";
const NESTING = "Keep bullet lists to one level of nesting.";
const OPERATOR = "Never share the user's address.";

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
const SourceRowsSchema = z.object({
  rows: z.array(z.object({ id: z.string(), source: z.string() })),
});

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`ALTER TABLE steering_rules ALTER COLUMN source SET DATA TYPE text`);
  await db.execute(sql`DROP TYPE steering_rule_source`);
});

afterAll(async () => {
  await close();
});

/** A row as `seedChannelRules` wrote it, with `overrides` applied. */
function seeded(rule: string, overrides: Partial<LegacyRule>): LegacyRule {
  return {
    rule,
    source: "manual",
    category: "style",
    priority: 50,
    observationCount: 0,
    active: true,
    profileId: null,
    channelType: "telegram",
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

/** Insert each labelled rule through raw SQL, as the text column takes it; returns id → label. */
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

/** Each row's source after the migration, by label. */
async function sourcesBy(labels: ReadonlyMap<string, string>): Promise<Record<string, string>> {
  const { rows } = SourceRowsSchema.parse(
    await db.execute(sql`SELECT id, source::text AS source FROM steering_rules`),
  );
  return Object.fromEntries(rows.map((r) => [expectDefined(labels.get(r.id), r.id), r.source]));
}

describe("migration 0059 — steering rule source", () => {
  it("moves the rows seedChannelRules wrote to seed, and only those", async () => {
    const profileId = await seedProfile();
    const labels = await insert({
      tables: seeded(TABLES, {}),
      concise: seeded(CONCISE, {}),
      "nesting, disabled": seeded(NESTING, { active: false }),
      "other text": seeded("Use emoji sparingly.", {}),
      everywhere: seeded(TABLES, { channelType: null }),
      "other channel": seeded(TABLES, { channelType: "slack" }),
      "profile-scoped": seeded(TABLES, { profileId }),
      "other priority": seeded(TABLES, { priority: 10 }),
      "other category": seeded(TABLES, { category: "safety" }),
      observed: seeded(TABLES, { observationCount: 1 }),
      correction: seeded(TABLES, { source: "correction", priority: 100, observationCount: 2 }),
      operator: seeded(OPERATOR, { channelType: null, priority: 1 }),
      evolution: seeded("Keep it short.", { source: "evolution", channelType: null }),
    });

    await applyMigration();

    expect(await sourcesBy(labels)).toEqual({
      tables: "seed",
      concise: "seed",
      "nesting, disabled": "seed",
      "other text": "manual",
      everywhere: "manual",
      "other channel": "manual",
      "profile-scoped": "manual",
      "other priority": "manual",
      "other category": "manual",
      observed: "manual",
      correction: "correction",
      operator: "manual",
      evolution: "evolution",
    });
  });

  it("rejects a source outside the enum", async () => {
    await insert({ legacy: seeded(OPERATOR, { source: "signal_pipeline", channelType: null }) });

    await expect(applyMigration()).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/invalid input value for enum/) },
    });
  });

  it("leaves rows the store reads into their sections", async () => {
    await insert({
      tables: seeded(TABLES, {}),
      operator: seeded(OPERATOR, { channelType: null, priority: 1 }),
    });

    await applyMigration();

    const profileId = await seedProfile();
    const store = new DrizzleAgentStore();
    const rules = await tx((trx) => store.getActiveRules(trx, profileId));
    expect(Object.fromEntries(rules.map((r) => [r.rule, r.section]))).toEqual({
      [OPERATOR]: "always",
      [TABLES]: "channel_defaults",
    });
  });
});
