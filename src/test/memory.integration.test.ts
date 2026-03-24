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
  it("retain and recall round-trip", async () => {
    await memory.retain(BANK_ID, "The user's favorite color is blue");

    // Hindsight extracts facts via LLM (Ollama) — wait for processing
    await new Promise((r) => setTimeout(r, 5000));

    const result = await memory.recall(BANK_ID, "what is the user's favorite color?");

    expect(result.memories.length).toBeGreaterThan(0);
    const match = result.memories.find((m) => m.content.toLowerCase().includes("blue"));
    expect(match).toBeDefined();
  });
});
