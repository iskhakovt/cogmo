/**
 * `DrizzleTurnObservationStore`: discovery's anti-join, the plan's order, and
 * each guarded move, against PGlite. A memories row stores its extraction on
 * `pending → extracted` and keeps it in every later state. The CHECK refuses
 * the states no transition writes.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { seedConversation } from "../../test/agent-store-fixtures.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { inboundMessages } from "../../transport/store/schema.js";
import type { TurnExtraction } from "../evolution/observation/turn-extraction.js";
import { DrizzleConversationStore } from "./conversations.js";
import { messages, type ObservationPhaseValue, turnObservations } from "./schema.js";
import {
  DrizzleTurnObservationStore,
  type NewTurnObservation,
  type TurnObservationStore,
} from "./turn-observations.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleTurnObservationStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

type Conversation = Awaited<ReturnType<typeof seedConversation>>;

/** Rows on one cursor, written in order; the cursor is fresh unless given. */
async function seedTurn(
  conv: Conversation,
  roles: ReadonlyArray<"user" | "assistant">,
  cursor: string = randomUUID(),
): Promise<string> {
  for (const role of roles) {
    await db.insert(messages).values({
      conversationId: conv.conversationId,
      role,
      content: `${role} on ${cursor}`,
      ...conv.stamp,
      lastInboundMessageId: cursor,
      firstInboundMessageId: null,
      outputTokens: -1,
    });
  }
  return cursor;
}

/** A second conversation of `conv`'s user and profile. */
async function anotherConversation(conv: Conversation): Promise<string> {
  const created = await tx((trx) =>
    new DrizzleConversationStore().createConversation(trx, {
      userId: conv.userId,
      profileId: conv.profileId,
      isPrivate: true,
    }),
  );
  return created.id;
}

async function inbound(conv: Conversation, source: "scheduled" | "pipeline"): Promise<string> {
  const [row] = await db
    .insert(inboundMessages)
    .values({
      source,
      idempotencyKey: `${source}:${randomUUID()}`,
      conversationId: conv.conversationId,
      content: "a task prompt",
      platformTs: new Date(),
    })
    .returning({ id: inboundMessages.id });
  return expectDefined(row, "inbound").id;
}

const phase: ObservationPhaseValue = "corrections";

function pending(cursor: string): NewTurnObservation {
  return { cursor, kind: "chat", disposition: { status: "pending" } };
}

async function insert(conv: Conversation, turns: ReadonlyArray<NewTurnObservation>) {
  await tx((trx) =>
    store.insertTurnObservations(trx, { conversationId: conv.conversationId, phase, turns }),
  );
}

async function planned(conv: Conversation) {
  return tx((trx) => store.listOpenTurns(trx, { conversationId: conv.conversationId, phase }));
}

/** The DB error code a write rejects with. */
async function codeOf(write: Promise<unknown>): Promise<string | undefined> {
  return write.then(
    () => undefined,
    (e: { cause?: { code?: string } }) => e.cause?.code,
  );
}

const memories: ObservationPhaseValue = "memories";

/** A memories extraction of two facts under `conv`'s profile, by `runId`. */
function extraction(conv: Conversation, runId: string): TurnExtraction {
  return {
    phase: "memories",
    runId,
    profileId: conv.profileId,
    profileClass: "assistant",
    seesUserRules: false,
    items: [
      {
        fact: "The user lives in Lisbon",
        network: "world",
        compartment: "personal",
        trust: "any",
        evidence: "I live in Lisbon",
      },
      {
        fact: "The user prefers tea",
        network: "bank",
        compartment: "personal",
        trust: "first-party",
        context: "Said over breakfast",
        evidence: "I prefer tea",
      },
    ],
    dropped: { noEvidence: 1 },
  };
}

