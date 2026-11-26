/**
 * Migrations 0093 and 0094 give `turn_observations` its memories phase: 0093
 * adds the enum values alone, and 0094 adds `extraction`, the wider partial
 * index and the CHECK's memories terms, and starts each conversation's
 * memories cursor where the transcript-era Observer stopped. Every answered
 * turn at or below the boundary of the latest fire that retained a fact is
 * `skipped` (`backfilled`), any other answered turn older than 30 days is
 * `skipped` (`aged_out`), and every other turn gets no row. Rebuilds the table
 * as 0081 created it (the table, its enums and the steering rule marker
 * dropped, the rule CHECK as it stood before 0081 restored, then 0081's SQL),
 * seeds rows in that shape, and applies 0093 and 0094 one transaction per
 * file, as `migratePerFile` does.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conversations,
  evolutionEvents,
  messages,
  profiles,
  users,
} from "../agent/store/schema.js";
import { DrizzleTurnObservationStore } from "../agent/store/turn-observations.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { inboundMessages } from "../transport/store/schema.js";
import type { Database, Transactor } from "./index.js";

async function statements(tag: string): Promise<ReadonlyArray<string>> {
  return (
    await readFile(fileURLToPath(new URL(`../../migrations/${tag}.sql`, import.meta.url)), "utf8")
  )
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const TURN_OBSERVATIONS = await statements("0081_turn_observations");
const MEMORIES_VALUES = await statements("0093_observation_memories_values");
const MEMORIES = await statements("0094_observation_memories");

const MemoriesRowsSchema = z.object({
  rows: z.array(
    z.object({
      turn_cursor: z.string(),
      turn_kind: z.string(),
      status: z.string(),
      skip_reason: z.string().nullable(),
      attempts: z.number(),
      has_extraction: z.boolean(),
    }),
  ),
});
const CorrectionsRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      conversation_id: z.string(),
      turn_cursor: z.string(),
      turn_kind: z.string(),
      status: z.string(),
      skip_reason: z.string().nullable(),
      attempts: z.number(),
      failure_kind: z.string().nullable(),
      failure_message: z.string().nullable(),
      updated_at: z.string(),
      created_at: z.string(),
    }),
  ),
});
const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const IndexRowsSchema = z.object({ rows: z.array(z.object({ indexname: z.string() })) });

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(
    sql`ALTER TABLE steering_rules DROP CONSTRAINT IF EXISTS chk_steering_rules_lifecycle`,
  );
  await db.execute(sql`DROP INDEX IF EXISTS idx_steering_rules_contradicted_in_turn`);
  await db.execute(sql`ALTER TABLE steering_rules DROP COLUMN IF EXISTS contradicted_in_turn_id`);
  await db.execute(sql`DROP TABLE IF EXISTS turn_observations`);
  await db.execute(sql`
    DROP TYPE IF EXISTS observation_failure_kind, observation_phase, observation_skip_reason,
      observation_status, turn_kind
  `);
  await db.execute(sql`
    ALTER TABLE steering_rules ADD CONSTRAINT chk_steering_rules_lifecycle CHECK (
      ((status = 'retired') = (retracted_at IS NOT NULL))
      AND ((status = 'retired') = (retired_reason IS NOT NULL))
      AND (contradicted_in_conversation_id IS NULL OR status IN ('learning', 'retired'))
      AND (status <> 'learning' OR source IN ('correction', 'evolution'))
      AND (status <> 'disabled' OR source IN ('manual', 'seed'))
      AND ((source = 'instruction') = (user_id IS NOT NULL))
      AND ((source = 'instruction') = (quote IS NOT NULL)))
  `);
  // On empty tables, so its corrections backfill writes nothing.
  await applyFile(TURN_OBSERVATIONS);
});

afterAll(async () => {
  await close();
});

/** Apply a file as `migratePerFile` does: every statement in one transaction. */
async function applyFile(stmts: ReadonlyArray<string>): Promise<void> {
  await db.transaction(async (trx) => {
    for (const stmt of stmts) {
      await trx.execute(sql.raw(stmt));
    }
  });
}

