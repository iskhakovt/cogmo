/// <reference path="../../test/vitest.d.ts" />

/**
 * xAI Grok 4.3 via OpenRouter — recorded fixture replay.
 *
 * Pins our `OpenAICompatibleProvider` against an actual recorded
 * OpenRouter→xAI response. The fixture is captured by `pnpm tsx
 * scripts/record-xai-fixture.ts` (requires `OPENROUTER_API_KEY`) and lives
 * under `test/fixtures/recorded/`. llmock matches fixtures by user message
 * content, not by model — keep `PROMPT` here in sync with the recording
 * script's constant or the test loses its fixture.
 *
 * The wire-format coverage is the point: a future refactor that drops or
 * renames a request field would fail the recording on next refresh, and
 * any change to how we parse OpenAI-compatible responses would break the
 * replay assertions here.
 */

import { describe, expect, inject, it } from "vitest";
import { OpenAICompatibleProvider } from "../llm/openai-compat.js";

const PROMPT = "What is the capital of France? Answer with just the city name.";
const SYSTEM = "You are a helpful assistant. Reply concisely.";
const MODEL = "x-ai/grok-4.3";

describe("OpenAICompatibleProvider — xAI Grok 4.3 via OpenRouter (recorded)", () => {
  it("completes a chat round-trip and parses the OpenAI-compatible response", async () => {
    const llmockBaseUrl = inject("llmockBaseUrl");
    const provider = new OpenAICompatibleProvider("openrouter-xai", {
      apiKey: "test-key",
      baseURL: `${llmockBaseUrl}/v1`,
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

  it("streams the same prompt without leaving the response promise dangling", async () => {
    // Companion to the loop-level regression in `src/agent/loop.test.ts`:
    // exercise the actual streaming path against the recorded fixture so a
    // refactor that breaks `chatStream` end-to-end gets caught here too.
    const llmockBaseUrl = inject("llmockBaseUrl");
    const provider = new OpenAICompatibleProvider("openrouter-xai-stream", {
      apiKey: "test-key",
      baseURL: `${llmockBaseUrl}/v1`,
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
    // { include_usage: true }`. Real upstreams do this; llmock's synthetic
    // SSE stream does not surface the fixture's usage overrides on the
    // wire. The non-streaming test above covers the usage-mapping path.
  });
});
