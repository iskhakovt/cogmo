/// <reference path="../../test/vitest.d.ts" />

/**
 * Integration coverage for AgentStore admin methods against real Postgres (postgres-js),
 * complementing PGlite unit tests. The high-value check is `listConversationsForUser` —
 * PGlite and postgres-js differ on correlated-subquery TIMESTAMPTZ marshaling, so we pin
 * that behavior with the real driver here. NULLS-NOT-DISTINCT uniqueness on `profiles` and
 * the real alias index are along for the ride.
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

const SUITE = randomBytes(4).toString("hex"); // unique per test run — no collision with seed data
const name = (tag: string) => `it-${SUITE}-${tag}`;
const TEST_MODEL = "claude-sonnet-4-6";

let sql: ReturnType<typeof postgres>;
let store: DrizzleAgentStore;

beforeAll(async () => {
  sql = postgres(inject("databaseUrl"), { max: 4 });
  store = new DrizzleAgentStore(transactor(drizzle(sql, { schema })));
});

afterAll(async () => {
  await sql.end();
});

describe("AgentStore admin (real Postgres)", () => {
  it("profiles(user_id, name) is UNIQUE NULLS NOT DISTINCT", async () => {
    await store.createProfile({
      userId: null,
      name: name("org-A"),
      basePrompt: "p",
      model: "m",
      toolSet: [],
    });
    // Same (null, name) must collide even though PG normally treats NULLs as distinct
    await expect(
      store.createProfile({
        userId: null,
        name: name("org-A"),
        basePrompt: "p2",
        model: "m2",
        toolSet: [],
      }),
    ).rejects.toThrow(UniqueViolationError);

    // Same name under a user: allowed
    const { id: userId } = await store.createUser();
    await store.createProfile({
      userId,
      name: name("org-A"),
      basePrompt: "p",
      model: "m",
      toolSet: [],
    });
  });

  it("listConversationsForUser returns alias + preview + real Date timestamp", async () => {
    const { id: userId } = await store.createUser();
    const { id: profileId } = await store.createProfile({
      userId,
      name: name("listconv"),
      basePrompt: "p",
      model: TEST_MODEL,
      toolSet: [],
    });
    const { id: c1 } = await store.createConversation({ userId, profileId, isPrivate: true });
    const { id: c2 } = await store.createConversation({ userId, profileId, isPrivate: true });
    const inboundId = "019d0000-0000-7000-8000-000000000001";
    await store.insertMessage({
      conversationId: c1,
      role: "user",
      content: "first thread message",
      profileId,
      model: TEST_MODEL,
      lastInboundMessageId: inboundId,
    });
    await store.insertMessage({
      conversationId: c2,
      role: "user",
      content: "grocery shopping for saturday",
      profileId,
      model: TEST_MODEL,
      lastInboundMessageId: inboundId,
    });
    await store.setAlias(userId, c2, name("groceries"));

    const list = await store.listConversationsForUser(userId);
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
    const { id: u1 } = await store.createUser();
    const { id: u2 } = await store.createUser();
    const { id: profileId } = await store.createProfile({
      userId: u1,
      name: name("scope"),
      basePrompt: "p",
      model: TEST_MODEL,
      toolSet: [],
    });
    const mine = (await store.createConversation({ userId: u1, profileId, isPrivate: true })).id;
    const theirs = (await store.createConversation({ userId: u2, profileId, isPrivate: true })).id;
    const group = (await store.createConversation({ userId: u1, profileId, isPrivate: false })).id;
    const inboundId = "019d0000-0000-7000-8000-000000000001";
    for (const id of [mine, theirs, group]) {
      await store.insertMessage({
        conversationId: id,
        role: "user",
        content: `seed-${id}`,
        profileId,
        model: TEST_MODEL,
        lastInboundMessageId: inboundId,
      });
    }

    const list = await store.listConversationsForUser(u1);
    expect(list.map((c) => c.id)).toEqual([mine]);
  });

  it("setAlias round-trip + unique-alias collision across conversations", async () => {
    const { id: userId } = await store.createUser();
    const { id: profileId } = await store.createProfile({
      userId,
      name: name("alias"),
      basePrompt: "p",
      model: TEST_MODEL,
      toolSet: [],
    });
    const c1 = (await store.createConversation({ userId, profileId, isPrivate: true })).id;
    const c2 = (await store.createConversation({ userId, profileId, isPrivate: true })).id;

    await store.setAlias(userId, c1, name("work"));
    expect(await store.findConversationByAlias(userId, name("work"))).toEqual({
      conversationId: c1,
    });

    // Upsert on same conversation — alias replaces, old alias becomes unresolvable
    await store.setAlias(userId, c1, name("dayjob"));
    expect(await store.findConversationByAlias(userId, name("work"))).toBeUndefined();
    expect(await store.findConversationByAlias(userId, name("dayjob"))).toEqual({
      conversationId: c1,
    });

    // Cross-conversation collision → 23505 → UniqueViolationError
    await expect(store.setAlias(userId, c2, name("dayjob"))).rejects.toThrow(UniqueViolationError);
  });
});
