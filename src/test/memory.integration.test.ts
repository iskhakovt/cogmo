/// <reference path="../../test/vitest.d.ts" />
import { beforeAll, describe, expect, inject, it, vi } from "vitest";
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
    await vi.waitFor(
      async () => {
        const result = await memory.recall(BANK_ID, "what is the user's favorite color?");
        const match = result.memories.find((m) => m.content.toLowerCase().includes("blue"));
        if (!match) throw new Error("favorite-color memory not yet recalled");
      },
      { timeout: 30_000, interval: 1000 },
    );
  });

  // Profile-scope ACL — retain memories tagged across two compartments,
  // recall through a profile-style tag_groups filter scoped to one of
  // them, assert the other compartment's memories don't surface. Mirrors
  // the shape `applyScopeToRecall` produces in src/agent/service.ts.
  //
  // Test design: query semantically targets PERSONAL content and runs
  // twice — once under work scope (expect no personal substrings to
  // leak through) and once under personal scope (expect them to
  // surface). A work-specific query would let a broken filter pass
  // silently because semantic ranking would deprioritize the personal
  // memories below the recall threshold even with no filter at all.
  // Targeting personal content forces the filter to be the only thing
  // separating signal from leakage.
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
    const personalScope: TagGroup[] = [
      {
        and: [
          { tags: ["compartment:personal"], match: "any_strict" },
          { tags: ["trust:first-party"], match: "any_strict" },
        ],
      },
    ];

    // The query targets a personal-only fact (the dog's name). Under
    // a working filter, work scope returns nothing about Pepper and
    // personal scope returns the hiking/Pepper memory. Under a broken
    // filter, the work-scoped call leaks Pepper through; under a
    // null-on-everything filter, the personal-scoped call returns
    // empty — both directions are caught.
    const personalQuery = "what is the user's dog called?";

    // Poll the personal-scoped recall first — Hindsight processes
    // retainBatch async, so we wait for at least one memory to
    // materialise before asserting on either scope.
    const personal = await vi.waitFor(
      async () => {
        const result = await memory.recall(COMPARTMENT_BANK_ID, personalQuery, {
          tagGroups: personalScope,
        });
        if (result.memories.length === 0) throw new Error("no personal-scope memories yet");
        return result;
      },
      { timeout: 60_000, interval: 1000 },
    );

    expect(personal.memories.length).toBeGreaterThan(0);
    const personalHaystack = personal.memories.map((m) => m.content.toLowerCase()).join("\n");
    expect(personalHaystack).toMatch(/pepper|hiking|retriever/);

    // Same query, work scope. The dog memory is personal-tagged, so
    // a working filter excludes it entirely. Any leakage of
    // pepper/hiking/retriever would mean the tag_groups ACL is broken.
    const work = await memory.recall(COMPARTMENT_BANK_ID, personalQuery, {
      tagGroups: workScope,
    });
    const workHaystack = work.memories.map((m) => m.content.toLowerCase()).join("\n");
    expect(workHaystack).not.toMatch(/pepper|hiking|retriever|kreuzberg|berlin|apartment/);
  });
});
