import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import type { Message } from "../../llm/types.js";
import { mockProvider } from "../../test/factories.js";
import {
  type ExtractionDeps,
  extractCorrections,
  formatTranscript,
} from "./extract-corrections.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

// --- formatTranscript tests ---

describe("formatTranscript", () => {
  it("formats text messages", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    expect(formatTranscript(messages)).toBe("User: Hello\n\nAssistant: Hi there");
  });

  it("formats tool_use and tool_result blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "weather" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "tu_1", content: "22°C sunny" }],
      },
    ];
    const result = formatTranscript(messages);
    expect(result).toContain('[Tool: web_search({"query":"weather"})]');
    expect(result).toContain("→ 22°C sunny");
  });

  it("formats error tool results", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "tu_1", content: "Not found", isError: true }],
      },
    ];
    expect(formatTranscript(messages)).toContain("→ [Error] Not found");
  });

  it("strips thinking blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning", signature: "sig" },
          { type: "text", text: "Here's my answer" },
        ],
      },
    ];
    const result = formatTranscript(messages);
    expect(result).not.toContain("internal reasoning");
    expect(result).toContain("Here's my answer");
  });

  it("replaces images with placeholder", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", source: "base64", data: "abc", mediaType: "image/png" }],
      },
    ];
    expect(formatTranscript(messages)).toContain("[Image]");
  });

  it("skips messages with only stripped blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
      },
      { role: "assistant", content: "Visible" },
    ];
    expect(formatTranscript(messages)).toBe("Assistant: Visible");
  });
});

// --- extractCorrections tests ---

function mockExtractionDeps(
  chatTypedResponse: { corrections: Array<Record<string, unknown>> },
  storeOverrides?: Partial<ExtractionDeps["store"]>,
  activeChannelTypes: ReadonlyArray<string> = [],
): ExtractionDeps {
  const provider = mockProvider({
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(chatTypedResponse) }],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  });

  return {
    provider,
    model: "test-model",
    runInTx: fakeRunInTx,
    store: {
      getCorrections: vi.fn().mockResolvedValue([]),
      upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: false }),
      countActiveRules: vi.fn().mockResolvedValue(5),
      ...storeOverrides,
    },
    activeChannelTypes,
  };
}

const sampleHistory: Message[] = [
  { role: "user", content: "Search for weather" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me search." },
      { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "weather" } },
    ],
  },
  {
    role: "user",
    content: "No, use fetch_url for weather, not web_search.",
  },
  { role: "assistant", content: "Got it, I'll use fetch_url next time." },
];

