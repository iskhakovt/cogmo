/// <reference path="../../test/vitest.d.ts" />

/**
 * Integration coverage for AgentStore against real Postgres (postgres-js),
 * complementing PGlite unit tests. The high-value checks are the ones where the
 * two can diverge, or where the assertion is about DDL the unit tier never runs:
 * `listConversationsForUser` (PGlite and postgres-js differ on
 * correlated-subquery TIMESTAMPTZ marshaling) and the `conversation_summaries`
 * read/write path, whose ordering, `xmax`-based conflict discrimination and
 * composite unique all come from the real migration rather than `pushSchema`.
 * NULLS-NOT-DISTINCT uniqueness on `profiles` and the real alias index are along
 * for the ride.
 *
 * Uses the shared integration Postgres (via `DATABASE_URL` from `test/integration-setup.ts`).
 * Every row uses a test-scoped random suffix so we never touch seeded data or other suites.
 */

import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { UniqueViolationError } from "../agent/store/errors.js";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { transactor } from "../db/index.js";
import * as schema from "../db/schemas.js";
import { expectDefined } from "./assertions.js";

const SUITE = randomBytes(4).toString("hex"); // unique per test run — no collision with seed data
const name = (tag: string) => `it-${SUITE}-${tag}`;
const TEST_MODEL = "claude-sonnet-4-6";

let sql: ReturnType<typeof postgres>;
let tx: ReturnType<typeof transactor>;
let store: DrizzleAgentStore;

beforeAll(async () => {
  sql = postgres(inject("databaseUrl"), { max: 4 });
  tx = transactor(drizzle(sql, { schema }));
  store = new DrizzleAgentStore();
});

afterAll(async () => {
  await sql.end();
});

describe("AgentStore admin (real Postgres)", () => {
  it("profiles(user_id, name) is UNIQUE NULLS NOT DISTINCT", async () => {
    await tx((trx) =>
      store.createProfile(trx, {
        userId: null,
        name: name("org-A"),
        basePrompt: "p",
        model: "m",
        toolSet: [],
      }),
    );
    // Same (null, name) must collide even though PG normally treats NULLs as distinct
    await expect(
      tx((trx) =>
        store.createProfile(trx, {
          userId: null,
          name: name("org-A"),
          basePrompt: "p2",
          model: "m2",
          toolSet: [],
        }),
      ),
    ).rejects.toThrow(UniqueViolationError);

    // Same name under a user: allowed
    const { id: userId } = await tx((trx) => store.createUser(trx));
    await tx((trx) =>
      store.createProfile(trx, {
        userId,
        name: name("org-A"),
        basePrompt: "p",
        model: "m",
        toolSet: [],
      }),
    );
  });

  it("listConversationsForUser returns alias + preview + real Date timestamp", async () => {
    const { id: userId } = await tx((trx) => store.createUser(trx));
    const { id: profileId } = await tx((trx) =>
      store.createProfile(trx, {
        userId,
        name: name("listconv"),
        basePrompt: "p",
        model: TEST_MODEL,
        toolSet: [],
      }),
    );
    const { id: c1 } = await tx((trx) =>
      store.createConversation(trx, { userId, profileId, isPrivate: true }),
    );
    const { id: c2 } = await tx((trx) =>
      store.createConversation(trx, { userId, profileId, isPrivate: true }),
    );
    const inboundId = "019d0000-0000-7000-8000-000000000001";
    await tx((trx) =>
      store.insertMessage(trx, {
        conversationId: c1,
        role: "user",
        content: "first thread message",
        profileId,
        model: TEST_MODEL,
        lastInboundMessageId: inboundId,
      }),
    );
    await tx((trx) =>
      store.insertMessage(trx, {
        conversationId: c2,
        role: "user",
        content: "grocery shopping for saturday",
        profileId,
        model: TEST_MODEL,
        lastInboundMessageId: inboundId,
      }),
    );
    await tx((trx) => store.setAlias(trx, userId, c2, name("groceries")));

    const list = await tx((trx) => store.listConversationsForUser(trx, userId));
    expect(list).toHaveLength(2);

    const aliased = list.find((c) => c.id === c2);
    expect(aliased?.alias).toBe(name("groceries"));
    expect(aliased?.lastMessagePreview).toContain("grocery");
    // Critical: correlated-subquery TIMESTAMPTZ must arrive as a Date, not an ISO string
    expect(aliased?.lastMessageAt).toBeInstanceOf(Date);

    const plain = list.find((c) => c.id === c1);
    expect(plain?.alias).toBeNull();
  });

  it("listConversationsForUser excludes non-private and other users", async () => {
    const { id: u1 } = await tx((trx) => store.createUser(trx));
    const { id: u2 } = await tx((trx) => store.createUser(trx));
    const { id: profileId } = await tx((trx) =>
      store.createProfile(trx, {
        userId: u1,
        name: name("scope"),
        basePrompt: "p",
        model: TEST_MODEL,
        toolSet: [],
      }),
    );
    const mine = (
      await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: true }))
    ).id;
    const theirs = (
      await tx((trx) => store.createConversation(trx, { userId: u2, profileId, isPrivate: true }))
    ).id;
    const group = (
      await tx((trx) => store.createConversation(trx, { userId: u1, profileId, isPrivate: false }))
    ).id;
    const inboundId = "019d0000-0000-7000-8000-000000000001";
    for (const id of [mine, theirs, group]) {
      await tx((trx) =>
        store.insertMessage(trx, {
          conversationId: id,
          role: "user",
          content: `seed-${id}`,
          profileId,
          model: TEST_MODEL,
          lastInboundMessageId: inboundId,
        }),
      );
    }

    const list = await tx((trx) => store.listConversationsForUser(trx, u1));
    expect(list.map((c) => c.id)).toEqual([mine]);
  });

  it("setAlias round-trip + unique-alias collision across conversations", async () => {
    const { id: userId } = await tx((trx) => store.createUser(trx));
    const { id: profileId } = await tx((trx) =>
      store.createProfile(trx, {
        userId,
        name: name("alias"),
        basePrompt: "p",
        model: TEST_MODEL,
        toolSet: [],
      }),
    );
    const c1 = (
      await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
    ).id;
    const c2 = (
      await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
    ).id;

    await tx((trx) => store.setAlias(trx, userId, c1, name("work")));
    expect(await tx((trx) => store.findConversationByAlias(trx, userId, name("work")))).toEqual({
      conversationId: c1,
    });

    // Upsert on same conversation — alias replaces, old alias becomes unresolvable
    await tx((trx) => store.setAlias(trx, userId, c1, name("dayjob")));
    expect(
      await tx((trx) => store.findConversationByAlias(trx, userId, name("work"))),
    ).toBeUndefined();
    expect(await tx((trx) => store.findConversationByAlias(trx, userId, name("dayjob")))).toEqual({
      conversationId: c1,
    });

    // Cross-conversation collision → 23505 → UniqueViolationError
    await expect(tx((trx) => store.setAlias(trx, userId, c2, name("dayjob")))).rejects.toThrow(
      UniqueViolationError,
    );
  });
});

