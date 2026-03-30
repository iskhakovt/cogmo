/// <reference path="../../test/vitest.d.ts" />
import { beforeAll, describe, expect, inject, it } from "vitest";
import { HindsightMemoryProvider } from "../memory/hindsight.js";

const BANK_ID = `test-${Date.now()}`;
let memory: HindsightMemoryProvider;

beforeAll(async () => {
  const hindsightUrl = inject("hindsightUrl");
  memory = new HindsightMemoryProvider(hindsightUrl);

  const { HindsightClient } = await import("@vectorize-io/hindsight-client");
  const client = new HindsightClient({ baseUrl: hindsightUrl });
  await client.createBank(BANK_ID);
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
});
