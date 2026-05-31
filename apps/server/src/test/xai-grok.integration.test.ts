/// <reference path="../../test/vitest.d.ts" />

/**
 * xAI Grok 4.3 via OpenRouter — recorded fixture replay (and re-record).
 *
 * Same `RECORD=1` shape as `fal-mock` / `openai-voice-mock` / `daytona-mock`:
 *
 *   - **Replay** (default, free in CI): the integration tier's shared
 *     `llmock` serves `test/fixtures/recorded/openai-*.json` to our
 *     `OpenAICompatibleProvider`. llmock matches fixtures by user
 *     message content — keep `PROMPT` constant or the test loses its
 *     fixture.
 *   - **Record** (`RECORD=1 OPENROUTER_API_KEY=sk-or-... pnpm test:integration ...`):
 *     this file boots its own one-off llmock with `openai → openrouter.ai/api`
 *     mapping, fires `chat()` against the real upstream, and writes
 *     the captured response into the shared `test/fixtures/recorded/`
 *     dir. Future replay runs pick it up via the shared llmock.
 *
 * Why a dedicated llmock for recording: llmock's `RecordProviderKey`
 * is a closed enum. The shared integration llmock already routes
 * `openai → api.openai.com` for Hindsight embeddings; repurposing
 * mid-session would break Hindsight. The private llmock has its own
 * provider table and only lives for the duration of the record call.
 */

import { LLMock } from "@copilotkit/aimock";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { OpenAICompatibleProvider } from "../llm/openai-compat.js";

const PROMPT = "What is the capital of France? Answer with just the city name.";
const SYSTEM = "You are a helpful assistant. Reply concisely.";
const MODEL = "x-ai/grok-4.3";
const FIXTURE_DIR = "./test/fixtures/recorded";

const IS_RECORD = process.env.RECORD === "1" && !!process.env.OPENROUTER_API_KEY;

let recordMock: LLMock | null = null;

beforeAll(async () => {
  if (!IS_RECORD) return;
  recordMock = new LLMock({
    port: 0,
    host: "127.0.0.1",
    logLevel: "info",
    record: {
      providers: { openai: "https://openrouter.ai/api" },
      fixturePath: FIXTURE_DIR,
    },
  });
  await recordMock.start();
});

afterAll(async () => {
  if (recordMock) await recordMock.stop();
});

/** Pick the llmock URL — private (recording to OpenRouter) or shared (replay). */
function llmockBaseUrl(): string {
  if (recordMock) return `${recordMock.url}/v1`;
  return `${inject("llmockBaseUrl")}/v1`;
}

describe("OpenAICompatibleProvider — xAI Grok 4.3 via OpenRouter (recorded)", () => {
  it("completes a chat round-trip and parses the OpenAI-compatible response", async () => {
    const provider = new OpenAICompatibleProvider("openrouter-xai", {
      apiKey: IS_RECORD ? (process.env.OPENROUTER_API_KEY ?? "") : "test-key",
      baseURL: llmockBaseUrl(),
    });

    const response = await provider.chat({
      model: MODEL,
      system: SYSTEM,
      messages: [{ role: "user", content: PROMPT }],
      maxTokens: 100,
    });

    // Assert on "paris" case-insensitively rather than equality — the model
    // may add surrounding punctuation that future re-records could change.
    const textBlock = response.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    if (textBlock?.type === "text") {
      expect(textBlock.text.toLowerCase()).toMatch(/paris/);
    }
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  });

  it.skipIf(IS_RECORD)(
    "streams the same prompt without leaving the response promise dangling",
    async () => {
      // Companion to the loop-level regression in `src/agent/loop.test.ts`:
      // exercise the actual streaming path against the recorded fixture so
      // a refactor that breaks `chatStream` end-to-end gets caught here.
      // Skipped during recording — the chat() call above captures the
      // single OpenRouter response that llmock serves to both `chat` and
      // `chatStream` on subsequent replays.
      const provider = new OpenAICompatibleProvider("openrouter-xai-stream", {
        apiKey: "test-key",
        baseURL: `${inject("llmockBaseUrl")}/v1`,
      });

      const { events, response } = provider.chatStream({
        model: MODEL,
        system: SYSTEM,
        messages: [{ role: "user", content: PROMPT }],
        maxTokens: 100,
      });

      let collected = "";
      for await (const event of events) {
        if (event.type === "text_delta") collected += event.text;
      }
      const meta = await response;

      expect(collected.toLowerCase()).toMatch(/paris/);
      expect(meta.stopReason).toBe("end_turn");
      // Usage in the streaming path requires the upstream to emit a final
      // `{choices: [], usage: {...}}` chunk under `stream_options:
      // { include_usage: true }`. Real upstreams do this; llmock's
      // synthetic SSE stream does not surface the fixture's usage
      // overrides on the wire. The non-streaming test above covers
      // the usage-mapping path.
    },
  );
});
