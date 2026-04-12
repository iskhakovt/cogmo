import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../llm/types.js";
import {
  type ExtractionDeps,
  extractCorrections,
  formatTranscript,
} from "./extract-corrections.js";

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
): ExtractionDeps {
  // Mock the chatTyped module
  const provider = {
    name: "mock",
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(chatTypedResponse) }],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    chatStream: vi.fn(),
    countTokens: vi.fn().mockResolvedValue(100),
  };

  return {
    provider,
    model: "test-model",
    store: {
      getCorrections: vi.fn().mockResolvedValue([]),
      upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: false }),
      countActiveRules: vi.fn().mockResolvedValue(5),
      ...storeOverrides,
    },
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
        },
      ],
    });

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.extracted).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith({
      rule: "Use fetch_url for weather lookups",
      category: "domain",
      profileId: null,
    });
  });

  it("reinforces existing correction", async () => {
    const deps = mockExtractionDeps({
      corrections: [
        {
          rule: "Use fetch_url for weather",
          category: "domain",
          reasoning: "Same correction again",
          matchedExistingRuleId: "existing-rule-1",
          action: "reinforce",
        },
      ],
    });

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.reinforced).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith({
      rule: "Use fetch_url for weather",
      category: "domain",
      profileId: null,
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
    const deps = mockExtractionDeps({
      corrections: [
        {
          rule: "New rule",
          category: "style",
          reasoning: "first time",
          matchedExistingRuleId: null,
          action: "new",
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
    });

    const result = await extractCorrections(sampleHistory, "profile-1", deps);

    expect(result.extracted).toBe(1);
    expect(result.reinforced).toBe(1);
    expect(result.contradictions).toBe(1);
    // 2 upsert calls (new + reinforce), contradiction skipped
    expect(deps.store.upsertCorrection).toHaveBeenCalledTimes(2);
  });
});
