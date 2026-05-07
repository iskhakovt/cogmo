/// <reference path="../../test/vitest.d.ts" />
import { beforeAll, describe, expect, inject, it } from "vitest";
import { HindsightMemoryProvider } from "../memory/hindsight.js";
import type { TagGroup } from "../memory/provider.js";

const BANK_ID = `test-${Date.now()}`;
const COMPARTMENT_BANK_ID = `test-compartments-${Date.now()}`;
let memory: HindsightMemoryProvider;

beforeAll(async () => {
  const hindsightUrl = inject("hindsightUrl");
  memory = new HindsightMemoryProvider(hindsightUrl);

  const { HindsightClient } = await import("@vectorize-io/hindsight-client");
  const client = new HindsightClient({ baseUrl: hindsightUrl });
  await client.createBank(BANK_ID);
  await client.createBank(COMPARTMENT_BANK_ID);
});

describe("hindsight memory", () => {
  it("retain and recall round-trip", { timeout: 60_000 }, async () => {
    await memory.retain(BANK_ID, "The user's favorite color is blue");

    // Hindsight extracts facts via llmock (instant responses).
    // Still need to poll — Hindsight has internal async processing.
    let found = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const result = await memory.recall(BANK_ID, "what is the user's favorite color?");
      if (result.memories.length > 0) {
        const match = result.memories.find((m) => m.content.toLowerCase().includes("blue"));
        if (match) {
          found = true;
          break;
        }
      }
    }

    expect(found).toBe(true);
  });

  // Profile-scope ACL — retain memories tagged across two compartments,
  // recall through a profile-style tag_groups filter scoped to one of
  // them, assert the other compartment's memories don't surface. Mirrors
  // the shape `applyScopeToRecall` produces in src/agent/service.ts.
  it("compartment isolation via tag_groups recall", { timeout: 90_000 }, async () => {
    await memory.retainBatch(COMPARTMENT_BANK_ID, [
      {
        content: "The user works as a senior backend engineer at Acme Corp",
        tags: ["compartment:work", "trust:first-party"],
      },
      {
        content:
          "The user's primary work repository is acme-internal/payments-service on GitHub Enterprise",
        tags: ["compartment:work", "trust:first-party"],
      },
      {
        content: "The user enjoys hiking on weekends with their golden retriever named Pepper",
        tags: ["compartment:personal", "trust:first-party"],
      },
      {
        content: "The user lives in a small apartment in the Kreuzberg district of Berlin",
        tags: ["compartment:personal", "trust:first-party"],
      },
    ]);

    const workScope: TagGroup[] = [
      {
        and: [
          { tags: ["compartment:work"], match: "any_strict" },
          { tags: ["trust:first-party"], match: "any_strict" },
        ],
      },
    ];

    // Poll the scoped recall — Hindsight processes retainBatch async,
    // so memories materialize a second or two after the call returns.
    let scoped: { memories: { content: string }[] } = { memories: [] };
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      scoped = await memory.recall(COMPARTMENT_BANK_ID, "what does the user do for a living?", {
        tagGroups: workScope,
      });
      if (scoped.memories.length > 0) break;
    }

    expect(scoped.memories.length).toBeGreaterThan(0);

    const haystack = scoped.memories.map((m) => m.content.toLowerCase()).join("\n");
    // At least one of the work-tagged retentions surfaces under the work scope.
    expect(haystack).toMatch(/engineer|acme|payments-service/);
    // None of the personal-tagged retentions leak across the ACL boundary.
    expect(haystack).not.toMatch(/pepper|hiking|kreuzberg|berlin|apartment/);
  });
});
