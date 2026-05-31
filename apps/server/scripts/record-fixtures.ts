#!/usr/bin/env tsx
import { LLMock } from "@copilotkit/aimock";
import { HindsightClient } from "@vectorize-io/hindsight-client";
/**
 * Record Hindsight's LLM interactions as llmock fixtures.
 *
 * Boots slim Hindsight with llmock as a recording proxy to the real OpenAI API.
 * Runs a retain/recall cycle and saves captured request/response pairs
 * as fixture files for deterministic test replay.
 *
 * Embeddings use llmock's deterministic vectors (text-embedding-3-small
 * dimensions are hardcoded in Hindsight — no probe call needed).
 *
 * Usage:
 *   pnpm tsx scripts/record-fixtures.ts
 *
 * Requires: Docker, .env with OPENAI_API_KEY.
 * Output: test/fixtures/recorded/*.json (llmock fixture format)
 */
import { config } from "dotenv";
import { Network } from "testcontainers";
import * as c from "../dev/containers.js";

config(); // load .env

const BANK_ID = `fixture-recording-${Date.now()}`;
const FIXTURE_DIR = "./test/fixtures/recorded";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required in .env");
    process.exit(1);
  }

  console.log("Starting fixture recording (slim Hindsight + OpenAI via llmock)...");

  const network = await new Network().start();

  // llmock in record mode — proxy LLM calls to real OpenAI API.
  // Existing fixtures replay instantly; only new prompts hit the real API.
  // Embeddings use llmock's built-in deterministic vectors (no recording needed).
  const mock = new LLMock({
    port: 0,
    host: "0.0.0.0",
    logLevel: "info",
    record: {
      providers: { openai: "https://api.openai.com" },
      fixturePath: FIXTURE_DIR,
    },
  });
  try {
    mock.loadFixtureDir(FIXTURE_DIR);
  } catch {
    // No fixtures yet
  }
  await mock.start();
  console.log(`llmock recording proxy at ${mock.url}`);

  // Slim Hindsight — OpenAI for LLM, deterministic embeddings via llmock, RRF reranker
  const llmockUrl = `http://host.docker.internal:${mock.port}/v1`;
  const hindsightContainer = await c
    .hindsightSlim(network, {
      llmBaseUrl: llmockUrl,
      llmApiKey: apiKey,
      llmModel: "gpt-5-nano",
      embeddingsBaseUrl: llmockUrl,
      embeddingsApiKey: apiKey,
      embeddingsModel: "text-embedding-3-small",
    })
    .start();

  const hindsightUrl = `http://${hindsightContainer.getHost()}:${hindsightContainer.getMappedPort(8888)}`;
  console.log(`Hindsight at ${hindsightUrl}`);

  const client = new HindsightClient({ baseUrl: hindsightUrl });
  await client.createBank(BANK_ID);
  console.log(`Created bank ${BANK_ID}`);

  const { HindsightMemoryProvider } = await import("../src/memory/hindsight.js");
  const memory = new HindsightMemoryProvider(hindsightUrl);
  await memory.retain(BANK_ID, "The user's favorite color is blue");
  console.log("Retained fact. Polling for recall...");

  let found = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await memory.recall(BANK_ID, "what is the user's favorite color?");
    if (result.memories.length > 0) {
      const match = result.memories.find((m) => m.content.toLowerCase().includes("blue"));
      if (match) {
        found = true;
        console.log(`\nFound memory after ${(attempt + 1) * 2}s: ${match.content}`);
        break;
      }
    }
    process.stdout.write(".");
  }

  if (!found) {
    console.error("\nFailed to find the retained fact via recall.");
  }

  const entries = mock.getRequests();
  console.log(`Captured ${entries.length} requests. Fixtures saved to ${FIXTURE_DIR}/`);

  await mock.stop();
  await hindsightContainer.stop();
  await network.stop();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