describe("extractCorrections", () => {
  it("returns zeros when no corrections found", async () => {
    const deps = mockExtractionDeps({ corrections: [] });
    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result).toEqual({
      extracted: 0,
      reinforced: 0,
      contradictions: 0,
      promoted: 0,
      outOfScopeReinforcementsSkipped: 0,
      unknownRuleReinforcementsSkipped: 0,
      consolidationNeeded: false,
    });
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
  });

  it("inserts new correction", async () => {
    const deps = mockExtractionDeps({
      corrections: [
        {
          rule: "Use fetch_url for weather lookups",
          category: "domain",
          reasoning: "User corrected tool choice",
          matchedExistingRuleId: null,
          action: "new",
          channelType: null,
        },
      ],
    });

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.extracted).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Use fetch_url for weather lookups",
      category: "domain",
      profileId: null,
      channelType: null,
    });
  });

  it("reinforces existing correction", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Use fetch_url for weather",
            category: "domain",
            reasoning: "Same correction again",
            matchedExistingRuleId: "existing-rule-1",
            action: "reinforce",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "existing-rule-1",
            rule: "Use fetch_url for weather",
            category: "domain",
            active: true,
            observationCount: 1,
            channelType: null,
          },
        ]),
      },
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.reinforced).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Use fetch_url for weather",
      category: "domain",
      profileId: null,
      channelType: null,
      existingRuleId: "existing-rule-1",
    });
  });

  it("skips contradictions with a log", async () => {
    const deps = mockExtractionDeps({
      corrections: [
        {
          rule: "Always use web_search for lookups",
          category: "domain",
          reasoning: "Contradicts existing fetch_url preference",
          matchedExistingRuleId: "existing-rule-1",
          action: "contradiction",
        },
      ],
    });

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.contradictions).toBe(1);
    expect(result.extracted).toBe(0);
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
  });

  it("tracks promotions from upsertCorrection", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Be concise",
            category: "style",
            reasoning: "Second time seeing this",
            matchedExistingRuleId: "rule-1",
            action: "reinforce",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "rule-1",
            rule: "Be concise",
            category: "style",
            active: true,
            observationCount: 1,
            channelType: null,
          },
        ]),
        upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: true }),
      },
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.promoted).toBe(1);
    expect(result.reinforced).toBe(1);
  });

  it("flags consolidationNeeded when threshold exceeded", async () => {
    const deps = mockExtractionDeps(
      { corrections: [] },
      { countActiveRules: vi.fn().mockResolvedValue(31) },
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);
    expect(result.consolidationNeeded).toBe(true);
  });

  it("does not flag consolidation below threshold", async () => {
    const deps = mockExtractionDeps(
      { corrections: [] },
      { countActiveRules: vi.fn().mockResolvedValue(15) },
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);
    expect(result.consolidationNeeded).toBe(false);
  });

  it("handles mixed corrections in one extraction", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "New rule",
            category: "style",
            reasoning: "first time",
            matchedExistingRuleId: null,
            action: "new",
            channelType: null,
          },
          {
            rule: "Reinforced rule",
            category: "domain",
            reasoning: "seen before",
            matchedExistingRuleId: "rule-2",
            action: "reinforce",
          },
          {
            rule: "Contradicting rule",
            category: "style",
            reasoning: "conflicts",
            matchedExistingRuleId: "rule-3",
            action: "contradiction",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "rule-2",
            rule: "Reinforced rule",
            category: "domain",
            active: true,
            observationCount: 1,
            channelType: null,
          },
        ]),
      },
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.extracted).toBe(1);
    expect(result.reinforced).toBe(1);
    expect(result.contradictions).toBe(1);
    // 2 upsert calls (new + reinforce), contradiction skipped
    expect(deps.store.upsertCorrection).toHaveBeenCalledTimes(2);
  });

  it("stamps channelType from the LLM when it's in the active channel set", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Avoid voice notes longer than 60s",
            category: "style",
            reasoning: "Telegram-specific tone preference",
            matchedExistingRuleId: null,
            action: "new",
            channelType: "telegram",
          },
        ],
      },
      undefined,
      ["telegram", "direct"],
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.extracted).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Avoid voice notes longer than 60s",
      category: "style",
      profileId: null,
      channelType: "telegram",
    });
  });

  it("coerces an LLM-emitted channelType outside the active set back to null", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Hallucinated channel rule",
            category: "style",
            reasoning: "LLM picked a channel not in the active set",
            matchedExistingRuleId: null,
            action: "new",
            channelType: "slack",
          },
        ],
      },
      undefined,
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.extracted).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Hallucinated channel rule",
      category: "style",
      profileId: null,
      channelType: null,
    });
  });

  it("applies reinforce when the matched rule is global", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Be concise",
            category: "style",
            reasoning: "seen before, applies everywhere",
            matchedExistingRuleId: "rule-global",
            action: "reinforce",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "rule-global",
            rule: "Be concise",
            category: "style",
            active: true,
            observationCount: 1,
            channelType: null,
          },
        ]),
      },
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.reinforced).toBe(1);
    expect(result.outOfScopeReinforcementsSkipped).toBe(0);
    expect(result.unknownRuleReinforcementsSkipped).toBe(0);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Be concise",
      category: "style",
      profileId: null,
      channelType: null,
      existingRuleId: "rule-global",
    });
  });

  it("applies reinforce when the matched rule's channelType is in the active set", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Avoid markdown headings",
            category: "style",
            reasoning: "Telegram-specific, seen before",
            matchedExistingRuleId: "rule-tg",
            action: "reinforce",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "rule-tg",
            rule: "Avoid markdown headings",
            category: "style",
            active: true,
            observationCount: 1,
            channelType: "telegram",
          },
        ]),
      },
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.reinforced).toBe(1);
    expect(result.outOfScopeReinforcementsSkipped).toBe(0);
    expect(result.unknownRuleReinforcementsSkipped).toBe(0);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Avoid markdown headings",
      category: "style",
      profileId: null,
      channelType: null,
      existingRuleId: "rule-tg",
    });
  });

  it("skips reinforce when the matched rule's channelType is not in the active set", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Avoid markdown headings",
            category: "style",
            reasoning: "matched a Slack rule by wording, but conversation is Telegram",
            matchedExistingRuleId: "rule-slack",
            action: "reinforce",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "rule-slack",
            rule: "Avoid markdown headings",
            category: "style",
            active: true,
            observationCount: 1,
            channelType: "slack",
          },
        ]),
      },
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.reinforced).toBe(0);
    expect(result.outOfScopeReinforcementsSkipped).toBe(1);
    expect(result.unknownRuleReinforcementsSkipped).toBe(0);
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
  });

  it("skips reinforce when matched rule id is unknown to existingRules", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Be concise",
            category: "style",
            reasoning: "LLM hallucinated the matched id",
            matchedExistingRuleId: "rule-ghost",
            action: "reinforce",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([]),
      },
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.reinforced).toBe(0);
    expect(result.outOfScopeReinforcementsSkipped).toBe(0);
    expect(result.unknownRuleReinforcementsSkipped).toBe(1);
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
  });

  it("renders the existing rules and active channels in the prompt", async () => {
    const deps = mockExtractionDeps(
      { corrections: [] },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "rule-1",
            rule: "Be concise",
            category: "style",
            active: true,
            observationCount: 3,
            channelType: null,
          },
          {
            id: "rule-2",
            rule: "Avoid markdown headings on Telegram",
            category: "style",
            active: true,
            observationCount: 2,
            channelType: "telegram",
          },
        ]),
      },
      ["telegram"],
    );

    await extractCorrections(sampleHistory, "profile-1", deps);

    expect(deps.provider.chat).toHaveBeenCalledOnce();
    const call = vi.mocked(deps.provider.chat).mock.calls[0]?.[0];
    const system = call?.system ?? "";
    expect(system).toContain("`telegram`");
    expect(system).toContain("[rule-1] (style, all channels) Be concise");
    expect(system).toContain(
      "[rule-2] (style, channel:telegram) Avoid markdown headings on Telegram",
    );
  });

  it("instructs the LLM to default to null when no channels are active", async () => {
    const deps = mockExtractionDeps({ corrections: [] }, undefined, []);

    await extractCorrections(sampleHistory, "profile-1", deps);

    const call = vi.mocked(deps.provider.chat).mock.calls[0]?.[0];
    const system = call?.system ?? "";
    expect(system).toContain("No active channels were resolved");
  });

  it("skips extraction for empty transcript", async () => {
    const deps = mockExtractionDeps({ corrections: [] });
    const thinkingOnly: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
      },
    ];

    const result = await extractCorrections(thinkingOnly, "profile-1", deps);

    expect(result).toEqual({
      extracted: 0,
      reinforced: 0,
      contradictions: 0,
      promoted: 0,
      outOfScopeReinforcementsSkipped: 0,
      unknownRuleReinforcementsSkipped: 0,
      consolidationNeeded: false,
    });
    // chatTyped should not have been called
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("recovers a trailing-comma extraction response via chatTyped repair", async () => {
    // Regression: extract-corrections passes `repair: {}` into chatTyped, so
    // the jsonrepair pre-pass fixes a trailing comma in the structured-output
    // response without a feedback retry. Without repair this would crash the
    // extraction run.
    const provider = mockProvider({
      chat: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"corrections":[{"rule":"Use fetch_url for weather lookups","category":"domain","reasoning":"User correction","matchedExistingRuleId":null,"action":"new","channelType":null,},],}',
          },
        ],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const deps: ExtractionDeps = {
      provider,
      model: "test-model",
      runInTx: fakeRunInTx,
      store: {
        getCorrections: vi.fn().mockResolvedValue([]),
        upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: false }),
        countActiveRules: vi.fn().mockResolvedValue(5),
      },
      activeChannelTypes: [],
    };

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.extracted).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });
});
