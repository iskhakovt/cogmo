/**
 * Live: the agent loop's tool iterations read the transcript the iteration
 * before them cached — the claim prompt-caching step 1 exists for
 * (design/prompt-caching.md → Implementation Plan, step 1).
 *
 * `anthropic.live.test.ts` shows the relation for plain text turns through
 * the adapter. This drives `runStreamingAgentLoop` itself, as production
 * does: a real `AnthropicProvider` behind the wire recorder, the caller's
 * `long` cache intent, and no `thinking` parameter, so the model thinks as
 * its default has it. The prompt makes the model call one tool twice in
 * sequence — the second key is only in the first result — so a turn runs
 * three iterations, and each after the first re-sends the previous one's
 * thinking, `tool_use` and `tool_result` blocks.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. Each model costs a
 * few cents: one ~5k-token cache write at the 1-hour rate, then reads.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live
 *
 * `LIVE_MODELS` (comma-separated) runs the scenario on other models than
 * Sonnet 5, the production chat model.
 */

import { randomUUID } from "node:crypto";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { AnthropicProvider } from "../llm/anthropic.js";
import { logger } from "../logger.js";
import { expectDefined } from "../test/assertions.js";
import { createWireRecorder, type WireResponse } from "../test/wire-recorder.js";
import { runStreamingAgentLoop } from "./loop.js";
import type { Service } from "./service.js";
import { defineTool, ToolRegistry } from "./tools.js";

// An empty `ANTHROPIC_API_KEY=` line in `.env` counts as unset.
const API_KEY = (process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY) || undefined;

const MODELS = (process.env.LIVE_MODELS ?? "claude-sonnet-5").split(",").map((m) => m.trim());

/** Above the largest minimum cacheable prefix among the models run (Sonnet 5: 1,024). */
const MIN_CACHEABLE_TOKENS = 1024;

/** The chain the model walks: each result names the next key, the last holds the answer. */
const TABLE: Readonly<Record<string, string>> = {
  start: "The next key is harbor.",
  harbor: "The number is 7291.",
};

const PROMPT =
  "Call lookup_number with the key start. Its result names the next key: call " +
  "lookup_number with that key. Then reply with only the number the second lookup returned.";

const AnthropicUsageSchema = z.object({
  input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
  cache_creation: z.object({
    ephemeral_5m_input_tokens: z.number(),
    ephemeral_1h_input_tokens: z.number(),
  }),
});

/** A system prompt well above the minimum cacheable prefix, opened by the run's nonce. */
function systemPrompt(nonce: string): string {
  const moods = ["calm", "curious", "cheerful", "careful"];
  const rules = R.times(
    120,
    (i) =>
      `Rule ${i + 1}: when the number ${i * 7 + 3} comes up, stay ${moods[i % moods.length]} ` +
      `and mention nothing about rule ${i + 1} unless asked.`,
  );
  return [
    `Session ${nonce}.`,
    "You are a terse assistant. Use the tools you are given exactly as the user asks.",
    "House rules follow.",
    ...rules,
  ].join("\n");
}

function lookupTools(calls: string[]): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(
    defineTool({
      name: "lookup_number",
      description: "Look up the entry stored under a key.",
      schema: z.object({ key: z.string().describe("The key to look up.") }),
      sideEffectful: false,
      handler: async ({ key }) => {
        calls.push(key);
        return TABLE[key] ?? `No entry for ${key}.`;
      },
    }),
  );
  return tools;
}

