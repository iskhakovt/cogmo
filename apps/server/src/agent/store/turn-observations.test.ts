/**
 * `DrizzleTurnObservationStore`: discovery's anti-join, the plan's order, and
 * each guarded move out of `pending`, against PGlite. The CHECK refuses the
 * states no transition writes.
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { seedConversation } from "../../test/agent-store-fixtures.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { inboundMessages } from "../../transport/store/schema.js";
import { DrizzleConversationStore } from "./conversations.js";
import { messages, type ObservationPhaseValue, turnObservations } from "./schema.js";
import { DrizzleTurnObservationStore, type NewTurnObservation } from "./turn-observations.js";

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
  return tx((trx) => store.listPendingTurns(trx, { conversationId: conv.conversationId, phase }));
}

/** The DB error code a write rejects with. */
async function codeOf(write: Promise<unknown>): Promise<string | undefined> {
  return write.then(
    () => undefined,
    (e: { cause?: { code?: string } }) => e.cause?.code,
  );
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

  describe("listPendingTurns", () => {
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
          seen: 0,
          failure: { kind: "parse", message: "bad json" },
          to: "pending",
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

      expect(
        await tx((trx) => store.recordTurnAttempt(trx, { id, seen: 0, failure, to: "pending" })),
      ).toEqual({ kind: "transitioned" });
      expect(
        await tx((trx) => store.recordTurnAttempt(trx, { id, seen: 0, failure, to: "failed" })),
      ).toEqual({ kind: "stale", status: "pending" });
      expect(
        await tx((trx) => store.recordTurnAttempt(trx, { id, seen: 1, failure, to: "failed" })),
      ).toEqual({ kind: "transitioned" });

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
        await tx((trx) =>
          store.recordTurnAttempt(trx, {
            id,
            seen: 0,
            failure: { kind: "refusal", message: "no" },
            to: "failed",
          }),
        ),
      ).toEqual({ kind: "stale", status: "applied" });
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
