/**
 * Live: the OpenAI-compatible adapter's cache dialects against the real
 * endpoints — scenario D of design/prompt-caching.md → Test Plan → Live tier,
 * at the adapter level.
 *
 * Replay can't show this: only the real endpoint decides what it serves from
 * cache. A growing three-request conversation goes through
 * `OpenAICompatibleProvider` with a `long` cache intent and the wire recorder,
 * once per route:
 *
 * - OpenRouter → Claude: each request reads exactly what the one before it
 *   cached (scenario A's relation), allowing one miss in case OpenRouter moves
 *   the conversation to another upstream.
 * - OpenRouter → xAI, and OpenAI direct: best-effort caches, so from the
 *   second request on the read covers most of the previous prompt, and a
 *   request that misses is repeated once before the test fails.
 * - OpenRouter → Gemini: the system marker's entry, which the first request
 *   writes, is read by every later one.
 *
 * Each route is skipped unless `LIVE=1` and its key (`OPENROUTER_API_KEY`,
 * `OPENAI_API_KEY`) are set. A run costs a few cents: the Claude route writes
 * one ~5k-token entry at the 1-hour rate, the others read at their discount.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live
 */

import { randomUUID } from "node:crypto";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { createWireRecorder, type WireRecorder } from "../test/wire-recorder.js";
import type { CacheDialect } from "./cache-dialect.js";
import { OpenAICompatibleProvider } from "./openai-compat.js";
import type { ChatParams, Message, Usage } from "./types.js";

// An empty key line in `.env` counts as unset.
function liveKey(name: string): string | undefined {
  return (process.env.LIVE === "1" && process.env[name]) || undefined;
}

/** Above every route's minimum cacheable prefix (1,024 tokens for each here). */
const MIN_CACHEABLE_TOKENS = 1024;

/** "Most of the previous prompt", for the best-effort caches. */
const TOLERANT_SHARE = 0.8;

const PROMPTS = [
  "Reply with one word: what colour is the sky on a clear day?",
  "Reply with one word: what is frozen water called?",
  "Reply with one word: which animal says moo?",
];

const ChatUsageSchema = z.object({
  prompt_tokens: z.number(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.number().nullish(),
      cache_write_tokens: z.number().nullish(),
    })
    .nullish(),
});

const SystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.union([z.string(), z.array(z.object({ cache_control: z.unknown() }).partial())]),
});
const BodySchema = z.object({ messages: z.array(z.unknown()).min(1) }).passthrough();

/**
 * A system prompt well above the minimum cacheable prefix (~4–5k tokens,
 * depending on the tokenizer). The nonce opens it, so no earlier run's entry
 * can match past its first line.
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
    "You are a terse assistant. Answer every question with a single word.",
    "House rules follow.",
    ...rules,
  ].join("\n");
}

interface Measured {
  body: z.infer<typeof BodySchema>;
  prompt: number;
  cached: number;
  written: number;
  reported: Usage;
}

/** Send one streamed request; measure the attempt that succeeded (the SDK retries the rest). */
async function send(
  provider: OpenAICompatibleProvider,
  recorder: WireRecorder,
  params: ChatParams,
): Promise<{ measured: Measured; text: string }> {
  const before = recorder.exchanges.length;
  const { events, response } = provider.chatStream(params);
  // A failed request rejects both; the events loop is the one that throws.
  response.catch(() => {});
  let text = "";
  for await (const event of events) {
    if (event.type === "text_delta") text += event.text;
  }
  const { usage: reported } = await response;

  const attempts = recorder.exchanges.slice(before);
  const settled = await Promise.all(
    attempts.map((e) => e.response.then((wire) => ({ request: e.request, wire }))),
  );
  const last = expectDefined(
    settled.findLast(({ wire }) => wire.status === 200),
    "successful exchange",
  );
  const usage = ChatUsageSchema.parse(last.wire.usage);
  return {
    text,
    measured: {
      body: BodySchema.parse(last.request.body),
      prompt: usage.prompt_tokens,
      cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
      written: usage.prompt_tokens_details?.cache_write_tokens ?? 0,
      reported,
    },
  };
}

/** How a route's cache is expected to behave across the conversation. */
type Relation =
  /** `cached(n) = cached(n−1) + written(n−1)`, one miss allowed. */
  | "exact"
  /** `cached(n) ≥ 80% of prompt(n−1)` from the second request, one repeat per miss. */
  | "best-effort"
  /** `cached(n) ≥ written(1)`: the system prompt's entry is read by every later request. */
  | "system-entry";

interface Route {
  label: string;
  dialect: CacheDialect;
  baseURL: string;
  apiKey: string | undefined;
  model: string;
  relation: Relation;
  /** What the dialect must have put on the wire. */
  expectWire(body: Measured["body"], key: string): void;
}

function systemMarker(body: Measured["body"]): unknown {
  const { content } = SystemMessageSchema.parse(body.messages[0]);
  return typeof content === "string" ? undefined : content[0]?.cache_control;
}

const OPENROUTER = "https://openrouter.ai/api/v1";