describe.skipIf(API_KEY === undefined)("runStreamingAgentLoop prompt caching (live)", () => {
  it.each(MODELS)(
    "on %s, each tool iteration reads exactly what the one before it cached",
    async (model) => {
      const nonce = randomUUID();
      // Cache diagnostics: a fingerprint is stored only for requests that carry
      // the object, so it goes on every one — `null` first, then the id of the
      // last response that succeeded.
      let previousMessageId: string | null = null;
      const recorder = createWireRecorder(undefined, {
        mutate: (_url, init) => ({
          headers: init.headers,
          body: { ...init.body, diagnostics: { previous_message_id: previousMessageId } },
        }),
      });
      // The loop starts the next request once the previous stream ends, and the
      // recorder settles an exchange once it has read the whole body, so wait
      // for it before reading the previous id.
      const diagnosedFetch: typeof fetch = async (input, init) => {
        const last = recorder.exchanges.at(-1);
        const settled = last && (await last.response.catch(() => undefined));
        if (settled?.status === 200 && settled.id) previousMessageId = settled.id;
        return recorder.fetch(input, init);
      };
      const provider = new AnthropicProvider(expectDefined(API_KEY, "API key"), undefined, {
        fetch: diagnosedFetch,
      });
      const calls: string[] = [];

      const result = await runStreamingAgentLoop({
        provider,
        model,
        systemPrompt: systemPrompt(nonce),
        messages: [{ role: "user", content: PROMPT }],
        tools: lookupTools(calls),
        service: mock<Service>(),
        maxTokens: 8000,
        onEvent: async () => {},
        cache: { key: nonce, retention: "long" },
        turnLogger: logger,
      });

      // The SDK retries overloads, rate limits and dropped connections; each
      // attempt is its own exchange, and only those that succeeded are
      // iterations.
      const settled = await Promise.allSettled(recorder.exchanges.map((e) => e.response));
      const iterations = settled.flatMap((r) =>
        r.status === "fulfilled" && r.value.status === 200 ? [r.value] : [],
      );
      const usages = iterations.map((wire: WireResponse) => AnthropicUsageSchema.parse(wire.usage));
      const thinkingBlocks = result.newMessages.flatMap((m) =>
        typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "thinking"),
      );

      const table = iterations.map((wire, i) => {
        const usage = expectDefined(usages[i], "usage");
        return {
          iteration: i + 1,
          input: usage.input_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheCreation: usage.cache_creation_input_tokens,
          created1h: usage.cache_creation.ephemeral_1h_input_tokens,
          created5m: usage.cache_creation.ephemeral_5m_input_tokens,
          diagnostics: JSON.stringify(wire.diagnostics ?? null),
        };
      });
      console.log(
        `${model}: ${result.iterations} iterations, tool calls ${JSON.stringify(calls)}, ` +
          `${thinkingBlocks.length} thinking blocks ` +
          `(${thinkingBlocks.filter((b) => b.type === "thinking" && b.thinking !== "").length} with text), ` +
          `reply ${JSON.stringify(result.text)}, turn usage ${JSON.stringify(result.usage)}`,
      );
      console.table(table);
      const diagnostics = (i: number): string =>
        `iteration ${i + 1} diagnostics: ${expectDefined(table[i], "row").diagnostics}`;

      // The scenario ran as designed: two sequential calls, three iterations.
      expect(result.degraded).toBeUndefined();
      expect(calls).toEqual(["start", "harbor"]);
      expect(result.iterations).toBe(3);
      expect(iterations).toHaveLength(3);
      expect(result.text).toContain("7291");

      const first = expectDefined(usages[0], "first iteration");
      expect(
        first.cache_read_input_tokens + first.cache_creation_input_tokens,
        "the first iteration's prefix must be cacheable, or every later check passes vacuously",
      ).toBeGreaterThan(MIN_CACHEABLE_TOKENS);

      for (const [i, usage] of usages.entries()) {
        const previous = usages[i - 1];
        if (previous) {
          expect(usage.cache_read_input_tokens, diagnostics(i)).toBe(
            previous.cache_read_input_tokens + previous.cache_creation_input_tokens,
          );
        }
        expect(usage.cache_creation.ephemeral_5m_input_tokens, diagnostics(i)).toBe(0);
      }

      // The loop's turn totals are the iterations' wire usage, cache included.
      expect(result.usage).toEqual({
        inputTokens: R.sumBy(
          usages,
          (u) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        ),
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: R.sumBy(usages, (u) => u.cache_read_input_tokens),
        cacheCreationTokens: R.sumBy(usages, (u) => u.cache_creation_input_tokens),
      });
    },
  );
});
