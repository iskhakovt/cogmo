#!/usr/bin/env tsx
/**
 * Record a Grok 4.3 fixture by proxying our `OpenAICompatibleProvider`
 * through llmock to OpenRouter. Captures the real OpenRouter→xAI wire
 * response so the integration test can replay it deterministically.
 *
 * Why a separate llmock instance (not `record-fixtures.ts`'s):
 *   - llmock's `RecordProviderKey` enum is closed (`openai`, `anthropic`,
 *     `gemini`, ...). xAI/OpenRouter aren't in it, so the only way to
 *     proxy to OpenRouter is to repurpose the `openai` key.
 *   - The shared recording script uses `openai → api.openai.com`. Pointing
 *     it at OpenRouter mid-session would break Hindsight's `gpt-5-nano`
 *     calls (model doesn't exist on OpenRouter under that name).
 *   - This script is one-off + isolated: own llmock, own upstream URL,
 *     writes to the same shared `test/fixtures/recorded/` dir. The fixture
 *     is content-keyed (by user message), so the integration llmock picks
 *     it up via `loadFixtureDir` without any provider-key plumbing.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... pnpm tsx scripts/record-xai-fixture.ts
 *
 * Output: test/fixtures/recorded/openai-<timestamp>-<hash>.json
 */
import { LLMock } from "@copilotkit/aimock";
import { config } from "dotenv";
import { OpenAICompatibleProvider } from "../src/llm/openai-compat.js";

config(); // load .env

const FIXTURE_DIR = "./test/fixtures/recorded";

// Keep in sync with src/test/xai-grok.integration.test.ts. The user message
// is the fixture match key — change it here and the test loses its fixture.
const PROMPT = "What is the capital of France? Answer with just the city name.";
const SYSTEM = "You are a helpful assistant. Reply concisely.";
const MODEL = "x-ai/grok-4.3";

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required (set in .env or via env)");
    process.exit(1);
  }

  // resolveUpstreamUrl preserves the `/api` prefix when joining with the
  // SDK's `/v1/chat/completions` path → forwards to
  // https://openrouter.ai/api/v1/chat/completions. See llmock/url.ts.
  const mock = new LLMock({
    port: 0,
    host: "127.0.0.1",
    logLevel: "info",
    record: {
      providers: { openai: "https://openrouter.ai/api" },
      fixturePath: FIXTURE_DIR,
    },
  });
  await mock.start();
  console.log(`recording llmock at ${mock.url} → openrouter.ai/api`);

  // Hit through the same adapter the agent loop uses so the captured
  // request shape is identical to production. A 4xx schema reject from
  // the upstream surfaces here as an SDK error — the catch block prints
  // the body so the real reason is visible.
  const provider = new OpenAICompatibleProvider("openrouter-xai", {
    apiKey,
    baseURL: `${mock.url}/v1`,
  });

  try {
    const response = await provider.chat({
      model: MODEL,
      system: SYSTEM,
      messages: [{ role: "user", content: PROMPT }],
      maxTokens: 100,
    });
    console.log("\n--- response ---");
    console.log(JSON.stringify(response, null, 2));
    console.log("\nFixture saved to", FIXTURE_DIR);
  } catch (err) {
    console.error("\n--- request failed ---");
    if (err instanceof Error) {
      const status = (err as Error & { status?: unknown }).status;
      const body = (err as Error & { error?: unknown }).error;
      console.error(`name=${err.name} status=${String(status)} message=${err.message}`);
      if (body) console.error("body:", JSON.stringify(body, null, 2));
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  } finally {
    await mock.stop();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
