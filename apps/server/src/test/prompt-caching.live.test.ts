/**
 * Live: the provider serves a multi-turn conversation from its cache when the
 * conversation is laid out the way `handle-message` lays it out — a system
 * prompt that doesn't change between turns, each turn's user message led by
 * its turn context, and every earlier message re-sent as the store hands it
 * back (design/prompt-caching.md → Test Plan → Live tier).
 *
 * Byte stability of the real pipeline is the integration tier's claim
 * (`prompt-caching.integration.test.ts`); this tier checks what replay can't:
 * that the provider reads the prefix. The conversation runs through
 * `runStreamingAgentLoop` on a real `AnthropicProvider` behind the wire
 * recorder, with the production prompt source, turn-context renderer, turn
 * cache intent and store-boundary parse of each persisted message:
 *
 * 1. A tool turn, the model emitting the tool input's keys out of canonical order.
 * 2. A turn whose context recalls a memory; 3. a follow-up whose context leaves
 *    it out, as deduplication does.
 * 4. A voice turn: only the context's reply modality changes. 5. A plain turn.
 *
 * - **A** — the production chat model (Sonnet 5): each request reads exactly
 *   what the one before it cached, within turns and across them.
 * - **B** — Opus 5.5 with preserved thinking enforced
 *   (`prefix_mismatch_behavior: "error"`), so any edit to the history under a
 *   replayed thinking block is a 400: the conversation completes, and no
 *   response reports an input transformation.
 * - **C** — TTL survival: turn 1, a six-and-a-half-minute wait that outlives a
 *   5-minute entry, then turn 2, whose first request reads turn 1's whole
 *   prefix.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A and B cost cents;
 * C takes about seven minutes.
 *
 *   LIVE=1 pnpm test:live src/test/prompt-caching.live.test.ts -t "B:|C:"
 */

import { randomUUID } from "node:crypto";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { BUILT_IN_SERVICE_GUIDANCE } from "../agent/built-ins.js";
import { runStreamingAgentLoop } from "../agent/loop.js";
import { DefaultPromptSource } from "../agent/prompt.js";
import type { Service } from "../agent/service.js";
import { defineTool, ToolRegistry } from "../agent/tools.js";
import { turnCacheIntent } from "../agent/turn-cache-intent.js";
import { renderTurnContext, withTurnContext } from "../agent/turn-context.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { type Message, MessageContentSchema } from "../llm/types.js";
import { logger } from "../logger.js";
import { DEFAULT_BASE_PROMPT } from "../setup/seed.js";
import { expectDefined } from "./assertions.js";
import { createWireRecorder, type WireRequestInit, type WireResponse } from "./wire-recorder.js";

// An empty `ANTHROPIC_API_KEY=` line in `.env` counts as unset.
const API_KEY = (process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY) || undefined;

const CHAT_MODEL = "claude-sonnet-5";
const ENFORCED_MODEL = "claude-opus-5-5";
/** Sonnet 5's minimum cacheable prefix, the larger of the two models'. */
const MIN_CACHEABLE_TOKENS = 1024;
const TIMEZONE = "Europe/London";
const FACT = "The user runs a three-node Proxmox cluster in their homelab.";
/** Outlives a 5-minute cache entry with margin. */
const TTL_WAIT_MS = 390_000;

interface Turn {
  text: string;
  recalledMemories: string[];
  voiceMode: boolean;
}