describe("conversation summaries (real Postgres)", () => {
  const INBOUND = "019d0000-0000-7000-8000-0000000000ff";

  async function seed(messageCount: number) {
    const { id: userId } = await tx((trx) => store.createUser(trx));
    const { id: profileId } = await tx((trx) =>
      store.createProfile(trx, {
        userId,
        name: name(`summaries-${randomBytes(3).toString("hex")}`),
        basePrompt: "p",
        model: TEST_MODEL,
        toolSet: [],
      }),
    );
    const conversationId = (
      await tx((trx) => store.createConversation(trx, { userId, profileId, isPrivate: true }))
    ).id;
    const ids: string[] = [];
    for (let i = 0; i < messageCount; i++) {
      const row = await tx((trx) =>
        store.insertMessage(trx, {
          conversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          lastInboundMessageId: INBOUND,
          profileId,
          model: TEST_MODEL,
        }),
      );
      ids.push(row.id);
    }
    return { conversationId, ids };
  }

  const write = (conversationId: string, throughMessageId: string, summary: string) =>
    tx((trx) =>
      store.insertOrRecoverSummary(trx, {
        conversationId,
        summary,
        throughMessageId,
        messagesSummarized: 1,
        model: "claude-haiku-4-5",
        source: "turn",
      }),
    );

  it("reads back the widest summary, not the last written", async () => {
    // The ordering is served by scanning the composite unique backwards, which
    // is DDL from the migration rather than anything `pushSchema` infers, and
    // it compares real `uuid` values rather than PGlite's.
    const { conversationId, ids } = await seed(4);
    await write(conversationId, expectDefined(ids[2]), "wider, written first");
    await write(conversationId, expectDefined(ids[0]), "narrower, written second");

    const latest = await tx((trx) => store.getLatestSummary(trx, conversationId));
    expect(latest?.summary).toBe("wider, written first");
  });

  it("discriminates insert from conflict-update via xmax on the real driver", async () => {
    // `(xmax = 0)` is a system-column read that has to survive postgres-js's
    // result marshaling as a boolean; the `kind` contract the whole
    // idempotency story rests on is exactly this value.
    const { conversationId, ids } = await seed(2);

    const first = await write(conversationId, expectDefined(ids[0]), "written once");
    const second = await write(conversationId, expectDefined(ids[0]), "a retry's text");

    expect(first.kind).toBe("new");
    expect(second.kind).toBe("recovered");
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.summary).toBe("written once");
  });

  it("cuts history at the summary's message using real uuidv7 ordering", async () => {
    // `gt(messages.id, cutoff)` is an ordering predicate over time-ordered
    // uuids, and the column mapper runs on the production binder here.
    const { conversationId, ids } = await seed(5);

    const after = await tx((trx) =>
      store.getHistoryAfter(trx, conversationId, expectDefined(ids[1])),
    );

    expect(after.map((m) => m.id)).toEqual(ids.slice(2));
    expect(after.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
  });

  it("carries the composite unique that makes the idempotency key work", async () => {
    // Read the catalog rather than provoking a violation: Drizzle wraps query
    // errors as `Failed query: <sql>` and puts the constraint name on the
    // `cause`, so asserting on a thrown message couples the test to that
    // wrapping instead of to the DDL it means to check. The `ON CONFLICT`
    // target is only an idempotency key if the migration actually created it.
    const rows = await sql<{ contype: string }[]>`
      SELECT contype::text FROM pg_constraint
      WHERE conname = 'uq_conversation_summaries_conv_through'
        AND conrelid = 'conversation_summaries'::regclass
    `;
    expect(rows.map((r) => r.contype)).toEqual(["u"]);
  });
});
