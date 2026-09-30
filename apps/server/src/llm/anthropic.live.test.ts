/**
 * Live: Anthropic prompt caching through the adapter — the within-turn
 * relation of scenario A in design/prompt-caching.md → Test Plan → Live tier —
 * and the count endpoint under the request controls production sends.
 *
 * Replay can't show this: llmock replays Anthropic usage without the cache
 * fields, and only the real endpoint decides what it serves from cache. A
 * growing three-request conversation goes through `AnthropicProvider` with a
 * `long` cache intent and the wire recorder, and every request must read
 * exactly what the one before it cached.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. Costs a few cents:
 * one ~5k-token cache write at the 1-hour rate, then reads. Counting is free.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live
 */

import { randomUUID } from "node:crypto";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_PROFILE_MODEL } from "../setup/seed.js";
import { expectDefined } from "../test/assertions.js";
import { createWireRecorder, type WireResponse } from "../test/wire-recorder.js";
import { AnthropicProvider } from "./anthropic.js";
import type { Message, ToolDefinition, ToolResultClearing, Usage } from "./types.js";

// An empty `ANTHROPIC_API_KEY=` line in `.env` counts as unset.
const API_KEY = (process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY) || undefined;

/** The production chat model. */
const MODEL = DEFAULT_PROFILE_MODEL;

/** Above the model's minimum cacheable prefix (Sonnet 5.5: 512, Sonnet 5: 1,024), tools and system included. */
const MIN_CACHEABLE_TOKENS = 1024;

const PROMPTS = [
  "Reply with one word: what colour is the sky on a clear day?",
  "Reply with one word: what is frozen water called?",
  "Reply with one word: which animal says moo?",
];

const TOOLS: ToolDefinition[] = [
  {
    name: "lookup_rule",
    description: "Look up one of the numbered house rules by its number.",
    parameters: {
      type: "object",
      properties: { number: { type: "integer", description: "The rule number." } },
      required: ["number"],
    },
  },
];

const AnthropicUsageSchema = z.object({
  input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
  cache_creation: z.object({
    ephemeral_5m_input_tokens: z.number(),
    ephemeral_1h_input_tokens: z.number(),
  }),
});

/**
 * A system prompt well above the minimum cacheable prefix (~5k tokens on
 * Sonnet 5). The nonce opens it, so no earlier run's entry can match past its
 * first line. Tools render before the system prompt, and `TOOLS` alone stays
 * far below the minimum, so the tools marker never writes an entry of its own
 * for a later run to read. A tool set near the minimum needs the nonce in a
 * tool description instead.
 */
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
    "You are a terse assistant. Answer every question with a single word and never call a tool.",
    "House rules follow.",
    ...rules,
  ].join("\n");
}

interface Measured {
  wire: WireResponse;
  usage: z.infer<typeof AnthropicUsageSchema>;
  reported: Usage;
}