const TURNS: ReadonlyArray<Turn> = [
  {
    text: "Draw me a lighthouse on a rocky coast at dusk with the flux-dev model, then tell me in one sentence what you asked for.",
    recalledMemories: [],
    voiceMode: false,
  },
  { text: "What do you remember about my homelab?", recalledMemories: [FACT], voiceMode: false },
  {
    text: "Which hypervisor did I say it runs? One sentence.",
    recalledMemories: [],
    voiceMode: false,
  },
  { text: "Say goodnight to me in a few words.", recalledMemories: [], voiceMode: true },
  { text: "Thanks! Reply with one word.", recalledMemories: [], voiceMode: false },
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
type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>;

const DiagnosticsSchema = z.object({ cache_miss_reason: z.unknown().optional() }).nullish();

function drawTool(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(
    defineTool({
      name: "draw",
      description: "Generate an image from a text prompt.",
      schema: z.object({
        prompt: z.string().describe("What to draw."),
        model: z.enum(["flux-dev", "flux-pro"]).describe("The image model."),
      }),
      handler: async () => "Saved the image as lighthouse.png.",
    }),
  );
  return tools;
}

/** A message as the store hands it back: `messages.content` parses through its schema on read. */
function reloaded(message: Message): Message {
  return {
    role: message.role,
    content: MessageContentSchema.parse(JSON.parse(JSON.stringify(message.content))),
  };
}

interface Request {
  turn: number;
  wire: WireResponse;
  usage: AnthropicUsage;
  body: Record<string, unknown>;
}

/**
 * Run `turns` as one conversation, `beforeTurn` awaited ahead of each, and
 * return every model request that succeeded, tagged with its turn. `extra`
 * adds request fields and beta headers production doesn't send.
 */
async function converse(params: {
  model: string;
  turns: ReadonlyArray<Turn>;
  extra?: { betas?: ReadonlyArray<string>; body?: Record<string, unknown> };
  beforeTurn?: (turn: number) => Promise<void>;
}): Promise<Request[]> {
  const nonce = randomUUID();
  let previousMessageId: string | null = null;
  const recorder = createWireRecorder(undefined, {
    mutate: (_url, init): WireRequestInit => {
      const headers = new Headers(init.headers);
      if (params.extra?.betas) headers.set("anthropic-beta", params.extra.betas.join(","));
      return {
        headers,
        body: {
          ...init.body,
          ...params.extra?.body,
          diagnostics: { previous_message_id: previousMessageId },
        },
      };
    },
  });
  // The loop starts the next request once the previous stream ends, and the
  // recorder settles an exchange once it has read the whole body.
  const diagnosedFetch: typeof fetch = async (input, init) => {
    const last = recorder.exchanges.at(-1);
    const settled = last && (await last.response.catch(() => undefined));
    if (settled?.status === 200 && settled.id) previousMessageId = settled.id;
    return recorder.fetch(input, init);
  };
  const provider = new AnthropicProvider(expectDefined(API_KEY, "API key"), undefined, {
    fetch: diagnosedFetch,
  });
  const tools = drawTool();
  const systemPrompt = await new DefaultPromptSource({
    serviceGuidance: BUILT_IN_SERVICE_GUIDANCE,
  }).assemble({
    profile: {
      id: nonce,
      userId: null,
      name: "live",
      // The nonce keeps runs from reading each other's cache entries.
      basePrompt: `Session ${nonce}.\n\n${DEFAULT_BASE_PROMPT}`,
      model: params.model,
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: ["*"],
      memoryScope: null,
      profileClass: null,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
    },
    rules: [],
    coreMemory: [{ key: "user_profile", content: "Name: Sam. Lives in Lisbon." }],
    toolDefinitions: tools.definitions(),
  });

  const turnOf: number[] = [];
  let history: Message[] = [];
  for (const [i, turn] of params.turns.entries()) {
    await params.beforeTurn?.(i);
    const message = withTurnContext(
      { role: "user", content: turn.text },
      renderTurnContext({
        handledAt: new Date(),
        timezone: TIMEZONE,
        context: {
          recalledMemories: turn.recalledMemories,
          voiceMode: turn.voiceMode,
          channelTypes: [],
          announcedCoreMemoryBlocks: [],
        },
      }),
    );
    const before = recorder.exchanges.length;
    const result = await runStreamingAgentLoop({
      provider,
      model: params.model,
      systemPrompt,
      messages: [...history, message],
      tools,
      service: mock<Service>(),
      maxTokens: 16000,
      onEvent: async () => {},
      cache: turnCacheIntent(nonce),
      turnLogger: logger,
    });
    expect(result.degraded, `turn ${i + 1} degraded`).toBeUndefined();
    turnOf.push(...Array.from({ length: recorder.exchanges.length - before }, () => i + 1));
    history = [...history, message, ...result.newMessages.map(reloaded)];
  }

  // The SDK retries overloads and dropped connections; each attempt is its own
  // exchange, and only those that succeeded are requests the loop made.
  const requests: Request[] = [];
  for (const [i, exchange] of recorder.exchanges.entries()) {
    const wire = await exchange.response;
    expect(wire.status, `request ${i + 1}: ${JSON.stringify(wire.diagnostics)}`).not.toBe(400);
    if (wire.status !== 200) continue;
    requests.push({
      turn: expectDefined(turnOf[i], "turn of request"),
      wire,
      usage: AnthropicUsageSchema.parse(wire.usage),
      body: expectDefined(exchange.request.body, "request body"),
    });
  }
  console.log(`${params.model}:`);
  console.table(
    requests.map((r, i) => ({
      request: i + 1,
      turn: r.turn,
      input: r.usage.input_tokens,
      cacheRead: r.usage.cache_read_input_tokens,
      cacheCreation: r.usage.cache_creation_input_tokens,
      created1h: r.usage.cache_creation.ephemeral_1h_input_tokens,
      created5m: r.usage.cache_creation.ephemeral_5m_input_tokens,
      missReason: JSON.stringify(
        DiagnosticsSchema.parse(r.wire.diagnostics)?.cache_miss_reason ?? null,
      ),
    })),
  );
  return requests;
}

/** For every request after the first: it reads exactly what the one before it read and wrote. */
function expectEachReadsThePrevious(requests: ReadonlyArray<Request>): void {
  const first = expectDefined(requests[0], "first request").usage;
  expect(
    first.cache_read_input_tokens + first.cache_creation_input_tokens,
    "the first request's prefix must be cacheable, or every later check passes vacuously",
  ).toBeGreaterThan(MIN_CACHEABLE_TOKENS);
  for (const [i, request] of requests.entries()) {
    const previous = requests[i - 1];
    if (previous === undefined) continue;
    expect(
      request.usage.cache_read_input_tokens,
      `request ${i + 1} (turn ${request.turn}) diagnostics: ${JSON.stringify(request.wire.diagnostics)}`,
    ).toBe(previous.usage.cache_read_input_tokens + previous.usage.cache_creation_input_tokens);
  }
}

describe.skipIf(API_KEY === undefined)("prompt caching across turns (live)", () => {
  it("A: on the chat model, each request reads exactly what the one before it cached", {
    timeout: 600_000,
  }, async () => {
    const requests = await converse({ model: CHAT_MODEL, turns: TURNS });

    expect(new Set(requests.map((r) => r.turn)).size).toBe(TURNS.length);
    expect(requests.filter((r) => r.turn === 1).length).toBeGreaterThanOrEqual(2);
    expectEachReadsThePrevious(requests);
    for (const request of requests) {
      expect(request.usage.cache_creation.ephemeral_5m_input_tokens).toBe(0);
    }
  });

  it("B: with preserved thinking enforced, replaying every earlier turn is never an edit", {
    timeout: 600_000,
  }, async () => {
    const requests = await converse({
      model: ENFORCED_MODEL,
      turns: TURNS,
      extra: {
        betas: ["thinking-binding-controls-2026-08-01"],
        body: {
          thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
        },
      },
    });

    // Every request succeeded (a history edit under a thinking block is a 400)
    // and nothing was dropped.
    expect(new Set(requests.map((r) => r.turn)).size).toBe(TURNS.length);
    for (const [i, request] of requests.entries()) {
      expect(request.wire.inputTransformations, `request ${i + 1}`).toEqual([]);
    }
    // Non-vacuity: later requests replayed thinking blocks from earlier turns.
    const last = expectDefined(requests.at(-1), "last request");
    const replayedThinking = JSON.stringify(last.body.messages).match(/"type":"thinking"/g) ?? [];
    expect(replayedThinking.length).toBeGreaterThan(0);
    console.log(
      `${ENFORCED_MODEL}: ${requests.length} requests, ${replayedThinking.length} thinking blocks replayed in the last; ` +
        `reads ${R.sumBy(requests, (r) => r.usage.cache_read_input_tokens)}, ` +
        `writes ${R.sumBy(requests, (r) => r.usage.cache_creation_input_tokens)}, ` +
        `uncached ${R.sumBy(requests, (r) => r.usage.input_tokens)}`,
    );
  });

  it("C: the next turn reads the prefix after a gap that outlives a 5-minute entry", {
    timeout: 900_000,
  }, async () => {
    const requests = await converse({
      model: CHAT_MODEL,
      turns: TURNS.slice(0, 2),
      beforeTurn: async (turn) => {
        if (turn === 1) await new Promise((resolve) => setTimeout(resolve, TTL_WAIT_MS));
      },
    });

    const lastOfTurn1 = expectDefined(
      requests.findLast((r) => r.turn === 1),
      "turn 1's last request",
    );
    const firstOfTurn2 = expectDefined(
      requests.find((r) => r.turn === 2),
      "turn 2's first request",
    );
    expect(
      firstOfTurn2.usage.cache_read_input_tokens,
      `diagnostics: ${JSON.stringify(firstOfTurn2.wire.diagnostics)}`,
    ).toBe(
      lastOfTurn1.usage.cache_read_input_tokens + lastOfTurn1.usage.cache_creation_input_tokens,
    );
    expect(firstOfTurn2.usage.cache_read_input_tokens).toBeGreaterThan(MIN_CACHEABLE_TOKENS);
  });
});