/** One answered turn of `conv` with a `pending` memories row. */
async function memoriesTurn(conv: Conversation): Promise<{ cursor: string; id: string }> {
  const cursor = await seedTurn(conv, ["user", "assistant"]);
  await tx((trx) =>
    store.insertTurnObservations(trx, {
      conversationId: conv.conversationId,
      phase: memories,
      turns: [pending(cursor)],
    }),
  );
  const [row] = await db
    .select({ id: turnObservations.id })
    .from(turnObservations)
    .where(and(eq(turnObservations.turnCursor, cursor), eq(turnObservations.phase, memories)));
  return { cursor, id: expectDefined(row, "memories row").id };
}

async function openMemories(conv: Conversation) {
  return tx((trx) =>
    store.listOpenTurns(trx, { conversationId: conv.conversationId, phase: memories }),
  );
}

async function storeExtraction(id: string, stored: TurnExtraction) {
  return tx((trx) =>
    store.transitionPendingTurn(trx, { id, to: { status: "extracted", extraction: stored } }),
  );
}

async function hold(id: string) {
  return tx((trx) => store.transitionPendingTurn(trx, { id, to: { status: "held" } }));
}

async function moveExtracted(id: string, to: "applied" | "held_extracted") {
  return tx((trx) => store.transitionExtractedTurn(trx, { id, to }));
}

/** A memories turn of `conv` moved to `held_extracted` with `stored`; its id. */
async function heldExtractedTurn(conv: Conversation, stored: TurnExtraction): Promise<string> {
  const { id } = await memoriesTurn(conv);
  await storeExtraction(id, stored);
  await moveExtracted(id, "held_extracted");
  return id;
}

async function releaseHeldExtracted(ids: ReadonlyArray<string>) {
  return tx((trx) => store.releaseHeldExtractedTurns(trx, { ids }));
}

async function attempt(params: Parameters<TurnObservationStore["recordTurnAttempt"]>[1]) {
  return tx((trx) => store.recordTurnAttempt(trx, params));
}

async function observation(id: string) {
  return tx((trx) => store.getTurnObservation(trx, id));
}

/** The row as stored, its extraction parsed. */
async function storedRow(id: string) {
  const [row] = await db.select().from(turnObservations).where(eq(turnObservations.id, id));
  return expectDefined(row, `row ${id}`);
}

async function statusesOf(ids: ReadonlyArray<string>) {
  return Promise.all(ids.map(async (id) => (await storedRow(id)).status));
}

