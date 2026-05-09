/// <reference path="../../../test/vitest.d.ts" />
import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  type BackfillDeps,
  backfillProfileClass,
  type ListMemoriesPage,
  type RetainItem,
} from "./backfill-profile-class.js";

const BANK_ID = `test-backfill-${Date.now()}`;
let hindsightUrl: string;
let hindsight: HindsightClient;
let sdkClient: ReturnType<typeof createClient>;

beforeAll(async () => {
  hindsightUrl = inject("hindsightUrl");
  hindsight = new HindsightClient({ baseUrl: hindsightUrl });
  sdkClient = createClient(createConfig({ baseUrl: hindsightUrl }));
  await hindsight.createBank(BANK_ID);
});

/**
 * Wait until `listMemories` reports the expected total — Hindsight processes
 * `retainBatch` async, so freshly-seeded banks need a poll before any
 * downstream assertion runs.
 */
async function waitForCount(bankId: string, expected: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await hindsight.listMemories(bankId, { limit: 100, offset: 0 });
    if (page.total >= expected) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`waitForCount: bank ${bankId} did not reach ${expected} within ${timeoutMs}ms`);
}

function makeDeps(captured: { backup?: ReadonlyArray<unknown> }): BackfillDeps {
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
    retainBatch: async (bankId, items: ReadonlyArray<RetainItem>) => {
      // Hindsight's retainBatch processes async by default; we drive it
      // sync for the test so the post-condition assertions don't race.
      await hindsight.retainBatch(bankId, [...items], { async: false });
    },
    writeBackup: async (rows) => {
      captured.backup = rows;
    },
  };
}

describe("backfillProfileClass — real Hindsight", () => {
  it("augments un-classed memories with profile_class:* tags and second run is a no-op", {
    timeout: 180_000,
  }, async () => {
    // Seed two memories without any profile_class tag, plus one
    // already-classed row to confirm the idempotent skip path.
    await hindsight.retainBatch(
      BANK_ID,
      [
        {
          content: "homelab IP is 10.0.10.10",
          tags: ["network:world", "compartment:technical", "trust:first-party"],
        },
        {
          content: "user prefers dark mode",
          tags: ["network:bank", "compartment:personal", "trust:first-party"],
        },
        {
          content: "user feels close to wife after the trip",
          tags: [
            "network:bank",
            "compartment:personal",
            "trust:first-party",
            "profile_class:intimate",
          ],
        },
      ],
      { async: false },
    );
    await waitForCount(BANK_ID, 3);

    // First run: stamp un-classed rows with profile_class:general.
    const captured: { backup?: ReadonlyArray<unknown> } = {};
    const deps = makeDeps(captured);
    const result = await backfillProfileClass(BANK_ID, deps, { classTags: ["general"] });

    expect(result.total).toBe(3);
    expect(result.classified).toBe(2);
    expect(result.skipped).toBe(1);
    // Backup written before destructive ops.
    expect(captured.backup).toHaveLength(3);

    await waitForCount(BANK_ID, 3);
    const after = await hindsight.listMemories(BANK_ID, { limit: 100, offset: 0 });
    // listMemories items expose `text` (the extracted fact) not
    // `content` — the field name disagrees with retainBatch's input.
    const tagged = after.items.map((item) => {
      const i = item as { text?: string; tags?: string[] };
      return { text: i.text ?? "", tags: i.tags ?? [] };
    });
    expect(tagged).toHaveLength(3);
    // The two un-classed rows now carry profile_class:general.
    // Hindsight's extraction may rephrase the seed text — match on
    // distinctive substrings rather than exact equality.
    const homelab = tagged.find((t) => /10\.0\.10\.10|homelab/i.test(t.text));
    const dark = tagged.find((t) => /dark mode/i.test(t.text));
    const intimate = tagged.find((t) => /wife|close|trip/i.test(t.text));
    expect(homelab?.tags).toContain("profile_class:general");
    expect(homelab?.tags).toContain("compartment:technical");
    expect(dark?.tags).toContain("profile_class:general");
    // The pre-classed row keeps its original class — no double-stamping.
    expect(intimate?.tags).toContain("profile_class:intimate");
    expect(intimate?.tags).not.toContain("profile_class:general");

    // Second run: every row is now classed → full no-op.
    const second: { backup?: ReadonlyArray<unknown> } = {};
    const idempotent = await backfillProfileClass(BANK_ID, makeDeps(second), {
      classTags: ["general"],
    });
    expect(idempotent).toEqual({ total: 3, classified: 0, skipped: 3 });
    expect(second.backup).toHaveLength(3);

    // Confirm content is unchanged after the no-op pass.
    const finalPage = await hindsight.listMemories(BANK_ID, { limit: 100, offset: 0 });
    expect(finalPage.total).toBe(3);
  });
});
