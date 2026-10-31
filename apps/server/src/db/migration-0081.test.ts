/**
 * The `turn_observations` migration creates the Observer's per-turn rows and
 * `steering_rules.contradicted_in_turn_id`, and starts each conversation's
 * corrections cursor where the transcript-era Observer stopped, in one
 * transaction: every answered turn at or below the boundary of the latest
 * fire whose correction extraction returned is `skipped` (`backfilled`), any
 * other answered turn older than 30 days is `skipped` (`aged_out`), and every
 * other turn gets no row. A contradiction record moves from its conversation
 * to that conversation's newest backfilled turn, and the conversation column
 * is cleared. Runs the file's SQL against PGlite over rows in the
 * pre-migration shape (the table, the enums and the new column dropped, the
 * 0078 CHECK restored) and asserts where each turn and record lands.
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

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0081_turn_observations.sql", import.meta.url)),
  "utf8",
);
const STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const ObservationRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      turn_cursor: z.string(),
      turn_kind: z.string(),
      status: z.string(),
      skip_reason: z.string().nullable(),
    }),
  ),
});
const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const MarkerRowsSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      contradicted_in_turn_id: z.string().nullable(),
      contradicted_in_conversation_id: z.string().nullable(),
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

/** One turn's rows on a fresh cursor, `daysAgo` old; a turn with no reply is unanswered. */
async function turn(
  conv: Conversation,
  opts: { answered?: boolean; daysAgo?: number; cursor?: string } = {},
): Promise<string> {
  const cursor = opts.cursor ?? randomUUID();
  const createdAt = new Date(Date.now() - (opts.daysAgo ?? 0) * DAY_MS);
  const roles = opts.answered === false ? (["user"] as const) : (["user", "assistant"] as const);
  for (const role of roles) {
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
  return cursor;
}

const COUNTS = {
  extracted: 0,
  reinforced: 0,
  contradictions: 0,
  promoted: 0,
  outOfScopeReinforcementsSkipped: 0,
  unknownRuleReinforcementsSkipped: 0,
  consolidationNeeded: false,
};

/** A transcript-era fire that read the first `messageCount` messages. */
async function fire(
  conv: Conversation,
  messageCount: number,
  opts: { failedPhases?: Array<"corrections" | "memories">; reinforced?: number } = {},
): Promise<void> {
  await db.insert(evolutionEvents).values({
    conversationId: conv.id,
    userId: conv.userId,
    triggeredBy: "idle",
    payload: {
      corrections: {
        ...COUNTS,
        reinforced: opts.reinforced ?? 0,
        retired: 0,
        reset: 0,
        outOfScopeContradictionsSkipped: 0,
      },
      consolidation: null,
      memories: { extracted: 0, byNetwork: {}, skippedForUnseenRules: 0 },
      drained: { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty: 0 },
      messageCount,
      profileId: conv.profileId,
      ...(opts.failedPhases !== undefined && { failedPhases: opts.failedPhases }),
    },
  });
}

/** Each corrections row after the migration, by turn cursor. */
async function rowsByCursor(): Promise<Map<string, { kind: string; skipReason: string | null }>> {
  const { rows } = ObservationRowsSchema.parse(
    await db.execute(sql`
      SELECT id, turn_cursor, turn_kind::text AS turn_kind, status::text AS status,
        skip_reason::text AS skip_reason
      FROM turn_observations
    `),
  );
  for (const r of rows) expect(r.status).toBe("skipped");
  return new Map(
    rows.map((r) => [r.turn_cursor, { kind: r.turn_kind, skipReason: r.skip_reason }]),
  );
}

describe("migration turn_observations", () => {
  it("backfills the turns the latest qualifying fire read, and leaves the rest to discovery", async () => {
    const conv = await seedConversation();
    const read1 = await turn(conv);
    const lost = await turn(conv, { answered: false });
    const read2 = await turn(conv);
    await fire(conv, conv.count, { failedPhases: [] });
    // A fire landing between a turn row and its reply: the turn straddles it.
    const straddling = randomUUID();
    await turn(conv, { answered: false, cursor: straddling });
    await fire(conv, conv.count, { failedPhases: [] });
    await db.insert(messages).values({
      conversationId: conv.id,
      role: "assistant",
      content: "late",
      profileId: conv.profileId,
      model: "m",
      lastInboundMessageId: straddling,
      firstInboundMessageId: null,
      outputTokens: -1,
    });
    const unread = await turn(conv);

    await applyMigration();

    expect(await rowsByCursor()).toEqual(
      new Map([
        [read1, { kind: "chat", skipReason: "backfilled" }],
        [read2, { kind: "chat", skipReason: "backfilled" }],
      ]),
    );
    const undiscovered = await tx((trx) =>
      new DrizzleTurnObservationStore().listUndiscoveredTurns(trx, {
        conversationId: conv.id,
        phase: "corrections",
      }),
    );
    expect(new Set(undiscovered.map((t) => t.cursor))).toEqual(new Set([straddling, unread]));
    expect(undiscovered.map((t) => t.cursor)).not.toContain(lost);
  });

  it("takes a boundary only from a fire whose correction extraction returned", async () => {
    const failedAfter = await seedConversation();
    const kept = await turn(failedAfter);
    await turn(failedAfter);
    await fire(failedAfter, 2, { failedPhases: [] });
    await fire(failedAfter, failedAfter.count, { failedPhases: ["corrections"] });
    const unknown = await seedConversation();
    await turn(unknown);
    await turn(unknown);
    // Written before `failedPhases` existed, with nothing found: unknown.
    await fire(unknown, unknown.count);
    const counted = await seedConversation();
    const proven = await turn(counted);
    await fire(counted, counted.count, { reinforced: 1 });
    const overcounted = await seedConversation();
    await turn(overcounted);
    await fire(overcounted, overcounted.count + 5, { failedPhases: [] });

    await applyMigration();

    expect([...(await rowsByCursor()).keys()].sort()).toEqual([kept, proven].sort());
  });

  it("ages out an answered turn over 30 days old that no fire read", async () => {
    const conv = await seedConversation();
    const old = await turn(conv, { daysAgo: 40 });
    const oldUnanswered = await turn(conv, { daysAgo: 40, answered: false });
    const recent = await turn(conv, { daysAgo: 29 });

    await applyMigration();

    const rows = await rowsByCursor();
    expect(rows.get(old)).toEqual({ kind: "chat", skipReason: "aged_out" });
    expect(rows.has(oldUnanswered)).toBe(false);
    expect(rows.has(recent)).toBe(false);
  });

  it("reads each backfilled turn's kind from its inbound", async () => {
    const conv = await seedConversation();
    const [scheduled] = await db
      .insert(inboundMessages)
      .values({
        source: "scheduled",
        idempotencyKey: `task:${randomUUID()}`,
        conversationId: conv.id,
        content: "briefing",
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });
    const cursor = await turn(conv, { cursor: expectDefined(scheduled, "inbound").id });
    await fire(conv, conv.count, { failedPhases: [] });

    await applyMigration();

    expect((await rowsByCursor()).get(cursor)).toEqual({
      kind: "scheduled",
      skipReason: "backfilled",
    });
  });

  it("moves each contradiction record to its conversation's newest backfilled turn", async () => {
    const conv = await seedConversation();
    await turn(conv);
    const newest = await turn(conv);
    await fire(conv, conv.count, { failedPhases: [] });
    const unread = await seedConversation();
    await turn(unread);
    // In the pre-migration shape, which has no turn column.
    const rule = async (status: "learning" | "retired", contradictedIn: string) => {
      const retired = status === "retired";
      const { rows } = IdRowsSchema.parse(
        await db.execute(sql`
          INSERT INTO steering_rules
            (rule, category, status, source, priority, observation_count, retracted_at,
              retired_reason, contradicted_in_conversation_id)
          VALUES (${`rule ${randomUUID()}`}, 'style', ${status}, 'correction', 100, 0,
            ${retired ? sql`now()` : null}, ${retired ? "contradicted" : null}, ${contradictedIn})
          RETURNING id
        `),
      );
      return expectDefined(rows[0], "rule").id;
    };
    const reset = await rule("learning", conv.id);
    const retired = await rule("retired", conv.id);
    const noTurn = await rule("learning", unread.id);

    await applyMigration();

    const { rows: observations } = ObservationRowsSchema.parse(
      await db.execute(sql`
        SELECT id, turn_cursor, turn_kind::text AS turn_kind, status::text AS status,
          skip_reason::text AS skip_reason
        FROM turn_observations
      `),
    );
    const newestId = expectDefined(
      observations.find((o) => o.turn_cursor === newest),
      "newest turn",
    ).id;
    const { rows } = MarkerRowsSchema.parse(
      await db.execute(sql`
        SELECT id, contradicted_in_turn_id, contradicted_in_conversation_id FROM steering_rules
      `),
    );
    const markers = new Map(rows.map((r) => [r.id, r]));
    expect(markers.get(reset)?.contradicted_in_turn_id).toBe(newestId);
    expect(markers.get(retired)?.contradicted_in_turn_id).toBe(newestId);
    expect(markers.get(noTurn)?.contradicted_in_turn_id).toBeNull();
    expect(rows.every((r) => r.contradicted_in_conversation_id === null)).toBe(true);
  });

  it("holds a contradiction record to a learning or retired rule after the migration", async () => {
    await applyMigration();
    const conv = await seedConversation();
    const {
      rows: [observation],
    } = IdRowsSchema.parse(
      await db.execute(sql`
        INSERT INTO turn_observations
          (conversation_id, turn_cursor, turn_kind, phase, status, attempts, updated_at)
        VALUES (${conv.id}, ${randomUUID()}, 'chat', 'corrections', 'applied', 0, now())
        RETURNING id
      `),
    );

    await expect(
      db.execute(sql`
        INSERT INTO steering_rules
          (rule, category, status, source, priority, observation_count, contradicted_in_turn_id)
        VALUES ('Live, marked', 'style', 'live', 'correction', 100, 2,
          ${expectDefined(observation, "observation").id})
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