describe("DrizzleTurnObservationStore", () => {
  describe("listUndiscoveredTurns", () => {
    it("lists the answered turns without a row, with the kind their inbound gives", async () => {
      const conv = await seedConversation(tx);
      const chat = await seedTurn(conv, ["user", "assistant"]);
      const scheduled = await seedTurn(
        conv,
        ["user", "assistant"],
        await inbound(conv, "scheduled"),
      );
      const pipeline = await seedTurn(conv, ["user", "assistant"], await inbound(conv, "pipeline"));
      await seedTurn(conv, ["user"]);
      const observed = await seedTurn(conv, ["user", "assistant", "assistant"]);
      await insert(conv, [pending(observed)]);
      const other = { ...conv, conversationId: await anotherConversation(conv) };
      await seedTurn(other, ["user", "assistant"]);

      const found = await tx((trx) =>
        store.listUndiscoveredTurns(trx, { conversationId: conv.conversationId, phase }),
      );

      expect(new Map(found.map((t) => [t.cursor, t.kind]))).toEqual(
        new Map([
          [chat, "chat"],
          [scheduled, "scheduled"],
          [pipeline, "pipeline"],
        ]),
      );
    });

    it("finds a turn whose reply committed after an earlier fire's discovery", async () => {
      const conv = await seedConversation(tx);
      const late = await seedTurn(conv, ["user"]);
      await seedTurn(conv, ["user", "assistant"]);
      const first = await tx((trx) =>
        store.listUndiscoveredTurns(trx, { conversationId: conv.conversationId, phase }),
      );
      await insert(
        conv,
        first.map((t) => pending(t.cursor)),
      );
      await seedTurn(conv, ["assistant"], late);

      const second = await tx((trx) =>
        store.listUndiscoveredTurns(trx, { conversationId: conv.conversationId, phase }),
      );

      expect(second.map((t) => t.cursor)).toEqual([late]);
    });
  });

  describe("insertTurnObservations", () => {
    it("leaves a row that exists as it is", async () => {
      const conv = await seedConversation(tx);
      const cursor = await seedTurn(conv, ["user", "assistant"]);
      await insert(conv, [pending(cursor)]);
      const [turn] = await planned(conv);
      const id = expectDefined(turn, "planned turn").observationId;
      await tx((trx) => store.transitionPendingTurn(trx, { id, to: { status: "applied" } }));

      await insert(conv, [pending(cursor)]);

      const rows = await db.select().from(turnObservations);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, status: "applied", attempts: 0 });
    });

    it("writes a skip with its reason", async () => {
      const conv = await seedConversation(tx);
      const cursor = await seedTurn(conv, ["user", "assistant"], await inbound(conv, "scheduled"));

      await insert(conv, [
        {
          cursor,
          kind: "scheduled",
          disposition: { status: "skipped", reason: "not_user_speech" },
        },
      ]);

      const [row] = await db.select().from(turnObservations);
      expect(row).toMatchObject({ status: "skipped", skipReason: "not_user_speech" });
      expect(await planned(conv)).toEqual([]);
    });
  });

  describe("listOpenTurns", () => {
    it("lists pending turns by their first row, whatever order their cursors sort in", async () => {
      const conv = await seedConversation(tx);
      // Cursors that sort the other way from the rows.
      const later = "01900000-0000-7000-8000-000000000001";
      const earlier = "01900000-0000-7000-8000-000000000002";
      await seedTurn(conv, ["user", "assistant"], earlier);
      await seedTurn(conv, ["user", "assistant"], later);
      const done = await seedTurn(conv, ["user", "assistant"]);
      await insert(conv, [pending(later), pending(earlier), pending(done)]);
      const all = await planned(conv);
      const doneId = expectDefined(
        all.find((t) => t.cursor === done),
        "done turn",
      ).observationId;
      await tx((trx) =>
        store.transitionPendingTurn(trx, { id: doneId, to: { status: "applied" } }),
      );
      const laterId = expectDefined(
        all.find((t) => t.cursor === later),
        "later turn",
      ).observationId;
      await tx((trx) =>
        store.recordTurnAttempt(trx, {
          id: laterId,
          from: "pending",
          seen: 0,
          failure: { kind: "parse", message: "bad json" },
          giveUp: false,
        }),
      );

      const turns = await planned(conv);

      expect(turns.map((t) => [t.cursor, t.attempts])).toEqual([
        [earlier, 0],
        [later, 1],
      ]);
      const [firstRow] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.lastInboundMessageId, earlier))
        .orderBy(messages.id)
        .limit(1);
      expect(turns[0]?.firstMessageId).toBe(expectDefined(firstRow, "first row").id);
    });

    it("lists extracted turns between pending ones in turn order, each with its status, and no held ones", async () => {
      const conv = await seedConversation(tx);
      const first = await memoriesTurn(conv);
      const extracted = await memoriesTurn(conv);
      const held = await memoriesTurn(conv);
      const heldExtracted = await memoriesTurn(conv);
      const applied = await memoriesTurn(conv);
      const last = await memoriesTurn(conv);
      await storeExtraction(extracted.id, extraction(conv, "run-1"));
      await hold(held.id);
      await storeExtraction(heldExtracted.id, extraction(conv, "run-1"));
      await moveExtracted(heldExtracted.id, "held_extracted");
      await storeExtraction(applied.id, extraction(conv, "run-1"));
      await moveExtracted(applied.id, "applied");
      // The held turn's corrections row is the other phase's plan.
      await insert(conv, [pending(held.cursor)]);

      const turns = await openMemories(conv);

      expect(turns.map((t) => [t.observationId, t.status, t.attempts])).toEqual([
        [first.id, "pending", 0],
        [extracted.id, "extracted", 0],
        [last.id, "pending", 0],
      ]);
      expect((await planned(conv)).map((t) => [t.cursor, t.status])).toEqual([
        [held.cursor, "pending"],
      ]);
    });
  });

  describe("transitions", () => {
    async function pendingTurn(): Promise<string> {
      const conv = await seedConversation(tx);
      const cursor = await seedTurn(conv, ["user", "assistant"]);
      await insert(conv, [pending(cursor)]);
      return expectDefined((await planned(conv))[0], "pending turn").observationId;
    }

    it("moves a pending row once, and reports the status it found to a second move", async () => {
      const id = await pendingTurn();

      expect(
        await tx((trx) => store.transitionPendingTurn(trx, { id, to: { status: "applied" } })),
      ).toEqual({ kind: "transitioned" });
      expect(
        await tx((trx) =>
          store.transitionPendingTurn(trx, { id, to: { status: "skipped", reason: "empty" } }),
        ),
      ).toEqual({ kind: "stale", status: "applied" });
    });

    it("records an attempt against the count it read, and refuses a stale count", async () => {
      const id = await pendingTurn();
      const failure = { kind: "parse" as const, message: "bad json" };

      expect(await attempt({ id, from: "pending", seen: 0, failure, giveUp: false })).toEqual({
        kind: "transitioned",
      });
      expect(await attempt({ id, from: "pending", seen: 0, failure, giveUp: true })).toEqual({
        kind: "stale",
        status: "pending",
      });
      expect(await attempt({ id, from: "pending", seen: 1, failure, giveUp: true })).toEqual({
        kind: "transitioned",
      });

      expect(await tx((trx) => store.getTurnObservation(trx, id))).toMatchObject({
        status: "failed",
        attempts: 2,
      });
      const [row] = await db.select().from(turnObservations);
      expect(row).toMatchObject({ failureKind: "parse", failureMessage: "bad json" });
    });

    it("leaves a terminal row terminal", async () => {
      const id = await pendingTurn();
      await tx((trx) => store.transitionPendingTurn(trx, { id, to: { status: "applied" } }));

      expect(
        await attempt({
          id,
          from: "pending",
          seen: 0,
          failure: { kind: "refusal", message: "no" },
          giveUp: true,
        }),
      ).toEqual({ kind: "stale", status: "applied" });
    });
  });

  describe("memories transitions", () => {
    let conv: Conversation;
    beforeEach(async () => {
      conv = await seedConversation(tx);
    });

    it("stores an extraction once, by pending → extracted, and reads it back with the row", async () => {
      const { id } = await memoriesTurn(conv);
      const first = extraction(conv, "run-1");

      expect(await storeExtraction(id, first)).toEqual({ kind: "transitioned" });
      // Another run's extraction of the same turn finds it extracted and writes nothing.
      expect(await storeExtraction(id, extraction(conv, "run-2"))).toEqual({
        kind: "stale",
        status: "extracted",
      });

      expect(await observation(id)).toEqual({
        status: "extracted",
        attempts: 0,
        extraction: first,
      });
    });

    it("keeps the extraction through held_extracted, its release, and applied", async () => {
      const { id } = await memoriesTurn(conv);
      const stored = extraction(conv, "run-1");
      await storeExtraction(id, stored);

      expect(await moveExtracted(id, "held_extracted")).toEqual({ kind: "transitioned" });
      expect(await observation(id)).toEqual({
        status: "held_extracted",
        attempts: 0,
        extraction: stored,
      });
      expect(await releaseHeldExtracted([id])).toBe(1);
      expect(await observation(id)).toEqual({
        status: "extracted",
        attempts: 0,
        extraction: stored,
      });
      expect(await moveExtracted(id, "applied")).toEqual({ kind: "transitioned" });

      expect(await observation(id)).toEqual({ status: "applied", attempts: 0 });
      expect(await storedRow(id)).toMatchObject({ status: "applied", extraction: stored });
    });

    it("moves an extracted row once, and reports the status it found to any other move", async () => {
      const unextracted = await memoriesTurn(conv);
      const { id } = await memoriesTurn(conv);
      await storeExtraction(id, extraction(conv, "run-1"));

      expect(await moveExtracted(unextracted.id, "applied")).toEqual({
        kind: "stale",
        status: "pending",
      });
      expect(await moveExtracted(id, "applied")).toEqual({ kind: "transitioned" });
      expect(await moveExtracted(id, "held_extracted")).toEqual({
        kind: "stale",
        status: "applied",
      });
    });

    it("holds a pending row, which then takes no extraction", async () => {
      const { id } = await memoriesTurn(conv);

      expect(await hold(id)).toEqual({ kind: "transitioned" });
      expect(await storeExtraction(id, extraction(conv, "run-1"))).toEqual({
        kind: "stale",
        status: "held",
      });

      expect(await observation(id)).toEqual({ status: "held", attempts: 0 });
      expect((await storedRow(id)).extraction).toBeNull();
    });
  });

  describe("releaseHeldTurns", () => {
    it("moves only the conversation's held memories rows to pending, keeping their counts", async () => {
      const conv = await seedConversation(tx);
      const counted = await memoriesTurn(conv);
      const held = await memoriesTurn(conv);
      const heldExtracted = await memoriesTurn(conv);
      const open = await memoriesTurn(conv);
      const other = { ...conv, conversationId: await anotherConversation(conv) };
      const elsewhere = await memoriesTurn(other);
      const failure = { kind: "parse" as const, message: "bad json" };
      await attempt({ id: counted.id, from: "pending", seen: 0, failure, giveUp: false });
      await hold(counted.id);
      await hold(held.id);
      await hold(elsewhere.id);
      await storeExtraction(heldExtracted.id, extraction(conv, "run-1"));
      await moveExtracted(heldExtracted.id, "held_extracted");

      expect(
        await tx((trx) => store.releaseHeldTurns(trx, { conversationId: conv.conversationId })),
      ).toBe(2);

      expect(
        await statusesOf([counted.id, held.id, heldExtracted.id, open.id, elsewhere.id]),
      ).toEqual(["pending", "pending", "held_extracted", "pending", "held"]);
      expect(await storedRow(counted.id)).toMatchObject({
        attempts: 1,
        failureKind: "parse",
        failureMessage: "bad json",
      });
      expect(
        await tx((trx) => store.releaseHeldTurns(trx, { conversationId: conv.conversationId })),
      ).toBe(0);
    });
  });

  describe("listHeldExtractedTurns", () => {
    it("lists the conversation's held_extracted rows with their extractions", async () => {
      const conv = await seedConversation(tx);
      const stored = extraction(conv, "run-1");
      const heldExtracted = await heldExtractedTurn(conv, stored);
      const extracted = await memoriesTurn(conv);
      await storeExtraction(extracted.id, extraction(conv, "run-2"));
      const held = await memoriesTurn(conv);
      await hold(held.id);
      const other = { ...conv, conversationId: await anotherConversation(conv) };
      await heldExtractedTurn(other, extraction(other, "run-3"));

      expect(
        await tx((trx) =>
          store.listHeldExtractedTurns(trx, { conversationId: conv.conversationId }),
        ),
      ).toEqual([{ id: heldExtracted, extraction: stored }]);
    });
  });

  describe("releaseHeldExtractedTurns", () => {
    it("moves only the given rows that are still held_extracted", async () => {
      const conv = await seedConversation(tx);
      const released = await heldExtractedTurn(conv, extraction(conv, "run-1"));
      const taken = await heldExtractedTurn(conv, extraction(conv, "run-2"));
      const unlisted = await heldExtractedTurn(conv, extraction(conv, "run-3"));
      // Another run released and applied `taken` after this one listed it.
      await releaseHeldExtracted([taken]);
      await moveExtracted(taken, "applied");

      expect(await releaseHeldExtracted([released, taken])).toBe(1);

      expect(await statusesOf([released, taken, unlisted])).toEqual([
        "extracted",
        "applied",
        "held_extracted",
      ]);
      expect(await releaseHeldExtracted([])).toBe(0);
    });
  });

  describe("recordTurnAttempt on a memories row", () => {
    let conv: Conversation;
    beforeEach(async () => {
      conv = await seedConversation(tx);
    });
    const failure = { kind: "exhausted" as const, message: "retain step threw" };

    it("records an attempt on an extracted row from `extracted`, which stays planned", async () => {
      const { id } = await memoriesTurn(conv);
      const stored = extraction(conv, "run-1");
      await storeExtraction(id, stored);

      expect(await attempt({ id, from: "extracted", seen: 0, failure, giveUp: false })).toEqual({
        kind: "transitioned",
      });

      expect(await observation(id)).toEqual({
        status: "extracted",
        attempts: 1,
        extraction: stored,
      });
      expect(
        (await openMemories(conv)).map((t) => [t.observationId, t.status, t.attempts]),
      ).toEqual([[id, "extracted", 1]]);
    });

    it("gives an extracted row up as failed, leaving its extraction in place", async () => {
      const { id } = await memoriesTurn(conv);
      const stored = extraction(conv, "run-1");
      await storeExtraction(id, stored);

      expect(await attempt({ id, from: "extracted", seen: 0, failure, giveUp: true })).toEqual({
        kind: "transitioned",
      });

      expect(await storedRow(id)).toMatchObject({
        status: "failed",
        attempts: 1,
        failureKind: "exhausted",
        failureMessage: "retain step threw",
        extraction: stored,
      });
    });

    it("counts nothing on a row that left the status the plan read, at the same count", async () => {
      // The plan read each row `pending` at 0; another run then extracted or held it.
      const extracted = await memoriesTurn(conv);
      const held = await memoriesTurn(conv);
      const stored = extraction(conv, "run-1");
      await storeExtraction(extracted.id, stored);
      await hold(held.id);
      // And a plan that read `extracted` finds a row still `pending`.
      const unextracted = await memoriesTurn(conv);

      expect(
        await attempt({ id: extracted.id, from: "pending", seen: 0, failure, giveUp: true }),
      ).toEqual({ kind: "stale", status: "extracted" });
      expect(
        await attempt({ id: held.id, from: "pending", seen: 0, failure, giveUp: false }),
      ).toEqual({ kind: "stale", status: "held" });
      expect(
        await attempt({ id: unextracted.id, from: "extracted", seen: 0, failure, giveUp: false }),
      ).toEqual({ kind: "stale", status: "pending" });

      expect(await observation(extracted.id)).toEqual({
        status: "extracted",
        attempts: 0,
        extraction: stored,
      });
      for (const id of [extracted.id, held.id, unextracted.id]) {
        expect(await storedRow(id)).toMatchObject({
          attempts: 0,
          failureKind: null,
          failureMessage: null,
        });
      }
    });
  });

  describe("chk_turn_observations_state", () => {
    let conv: Conversation;
    beforeEach(async () => {
      conv = await seedConversation(tx);
    });

    async function row(
      values: Partial<typeof turnObservations.$inferInsert>,
    ): Promise<string | undefined> {
      return codeOf(
        db.insert(turnObservations).values({
          conversationId: conv.conversationId,
          turnCursor: randomUUID(),
          turnKind: "chat",
          phase,
          status: "pending",
          attempts: 0,
          updatedAt: sql`now()`,
          ...values,
        }),
      );
    }

    it("refuses a skip without a reason, and a reason on any other status", async () => {
      expect(await row({ status: "skipped" })).toBe("23514");
      expect(await row({ status: "applied", skipReason: "empty" })).toBe("23514");
    });

    it("refuses a failure without an attempt, and an attempt without its failure", async () => {
      expect(await row({ status: "failed" })).toBe("23514");
      expect(await row({ attempts: 1 })).toBe("23514");
      expect(await row({ attempts: 1, failureKind: "parse" })).toBe("23514");
    });

    it("refuses `not_user_speech` on a chat turn", async () => {
      expect(await row({ status: "skipped", skipReason: "not_user_speech" })).toBe("23514");
      expect(
        await row({ status: "skipped", skipReason: "not_user_speech", turnKind: "scheduled" }),
      ).toBeUndefined();
    });

    it("refuses `held`, `held_extracted` and `extracted` on a corrections row", async () => {
      const stored = extraction(conv, "run-1");

      expect(await row({ status: "held" })).toBe("23514");
      expect(await row({ status: "held_extracted" })).toBe("23514");
      expect(await row({ status: "extracted" })).toBe("23514");
      expect(await row({ phase: memories, status: "held" })).toBeUndefined();
      expect(
        await row({ phase: memories, status: "held_extracted", extraction: stored }),
      ).toBeUndefined();
      expect(
        await row({ phase: memories, status: "extracted", extraction: stored }),
      ).toBeUndefined();
    });

    it("refuses an extraction on a corrections row", async () => {
      const stored = extraction(conv, "run-1");
      const failed: Partial<typeof turnObservations.$inferInsert> = {
        status: "failed",
        attempts: 1,
        failureKind: "parse",
        failureMessage: "x",
        extraction: stored,
      };

      expect(await row({ status: "applied", extraction: stored })).toBe("23514");
      expect(await row(failed)).toBe("23514");
      expect(await row({ phase: memories, status: "applied", extraction: stored })).toBeUndefined();
      expect(await row({ ...failed, phase: memories })).toBeUndefined();
    });

    it("refuses an extraction on a pending, held or skipped row", async () => {
      const stored = extraction(conv, "run-1");

      expect(await row({ phase: memories, status: "pending", extraction: stored })).toBe("23514");
      expect(await row({ phase: memories, status: "held", extraction: stored })).toBe("23514");
      expect(
        await row({ phase: memories, status: "skipped", skipReason: "empty", extraction: stored }),
      ).toBe("23514");
    });

    it("refuses a memories extracted, held_extracted or applied row without an extraction", async () => {
      expect(await row({ phase: memories, status: "extracted" })).toBe("23514");
      expect(await row({ phase: memories, status: "held_extracted" })).toBe("23514");
      expect(await row({ phase: memories, status: "applied" })).toBe("23514");
      // A stored extraction can't be cleared.
      const { id } = await memoriesTurn(conv);
      await storeExtraction(id, extraction(conv, "run-1"));
      expect(
        await codeOf(
          db.execute(sql`UPDATE turn_observations SET extraction = NULL WHERE id = ${id}`),
        ),
      ).toBe("23514");
      // A corrections row is applied with none, and a failed memories row may have none.
      expect(await row({ status: "applied" })).toBeUndefined();
      expect(
        await row({
          phase: memories,
          status: "failed",
          attempts: 1,
          failureKind: "parse",
          failureMessage: "x",
        }),
      ).toBeUndefined();
    });

    it("refuses `not_user_speech` on a memories row", async () => {
      expect(
        await row({
          phase: memories,
          status: "skipped",
          skipReason: "not_user_speech",
          turnKind: "scheduled",
        }),
      ).toBe("23514");
      expect(
        await row({
          phase: memories,
          status: "skipped",
          skipReason: "empty",
          turnKind: "scheduled",
        }),
      ).toBeUndefined();
    });

    it("refuses a second row for one turn and phase", async () => {
      const cursor = randomUUID();
      const values = {
        conversationId: conv.conversationId,
        turnCursor: cursor,
        turnKind: "chat" as const,
        phase,
        status: "pending" as const,
        attempts: 0,
        updatedAt: sql`now()`,
      };
      await db.insert(turnObservations).values(values);

      expect(await codeOf(db.insert(turnObservations).values(values))).toBe("23505");
    });
  });
});