/** 0093, committed, then 0094: 0094 names the values 0093 adds. */
async function migrate(): Promise<void> {
  await applyFile(MEMORIES_VALUES);
  await applyFile(MEMORIES);
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Conversation {
  id: string;
  profileId: string;
  userId: string;
  /** Messages written so far. */
  count: number;
}

async function seedConversation(): Promise<Conversation> {
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: null, name: `p-${randomUUID()}`, basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  const userId = expectDefined(user, "user").id;
  const profileId = expectDefined(profile, "profile").id;
  const [conv] = await db
    .insert(conversations)
    .values({ userId, profileId, isPrivate: true })
    .returning({ id: conversations.id });
  return { id: expectDefined(conv, "conversation").id, profileId, userId, count: 0 };
}

async function message(
  conv: Conversation,
  role: "user" | "assistant",
  cursor: string,
  createdAt: Date,
): Promise<void> {
  await db.insert(messages).values({
    conversationId: conv.id,
    role,
    content: `${role} ${conv.count}`,
    profileId: conv.profileId,
    model: "m",
    lastInboundMessageId: cursor,
    firstInboundMessageId: null,
    outputTokens: -1,
    createdAt,
  });
  conv.count++;
}

/** One turn's rows on a fresh cursor, `daysAgo` old; a turn with no reply is unanswered. */
async function turn(
  conv: Conversation,
  opts: { answered?: boolean; daysAgo?: number; cursor?: string } = {},
): Promise<string> {
  const cursor = opts.cursor ?? randomUUID();
  const createdAt = new Date(Date.now() - (opts.daysAgo ?? 0) * DAY_MS);
  await message(conv, "user", cursor, createdAt);
  if (opts.answered !== false) await message(conv, "assistant", cursor, createdAt);
  return cursor;
}

/** A scheduled or pipeline inbound of `conv`: the cursor of a turn of that kind. */
async function inbound(conv: Conversation, source: "scheduled" | "pipeline"): Promise<string> {
  const [row] = await db
    .insert(inboundMessages)
    .values({
      source,
      idempotencyKey: `${source}:${randomUUID()}`,
      conversationId: conv.id,
      content: "a task prompt",
      platformTs: new Date(),
    })
    .returning({ id: inboundMessages.id });
  return expectDefined(row, "inbound").id;
}

/** A transcript-era fire that read the first `messageCount` messages and retained `extracted` facts. */
async function fire(
  conv: Conversation,
  messageCount: number,
  opts: { extracted: number; failedPhases?: Array<"corrections" | "memories"> },
): Promise<void> {
  await db.insert(evolutionEvents).values({
    conversationId: conv.id,
    userId: conv.userId,
    triggeredBy: "idle",
    payload: {
      corrections: {
        extracted: 0,
        reinforced: 0,
        contradictions: 0,
        retired: 0,
        reset: 0,
        promoted: 0,
        outOfScopeReinforcementsSkipped: 0,
        outOfScopeContradictionsSkipped: 0,
        unknownRuleReinforcementsSkipped: 0,
        consolidationNeeded: false,
      },
      consolidation: null,
      memories: {
        extracted: opts.extracted,
        byNetwork: opts.extracted > 0 ? { world: opts.extracted } : {},
        skippedForUnseenRules: 0,
      },
      drained: { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty: 0 },
      messageCount,
      profileId: conv.profileId,
      ...(opts.failedPhases !== undefined && { failedPhases: opts.failedPhases }),
    },
  });
}

/** Each memories row after the migration, by turn cursor; every one a skip the migration wrote. */
async function memoriesRows(): Promise<Map<string, { kind: string; skipReason: string | null }>> {
  const { rows } = MemoriesRowsSchema.parse(
    await db.execute(sql`
      SELECT turn_cursor, turn_kind::text AS turn_kind, status::text AS status,
        skip_reason::text AS skip_reason, attempts, extraction IS NOT NULL AS has_extraction
      FROM turn_observations
      WHERE phase = 'memories'
    `),
  );
  expect(
    rows.filter((r) => r.status !== "skipped" || r.attempts !== 0 || r.has_extraction),
  ).toEqual([]);
  return new Map(
    rows.map((r) => [r.turn_cursor, { kind: r.turn_kind, skipReason: r.skip_reason }]),
  );
}

async function correctionsRows() {
  return CorrectionsRowsSchema.parse(
    await db.execute(sql`
      SELECT id, conversation_id, turn_cursor, turn_kind::text AS turn_kind,
        status::text AS status, skip_reason::text AS skip_reason, attempts,
        failure_kind::text AS failure_kind, failure_message,
        updated_at::text AS updated_at, created_at::text AS created_at
      FROM turn_observations
      WHERE phase = 'corrections'
      ORDER BY id
    `),
  ).rows;
}

/** The answered turns discovery would insert as `pending` memories rows. */
async function undiscovered(conv: Conversation): Promise<ReadonlySet<string>> {
  const found = await tx((trx) =>
    new DrizzleTurnObservationStore().listUndiscoveredTurns(trx, {
      conversationId: conv.id,
      phase: "memories",
    }),
  );
  return new Set(found.map((t) => t.cursor));
}

const backfilled = { kind: "chat", skipReason: "backfilled" };
const agedOut = { kind: "chat", skipReason: "aged_out" };

describe("migration observation_memories", () => {
  it("backfills the turns the latest fire that retained a fact read, and leaves the rest to discovery", async () => {
    const conv = await seedConversation();
    const read1 = await turn(conv);
    const lost = await turn(conv, { answered: false });
    const read2 = await turn(conv);
    await fire(conv, conv.count, { extracted: 2 });
    // A fire landing between a turn row and its reply: the turn straddles it.
    const straddling = await turn(conv, { answered: false });
    await fire(conv, conv.count, { extracted: 1 });
    await message(conv, "assistant", straddling, new Date());
    const unread = await turn(conv);
    // A later fire that retained nothing proves no read: the boundary stays.
    await fire(conv, conv.count, { extracted: 0, failedPhases: [] });

    await migrate();

    expect(await memoriesRows()).toEqual(
      new Map([
        [read1, backfilled],
        [read2, backfilled],
      ]),
    );
    const found = await undiscovered(conv);
    expect(found).toEqual(new Set([straddling, unread]));
    expect(found.has(lost)).toBe(false);
  });

  it("takes a boundary only from a fire that retained a fact and counted no more messages than exist", async () => {
    // Corrections returned and memories retained nothing.
    const noFacts = await seedConversation();
    const noFactsTurn = await turn(noFacts);
    await fire(noFacts, noFacts.count, { extracted: 0, failedPhases: [] });
    const failed = await seedConversation();
    const failedTurn = await turn(failed);
    await fire(failed, failed.count, { extracted: 0, failedPhases: ["memories"] });
    // A fire claiming more messages than the conversation holds is no
    // evidence; the earlier fire's boundary stands.
    const overcounted = await seedConversation();
    const underBoundary = await turn(overcounted);
    const overBoundary = await turn(overcounted);
    await fire(overcounted, 2, { extracted: 1 });
    await fire(overcounted, overcounted.count + 5, { extracted: 3 });

    await migrate();

    expect(await memoriesRows()).toEqual(new Map([[underBoundary, backfilled]]));
    expect(await undiscovered(noFacts)).toEqual(new Set([noFactsTurn]));
    expect(await undiscovered(failed)).toEqual(new Set([failedTurn]));
    expect(await undiscovered(overcounted)).toEqual(new Set([overBoundary]));
  });

  it("ages out an answered turn over 30 days old that no qualifying fire read", async () => {
    const unobserved = await seedConversation();
    const old = await turn(unobserved, { daysAgo: 40 });
    const oldUnanswered = await turn(unobserved, { daysAgo: 40, answered: false });
    const recent = await turn(unobserved, { daysAgo: 29 });
    const observed = await seedConversation();
    const read = await turn(observed, { daysAgo: 60 });
    await fire(observed, observed.count, { extracted: 1 });
    const oldUnread = await turn(observed, { daysAgo: 40 });
    const recentUnread = await turn(observed, { daysAgo: 1 });

    await migrate();

    expect(await memoriesRows()).toEqual(
      new Map([
        [old, agedOut],
        [read, backfilled],
        [oldUnread, agedOut],
      ]),
    );
    const found = await undiscovered(unobserved);
    expect(found).toEqual(new Set([recent]));
    expect(found.has(oldUnanswered)).toBe(false);
    expect(await undiscovered(observed)).toEqual(new Set([recentUnread]));
  });

  it("reads each turn's kind from its cursor's inbound, and gives scheduled and pipeline turns rows", async () => {
    const conv = await seedConversation();
    const scheduled = await turn(conv, { cursor: await inbound(conv, "scheduled") });
    const pipeline = await turn(conv, { cursor: await inbound(conv, "pipeline") });
    const chat = await turn(conv);
    await fire(conv, conv.count, { extracted: 1 });
    const unobserved = await seedConversation();
    const oldPipeline = await turn(unobserved, {
      cursor: await inbound(unobserved, "pipeline"),
      daysAgo: 40,
    });

    await migrate();

    expect(await memoriesRows()).toEqual(
      new Map([
        [scheduled, { kind: "scheduled", skipReason: "backfilled" }],
        [pipeline, { kind: "pipeline", skipReason: "backfilled" }],
        [chat, backfilled],
        [oldPipeline, { kind: "pipeline", skipReason: "aged_out" }],
      ]),
    );
  });

  it("leaves the corrections rows as they were", async () => {
    const conv = await seedConversation();
    const applied = await turn(conv);
    const retrying = await turn(conv);
    const failed = await turn(conv);
    const scheduled = await turn(conv, { cursor: await inbound(conv, "scheduled") });
    const read = await turn(conv);
    await fire(conv, conv.count, { extracted: 1 });
    // In 0081's shape, which has no extraction column.
    await db.execute(sql`
      INSERT INTO turn_observations
        (conversation_id, turn_cursor, turn_kind, phase, status, skip_reason, attempts,
          failure_kind, failure_message, updated_at)
      VALUES
        (${conv.id}, ${applied}, 'chat', 'corrections', 'applied', NULL, 0, NULL, NULL,
          now() - interval '1 day'),
        (${conv.id}, ${retrying}, 'chat', 'corrections', 'pending', NULL, 1, 'parse', 'bad json',
          now()),
        (${conv.id}, ${failed}, 'chat', 'corrections', 'failed', NULL, 3, 'exhausted', 'threw',
          now()),
        (${conv.id}, ${scheduled}, 'scheduled', 'corrections', 'skipped', 'not_user_speech', 0,
          NULL, NULL, now()),
        (${conv.id}, ${read}, 'chat', 'corrections', 'skipped', 'backfilled', 0, NULL, NULL,
          now())
    `);
    const before = await correctionsRows();

    await migrate();

    expect(before).toHaveLength(5);
    expect(await correctionsRows()).toEqual(before);
    const withExtraction = IdRowsSchema.parse(
      await db.execute(
        sql`SELECT id FROM turn_observations WHERE phase = 'corrections' AND extraction IS NOT NULL`,
      ),
    );
    expect(withExtraction.rows).toEqual([]);
    // The memories phase is backfilled beside them, on the same turns.
    expect(new Set((await memoriesRows()).keys())).toEqual(
      new Set([applied, retrying, failed, scheduled, read]),
    );
  });

  it("holds the migrated table to the memories phase's CHECK terms and plans from the wider index", async () => {
    await migrate();
    const conv = await seedConversation();
    const insert = (phase: string, status: string, extraction: string | null) =>
      db.execute(sql`
        INSERT INTO turn_observations
          (conversation_id, turn_cursor, turn_kind, phase, status, attempts, extraction, updated_at)
        VALUES (${conv.id}, ${randomUUID()}, 'chat', ${phase}::observation_phase,
          ${status}::observation_status, 0, ${extraction}::jsonb, now())
      `);
    const stored = JSON.stringify({ phase: "memories", items: [] });

    await expect(insert("memories", "extracted", null)).rejects.toMatchObject({
      cause: { code: "23514" },
    });
    await expect(insert("corrections", "held", null)).rejects.toMatchObject({
      cause: { code: "23514" },
    });
    await expect(insert("corrections", "applied", stored)).rejects.toMatchObject({
      cause: { code: "23514" },
    });
    await expect(insert("memories", "extracted", stored)).resolves.toBeDefined();

    const { rows } = IndexRowsSchema.parse(
      await db.execute(
        sql`SELECT indexname FROM pg_indexes WHERE tablename = 'turn_observations' ORDER BY indexname`,
      ),
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "idx_turn_observations_open",
      "turn_observations_pkey",
      "uq_turn_observations_turn_phase",
    ]);
  });
});
