import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { seedConversation, seedUser } from "../../test/agent-store-fixtures.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleConversationStore } from "./conversations.js";
import { DrizzleEvolutionEventStore } from "./evolution-events.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleEvolutionEventStore();
const conversationStore = new DrizzleConversationStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleEvolutionEventStore", () => {
  describe("evolution events", () => {
    function samplePayload() {
      return {
        corrections: {
          extracted: 1,
          reinforced: 2,
          contradictions: 0,
          retired: 0,
          reset: 0,
          promoted: 1,
          outOfScopeReinforcementsSkipped: 0,
          outOfScopeContradictionsSkipped: 0,
          unknownRuleReinforcementsSkipped: 0,
          consolidationNeeded: false,
        },
        consolidation: null,
        memories: { extracted: 3, byNetwork: { world: 1, bank: 2 }, skippedForUnseenRules: 0 },
        drained: { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty: 0 },
        messageCount: 12,
        profileId: "11111111-1111-7111-8111-111111111111",
      };
    }

    it("reads a row without retirement, withholding or deferral counts as 0 of each", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      const {
        retired: _retired,
        reset: _reset,
        outOfScopeContradictionsSkipped: _outOfScope,
        ...corrections
      } = samplePayload().corrections;
      const { skippedForUnseenRules: _skipped, ...memories } = samplePayload().memories;
      const {
        withheld: _withheld,
        deferredToFirstParty: _deferred,
        ...drained
      } = samplePayload().drained;
      const payload = { ...samplePayload(), corrections, memories, drained };
      await db.execute(sql`
        INSERT INTO evolution_events (conversation_id, user_id, triggered_by, payload)
        VALUES (${conversationId}, ${userId}, 'idle', ${JSON.stringify(payload)}::jsonb)
      `);

      const [row] = await tx((trx) => store.listEvolutionEvents(trx, userId));
      const read = expectDefined(row, "older row").payload;
      expect(read.corrections.retired).toBe(0);
      expect(read.corrections.reset).toBe(0);
      expect(read.corrections.outOfScopeContradictionsSkipped).toBe(0);
      expect(read.memories.skippedForUnseenRules).toBe(0);
      expect(read.drained.withheld).toBe(0);
      expect(read.drained.deferredToFirstParty).toBe(0);
    });

    it("records and lists events newest-first per user", async () => {
      const { userId, conversationId } = await seedConversation(tx);

      const first = await tx((trx) =>
        store.recordEvolutionEvent(trx, {
          conversationId,
          userId,
          triggeredBy: "idle",
          payload: samplePayload(),
        }),
      );
      const second = await tx((trx) =>
        store.recordEvolutionEvent(trx, {
          conversationId,
          userId,
          triggeredBy: "manual",
          payload: samplePayload(),
        }),
      );

      const events = await tx((trx) => store.listEvolutionEvents(trx, userId));
      expect(events.map((e) => e.id)).toEqual([second.id, first.id]);
      expect(events[0]?.triggeredBy).toBe("manual");
      expect(events[0]?.payload.memories.extracted).toBe(3);
    });

    it("listEvolutionEvents respects limit", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      for (let i = 0; i < 5; i++) {
        await tx((trx) =>
          store.recordEvolutionEvent(trx, {
            conversationId,
            userId,
            triggeredBy: "idle",
            payload: samplePayload(),
          }),
        );
      }
      const events = await tx((trx) => store.listEvolutionEvents(trx, userId, { limit: 2 }));
      expect(events).toHaveLength(2);
    });

    it("listEvolutionEvents scopes to the requesting user", async () => {
      const a = await seedConversation(tx);
      const otherUserId = await seedUser(tx);
      const otherConv = (
        await tx((trx) =>
          conversationStore.createConversation(trx, {
            userId: otherUserId,
            profileId: a.profileId,
            isPrivate: true,
          }),
        )
      ).id;
      await tx((trx) =>
        store.recordEvolutionEvent(trx, {
          conversationId: a.conversationId,
          userId: a.userId,
          triggeredBy: "idle",
          payload: samplePayload(),
        }),
      );
      await tx((trx) =>
        store.recordEvolutionEvent(trx, {
          conversationId: otherConv,
          userId: otherUserId,
          triggeredBy: "idle",
          payload: samplePayload(),
        }),
      );
      const aEvents = await tx((trx) => store.listEvolutionEvents(trx, a.userId));
      expect(aEvents).toHaveLength(1);
      expect(aEvents[0]?.userId).toBe(a.userId);
    });

    it("getEvolutionEvent returns the row when it belongs to the user", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      const { id } = await tx((trx) =>
        store.recordEvolutionEvent(trx, {
          conversationId,
          userId,
          triggeredBy: "idle",
          payload: samplePayload(),
        }),
      );
      const row = await tx((trx) => store.getEvolutionEvent(trx, userId, id));
      expect(row?.id).toBe(id);
      expect(row?.payload.messageCount).toBe(12);
    });

    it("getEvolutionEvent returns undefined for a row owned by another user", async () => {
      const a = await seedConversation(tx);
      const otherUserId = await seedUser(tx);
      const { id } = await tx((trx) =>
        store.recordEvolutionEvent(trx, {
          conversationId: a.conversationId,
          userId: a.userId,
          triggeredBy: "idle",
          payload: samplePayload(),
        }),
      );
      // Probing as the other user must not leak existence.
      const row = await tx((trx) => store.getEvolutionEvent(trx, otherUserId, id));
      expect(row).toBeUndefined();
    });

    it("round-trips the phases a fire recorded as failed", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      const { id } = await tx((trx) =>
        store.recordEvolutionEvent(trx, {
          conversationId,
          userId,
          triggeredBy: "idle",
          payload: { ...samplePayload(), failedPhases: ["memories", "drain"] },
        }),
      );

      const row = await tx((trx) => store.getEvolutionEvent(trx, userId, id));
      expect(row?.payload.failedPhases).toEqual(["memories", "drain"]);
    });

    it("reads a row recorded before phase outcomes without supplying any", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      // An older row's payload, written around the store.
      await db.execute(sql`
        INSERT INTO evolution_events (conversation_id, user_id, triggered_by, payload)
        VALUES (${conversationId}, ${userId}, 'idle', ${JSON.stringify(samplePayload())}::jsonb)
      `);

      const [row] = await tx((trx) => store.listEvolutionEvents(trx, userId));
      expect(expectDefined(row, "legacy row").payload).not.toHaveProperty("failedPhases");
    });

    it("rejects a failed phase the Observer does not have", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      const payload = { ...samplePayload(), failedPhases: ["reflection"] } as never;
      await expect(
        tx((trx) =>
          store.recordEvolutionEvent(trx, { conversationId, userId, triggeredBy: "idle", payload }),
        ),
      ).rejects.toThrow();
    });

    it("rejects writes whose payload doesn't match the schema", async () => {
      const { userId, conversationId } = await seedConversation(tx);
      const bad = {
        // missing required fields
        memories: { extracted: 1, byNetwork: {} },
      } as never;
      await expect(
        tx((trx) =>
          store.recordEvolutionEvent(trx, {
            conversationId,
            userId,
            triggeredBy: "idle",
            payload: bad,
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