const ROUTES: Route[] = [
  {
    label: "OpenRouter → Claude",
    dialect: "openrouter",
    baseURL: OPENROUTER,
    apiKey: liveKey("OPENROUTER_API_KEY"),
    model: "anthropic/claude-sonnet-5",
    relation: "exact",
    expectWire(body, key) {
      expect(body.session_id).toBe(key);
      expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(systemMarker(body)).toEqual({ type: "ephemeral", ttl: "1h" });
    },
  },
  {
    label: "OpenRouter → xAI",
    dialect: "openrouter",
    baseURL: OPENROUTER,
    apiKey: liveKey("OPENROUTER_API_KEY"),
    model: "x-ai/grok-4.3",
    relation: "best-effort",
    expectWire(body, key) {
      expect(body.session_id).toBe(key);
      expect(body).not.toHaveProperty("cache_control");
      expect(systemMarker(body)).toBeUndefined();
    },
  },
  {
    label: "OpenRouter → Gemini",
    dialect: "openrouter",
    baseURL: OPENROUTER,
    apiKey: liveKey("OPENROUTER_API_KEY"),
    model: "google/gemini-2.5-flash",
    relation: "system-entry",
    expectWire(body, key) {
      expect(body.session_id).toBe(key);
      expect(body).not.toHaveProperty("cache_control");
      expect(systemMarker(body)).toEqual({ type: "ephemeral" });
    },
  },
  {
    label: "OpenAI",
    dialect: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: liveKey("OPENAI_API_KEY"),
    // The adapter sends `max_tokens`, which OpenAI's reasoning models
    // (GPT-5 and later) reject; GPT-4.1 takes it and caches from 1,024 tokens.
    model: "gpt-4.1-nano",
    relation: "best-effort",
    expectWire(body, key) {
      expect(body.prompt_cache_key).toBe(key);
      expect(body).not.toHaveProperty("session_id");
    },
  },
];

/** Whether request `n` read enough of the conversation's cache for the route. */
function reads(relation: Relation, measured: ReadonlyArray<Measured>, n: number): boolean {
  const current = expectDefined(measured[n], "current request");
  const previous = expectDefined(measured[n - 1], "previous request");
  const first = expectDefined(measured[0], "first request");
  switch (relation) {
    case "exact":
      return current.cached === previous.cached + previous.written;
    case "best-effort":
      return current.cached >= TOLERANT_SHARE * previous.prompt;
    case "system-entry":
      return current.cached >= first.written;
  }
}

describe("OpenAICompatibleProvider cache dialects (live)", () => {
  for (const route of ROUTES) {
    it.skipIf(route.apiKey === undefined)(
      `${route.label}: later requests read the conversation's cache`,
      async () => {
        const key = randomUUID();
        const recorder = createWireRecorder();
        const provider = new OpenAICompatibleProvider(route.label, {
          apiKey: expectDefined(route.apiKey, "API key"),
          baseURL: route.baseURL,
          cacheDialect: route.dialect,
          fetch: recorder.fetch,
        });

        const system = systemPrompt(key);
        const messages: Message[] = [];
        const measured: Measured[] = [];
        let repeats = 0;
        for (const prompt of PROMPTS) {
          messages.push({ role: "user", content: prompt });
          const params: ChatParams = {
            model: route.model,
            system,
            messages: [...messages],
            maxTokens: 300,
            cache: { key, retention: "long" },
          };
          let sent = await send(provider, recorder, params);
          measured.push(sent.measured);
          const n = measured.length - 1;
          if (route.relation === "best-effort" && n > 0 && !reads(route.relation, measured, n)) {
            // A best-effort cache can miss an immediate repeat; send it once more.
            repeats += 1;
            sent = await send(provider, recorder, params);
            measured[n] = sent.measured;
          }
          messages.push({ role: "assistant", content: sent.text.trim() || "OK." });
        }

        console.log(`${route.label} (${route.model}): ${repeats} repeated request(s)`);
        console.table(
          measured.map((m, i) => ({
            request: i + 1,
            prompt: m.prompt,
            cached: m.cached,
            written: m.written,
          })),
        );

        for (const m of measured) {
          route.expectWire(m.body, key);
          // The adapter reports the whole prompt, with the cache as subsets.
          expect(m.reported.inputTokens).toBe(m.prompt);
          expect(m.reported.cacheReadTokens ?? 0).toBe(m.cached);
          expect(m.reported.cacheCreationTokens ?? 0).toBe(m.written);
        }

        const first = expectDefined(measured[0], "first request");
        expect(
          first.prompt,
          "the prompt must be cacheable, or every later check passes vacuously",
        ).toBeGreaterThan(MIN_CACHEABLE_TOKENS);
        if (route.relation === "system-entry") {
          expect(
            first.written,
            "the first request writes the system prompt's entry",
          ).toBeGreaterThan(MIN_CACHEABLE_TOKENS);
        }

        // Only the exact relation tolerates a miss: an upstream switch on
        // OpenRouter, which the next request reads past.
        const misses = R.range(1, measured.length).filter(
          (n) => !reads(route.relation, measured, n),
        );
        expect(
          misses.length,
          `requests that missed: ${misses.map((n) => n + 1).join(", ")}`,
        ).toBeLessThanOrEqual(route.relation === "exact" ? 1 : 0);
        expect(
          R.sumBy(measured.slice(1), (m) => m.cached),
          "later requests read the cache at all",
        ).toBeGreaterThan(0);
      },
    );
  }
});