describe.skipIf(API_KEY === undefined)("AnthropicProvider prompt caching (live)", () => {
  it("each request reads exactly what the one before it cached", async () => {
    const nonce = randomUUID();
    // Cache diagnostics: a fingerprint is stored only for requests that carry
    // the object, so it goes on every one — `null` first, then the id of the
    // response before.
    let previousMessageId: string | null = null;
    const recorder = createWireRecorder(undefined, {
      mutate: (_url, init) => ({
        headers: init.headers,
        body: { ...init.body, diagnostics: { previous_message_id: previousMessageId } },
      }),
    });
    const provider = new AnthropicProvider(expectDefined(API_KEY, "API key"), undefined, {
      fetch: recorder.fetch,
    });

    const system = systemPrompt(nonce);
    const messages: Message[] = [];
    const measured: Measured[] = [];
    for (const prompt of PROMPTS) {
      messages.push({ role: "user", content: prompt });
      let text = "";
      let done: Usage | undefined;
      for await (const frame of provider.chatStream({
        model: MODEL,
        system,
        messages: [...messages],
        tools: TOOLS,
        maxTokens: 300,
        cache: { key: nonce, retention: "long" },
      })) {
        if (frame.type === "text_delta") text += frame.text;
        if (frame.type === "done") done = frame.meta.usage;
      }
      const reported = expectDefined(done, "done frame");

      // The SDK retries overloads, rate limits and dropped connections; each
      // attempt is its own exchange, and the one that counts is the last to
      // succeed.
      const settled = await Promise.allSettled(recorder.exchanges.map((e) => e.response));
      const succeeded = settled.flatMap((r) =>
        r.status === "fulfilled" && r.value.status === 200 ? [r.value] : [],
      );
      const wire = expectDefined(succeeded.at(-1), "successful response");
      previousMessageId = wire.id ?? null;
      measured.push({ wire, usage: AnthropicUsageSchema.parse(wire.usage), reported });

      // The reply goes back as text: its bytes are fixed from here on, which
      // is all the cache needs, and dropping any thinking block avoids
      // replaying one the output cap cut short.
      messages.push({ role: "assistant", content: text.trim() || "OK." });
    }

    const table = measured.map(({ usage, wire }, i) => ({
      request: i + 1,
      input: usage.input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheCreation: usage.cache_creation_input_tokens,
      created1h: usage.cache_creation.ephemeral_1h_input_tokens,
      created5m: usage.cache_creation.ephemeral_5m_input_tokens,
      diagnostics: JSON.stringify(wire.diagnostics ?? null),
    }));
    console.table(table);
    const diagnostics = (i: number): string =>
      `request ${i + 1} diagnostics: ${expectDefined(table[i], "row").diagnostics}`;

    const first = expectDefined(measured[0], "first request").usage;
    expect(
      first.cache_read_input_tokens + first.cache_creation_input_tokens,
      "the first request's prefix must be cacheable, or every later check passes vacuously",
    ).toBeGreaterThan(MIN_CACHEABLE_TOKENS);

    for (const [i, { usage, reported }] of measured.entries()) {
      const previous = measured[i - 1]?.usage;
      if (previous) {
        expect(usage.cache_read_input_tokens, diagnostics(i)).toBe(
          previous.cache_read_input_tokens + previous.cache_creation_input_tokens,
        );
      }
      // Every marker in the request carries the intent's 1-hour TTL.
      expect(usage.cache_creation.ephemeral_1h_input_tokens, diagnostics(i)).toBe(
        usage.cache_creation_input_tokens,
      );
      expect(usage.cache_creation.ephemeral_5m_input_tokens, diagnostics(i)).toBe(0);
      // The adapter reports the whole prompt, with the cache as subsets.
      expect(reported).toEqual({
        inputTokens:
          usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
        outputTokens: reported.outputTokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
      });
    }

    const sent = recorder.exchanges.map((e) => e.request.body);
    for (const body of sent) {
      expect(body?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    }
  });

  it("counts after the edit intent's clearing, with the binding controls on", async () => {
    const recorder = createWireRecorder();
    // As a provider row with `prefixMismatchBehavior` configures it: the model
    // runs the prefix check, so the count carries `block_binding` too.
    const provider = new AnthropicProvider(expectDefined(API_KEY, "API key"), undefined, {
      fetch: recorder.fetch,
      prefixMismatchBehavior: "error",
    });
    const log = R.times(200, (i) => `line ${i + 1}: rule ${i + 1} reads as expected`).join("\n");
    const params = {
      model: MODEL,
      system: systemPrompt(randomUUID()),
      messages: [
        { role: "user", content: "Look up rule 7." },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "lookup_rule", input: { number: 7 } }],
        },
        { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: log }] },
        { role: "assistant", content: "Rule 7 reads as expected." },
        { role: "user", content: "Thanks." },
      ] satisfies Message[],
      tools: TOOLS,
    };
    const clearing: ToolResultClearing = { triggerTokens: 1000, keep: 0, clearAtLeastTokens: 500 };

    const uncleared = await provider.countTokens(params);
    const cleared = await provider.countTokens({ ...params, clearToolResults: clearing });
    const underTrigger = await provider.countTokens({
      ...params,
      clearToolResults: { ...clearing, triggerTokens: 1_000_000 },
    });
    console.log({ uncleared, cleared, underTrigger });

    expect(cleared).toBeLessThan(uncleared - 500);
    expect(underTrigger).toBe(uncleared);
    const [, withIntent] = recorder.exchanges;
    const request = expectDefined(withIntent, "the count with the intent").request;
    expect(request.headers["anthropic-beta"]?.split(",")).toEqual(
      expect.arrayContaining([
        "context-management-2025-06-27",
        "thinking-binding-controls-2026-08-01",
      ]),
    );
    expect(request.body?.thinking).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "error" },
    });
  });
});
