#!/usr/bin/env tsx
/**
 * Record Hindsight's Ollama interactions as llmock fixtures.
 *
 * Boots Ollama + Hindsight with llmock as a recording proxy in between.
 * Runs a retain/recall cycle and saves the captured request/response pairs
 * as fixture files for deterministic test replay.
 *
 * Usage:
 *   pnpm tsx scripts/record-fixtures.ts
 *
 * Requires Docker (testcontainers).
 * Output: test/fixtures/hindsight-ollama.json
 */
import { writeFileSync } from "node:fs";
import { LLMock } from "@copilotkit/llmock";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { Network } from "testcontainers";
import * as c from "../dev/containers.js";

const BANK_ID = `fixture-recording-${Date.now()}`;
const FIXTURE_PATH = "./test/fixtures/hindsight-ollama.json";

async function main() {
  console.log("Starting fixture recording...");

  // 1. Start network + Ollama
  const network = await new Network().start();
  const ollamaContainer = await c.ollama(network).start();
  await c.pullModel(ollamaContainer, c.OLLAMA_MODEL);

  const ollamaHost = ollamaContainer.getHost();
  const ollamaPort = ollamaContainer.getMappedPort(11434);
  const ollamaUrl = `http://${ollamaHost}:${ollamaPort}`;

  // 2. Start llmock in record mode — proxy to real Ollama
  const mock = new LLMock({
    port: 0,
    logLevel: "info",
    record: {
      providers: { ollama: ollamaUrl },
    },
  });
  await mock.start();
  console.log(`llmock recording proxy at ${mock.url} → Ollama at ${ollamaUrl}`);

  // 3. Start Hindsight pointing at llmock (via host.docker.internal)
  // Hindsight uses /v1 suffix for OpenAI-compatible endpoint
  const hindsightContainer = await c
    .hindsight(network, "ollama", {
      baseUrl: `http://host.docker.internal:${mock.port}/v1`,
    })
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .start();

  const hindsightHost = hindsightContainer.getHost();
  const hindsightPort = hindsightContainer.getMappedPort(8888);
  const hindsightUrl = `http://${hindsightHost}:${hindsightPort}`;
  console.log(`Hindsight at ${hindsightUrl}`);

  // 4. Create bank and run retain/recall cycle
  const client = new HindsightClient({ baseUrl: hindsightUrl });
  await client.createBank(BANK_ID);
  console.log(`Created bank ${BANK_ID}`);

  // Retain a fact
  const { HindsightMemoryProvider } = await import("../src/memory/hindsight.js");
  const memory = new HindsightMemoryProvider(hindsightUrl);
  await memory.retain(BANK_ID, "The user's favorite color is blue");
  console.log("Retained fact. Waiting for extraction...");

  // Poll for recall — Ollama is slow, wait up to 3 minutes
  let found = false;
  for (let attempt = 0; attempt < 36; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const result = await memory.recall(BANK_ID, "what is the user's favorite color?");
    if (result.memories.length > 0) {
      const match = result.memories.find((m) => m.content.toLowerCase().includes("blue"));
      if (match) {
        found = true;
        console.log(`Found memory after ${(attempt + 1) * 5}s: ${match.content}`);
        break;
      }
    }
    process.stdout.write(".");
  }

  if (!found) {
    console.error("\nFailed to find the retained fact via recall. Saving what we captured anyway.");
  }

  // 5. Extract recorded fixtures from journal
  const entries = mock.getRequests();
  console.log(`\nCaptured ${entries.length} requests`);

  const fixtures = entries
    .filter((e) => e.response.fixture !== null || e.response.status === 200)
    .map((entry) => ({
      method: entry.method,
      path: entry.path,
      request: entry.body,
      response: entry.response,
    }));

  writeFileSync(FIXTURE_PATH, JSON.stringify({ recorded: fixtures }, null, 2));
  console.log(`Saved ${fixtures.length} fixtures to ${FIXTURE_PATH}`);

  // 6. Cleanup
  await mock.stop();
  await hindsightContainer.stop();
  await ollamaContainer.stop();
  await network.stop();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
