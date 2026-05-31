/// <reference path="../../../test/vitest.d.ts" />
import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type { Database } from "../../db/index.js";
import { DrizzleAgentStore } from "../store/index.js";
import {
  type ListMemoriesPage,
  type MigrationDeps,
  migrateUntaggedMemories,
  type RawBankMemory,
} from "./migrate-untagged-memories.js";

// `bankId == userId` is Cogmo's convention. Reuse the seeded
// `defaultUserId` so `pending_memories.user_id` (typed `uuid` with FK
// to `users.id`) accepts the staged rows — a synthetic
// `test-migrate-<ts>` bank id would fail the FK check.
let BANK_ID: string;
let hindsight: HindsightClient;
let sdkClient: ReturnType<typeof createClient>;
let db: Database;
let pgClient: postgres.Sql;
let userId: string;
let store: DrizzleAgentStore;

beforeAll(async () => {
  const hindsightUrl = inject("hindsightUrl");
  const databaseUrl = inject("databaseUrl");
  hindsight = new HindsightClient({ baseUrl: hindsightUrl });
  sdkClient = createClient(createConfig({ baseUrl: hindsightUrl }));
  pgClient = postgres(databaseUrl);
  db = drizzle(pgClient);
  store = new DrizzleAgentStore();

  userId = inject("defaultUserId");
  BANK_ID = userId;
  // Bank should already exist for the seeded user, but createBank is
  // idempotent — keeps this test self-contained against future seed
  // changes.
  await hindsight.createBank(BANK_ID);
  // Clear before seeding so the strict `result.migrated === 2` assert
  // below isn't sensitive to leftovers from a prior failed run, the
  // seed step's own probe memories, or any future test that lands
  // memories in the default user's bank.
  const cleared = await sdk.clearBankMemories({ client: sdkClient, path: { bank_id: BANK_ID } });
  if (cleared.error) {
    throw new Error(`pre-test clearBankMemories failed: ${JSON.stringify(cleared.error)}`);
  }
});

afterAll(async () => {
  await pgClient.end();
});

async function waitForCount(bankId: string, expected: number, timeoutMs = 60_000): Promise<void> {
  await vi.waitFor(
    async () => {
      const page = await hindsight.listMemories(bankId, { limit: 100, offset: 0 });
      if (page.total < expected) {
        throw new Error(`bank ${bankId} count ${page.total} < expected ${expected}`);
      }
    },
    { timeout: timeoutMs, interval: 1000 },
  );
}

function makeDeps(captured: { backup?: ReadonlyArray<RawBankMemory> }): MigrationDeps {
  return {
    listMemories: async (bankId, opts): Promise<ListMemoriesPage> => {
      const page = await hindsight.listMemories(bankId, opts);
      return {
        items: page.items,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      };
    },
    clearBankMemories: async (bankId) => {
      const res = await sdk.clearBankMemories({ client: sdkClient, path: { bank_id: bankId } });
      if (res.error) throw new Error(`clearBankMemories failed: ${JSON.stringify(res.error)}`);
    },
    runInTx: (cb) => db.transaction((tx) => cb(tx)),
    agentStore: store,
    writeBackup: async (rows) => {
      captured.backup = rows;
    },
  };
}

describe("migrateUntaggedMemories — real Hindsight + Postgres", () => {
  it("stages every memory into pending_memories and clears the bank — round-trip works against the live infra", {
    timeout: 120_000,
  }, async () => {
    // Seed two un-classified memories — pre-feature shape, no
    // network/compartment/trust tags. This is the legacy state the
    // migration is meant to heal.
    await hindsight.retainBatch(
      BANK_ID,
      [
        { content: "homelab IP is 10.0.10.10" },
        { content: "wife's birthday is March 15", context: "while planning a gift" },
      ],
      { async: false },
    );
    await waitForCount(BANK_ID, 2);

    const captured: { backup?: ReadonlyArray<RawBankMemory> } = {};
    const result = await migrateUntaggedMemories(BANK_ID, makeDeps(captured));

    expect(result.migrated).toBe(2);
    expect(captured.backup).toHaveLength(2);

    // Bank cleared — listMemories now empty.
    const cleared = await hindsight.listMemories(BANK_ID, { limit: 100, offset: 0 });
    expect(cleared.total).toBe(0);

    // pending_memories now carries the staged rows for the user, with
    // source=migration so the next Observer drain picks them up
    // through the classifier path.
    const pending = await db.transaction((tx) => store.getPendingMemories(tx, userId));
    const migrated = pending.filter((p) => p.source === "migration");
    expect(migrated).toHaveLength(2);
    // Hindsight's extraction can rephrase the seed text ("homelab IP
    // is 10.0.10.10" can come back as "Homelab IP is 10.0.10.10",
    // "wife's birthday is March 15" gets framed with extra entity
    // context). Match on distinctive substrings rather than exact
    // equality so a fresh extraction-prompt rev doesn't break the test.
    const contents = migrated.map((p) => p.content);
    expect(contents.some((c) => /10\.0\.10\.10|homelab/i.test(c))).toBe(true);
    expect(contents.some((c) => /march 15|birthday/i.test(c))).toBe(true);
    // Migration-staged rows have no profile_id (no per-row staging
    // profile lineage from the legacy data).
    expect(migrated.every((p) => p.profileClass === null)).toBe(true);

    // Cleanup so this test can be re-run idempotently against the
    // same Hindsight + Postgres without leaking pending rows.
    await db.transaction((tx) =>
      store.deletePendingMemories(
        tx,
        migrated.map((p) => p.id),
      ),
    );
  });

  it("is a no-op on an empty bank — does not call clear, but writes empty backup", {
    timeout: 30_000,
  }, async () => {
    const emptyBankId = `test-migrate-empty-${Date.now()}`;
    await hindsight.createBank(emptyBankId);

    const captured: { backup?: ReadonlyArray<RawBankMemory> } = {};
    const result = await migrateUntaggedMemories(emptyBankId, makeDeps(captured));

    expect(result.migrated).toBe(0);
    expect(captured.backup).toEqual([]);
  });
});
