import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import type { Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import { expectDefined } from "../../test/assertions.js";
import { mockProvider } from "../../test/factories.js";
import {
  type ExtractionDeps,
  extractCorrections,
  formatTranscript,
} from "./extract-corrections.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

/** A global style rule as `getCorrections` returns it. */
function ruleRow(id: string, rule: string) {
  return {
    id,
    rule,
    category: "style",
    active: true,
    observationCount: 1,
    priority: 100,
    channelType: null,
  };
}

/** Two global rules whose ids look nothing like the labels the prompt gives them. */
const LABELLED_RULES = [
  {
    id: "rule-a",
    rule: "Be concise",
    category: "style",
    active: true,
    observationCount: 2,
    priority: 100,
    channelType: null,
  },
  {
    id: "rule-b",
    rule: "Keep replies short",
    category: "style",
    active: false,
    observationCount: 1,
    priority: 100,
    channelType: null,
  },
];

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
      getInstructionRules: vi.fn().mockResolvedValue([]),
      hasInstructionRule: vi.fn().mockResolvedValue(false),
      upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: false }),
      retireLearningRule: vi.fn().mockResolvedValue(true),
      countActiveLearnedRules: vi.fn().mockResolvedValue(5),
      ...storeOverrides,
    },
    activeChannelTypes,
  };
}

const SCOPE = { profileId: "profile-1", userId: "user-1", seesUserRules: true };

/** A live instruction rule as `getInstructionRules` returns it. */
function instructionRow(id: string, rule: string, observationCount = 1) {
  return { ...ruleRow(id, rule), observationCount };
}

/** A learned rule still learning, as `getCorrections` returns it. */
function learningRow(id: string, rule: string, channelType: string | null = null) {
  return { ...ruleRow(id, rule), active: false, channelType };
}

function contradiction(label: string) {
  return {
    corrections: [
      {
        rule: "Bullet points are fine",
        category: "style",
        reasoning: "The user takes it back",
        matchedExistingRuleId: label,
        action: "contradiction",
      },
    ],
  };
}

function systemPromptOf(deps: ExtractionDeps): string {
  const call = expectDefined(vi.mocked(deps.provider.chat).mock.calls[0], "chat call");
  return call[0].system;
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
    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result).toEqual({
      extracted: 0,
      reinforced: 0,
      contradictions: 0,
      retired: 0,
      promoted: 0,
      outOfScopeReinforcementsSkipped: 0,
      outOfScopeContradictionsSkipped: 0,
      unknownRuleReinforcementsSkipped: 0,
      consolidationNeeded: false,
    });
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
  });

  describe("rules the user set", () => {
    it("shows a third-party profile's model none of the user's instruction rules", async () => {
      const deps = mockExtractionDeps(
        { corrections: [] },
        {
          getCorrections: vi.fn().mockResolvedValue([ruleRow("learned", "Be concise")]),
          getInstructionRules: vi
            .fn()
            .mockResolvedValue([instructionRow("mine", "Don't use bullet points")]),
        },
      );

      await extractCorrections(sampleHistory, { ...SCOPE, seesUserRules: false }, deps);

      expect(deps.store.getInstructionRules).not.toHaveBeenCalled();
      const system = systemPromptOf(deps);
      expect(system).toContain("Be concise");
      expect(system).not.toContain("Don't use bullet points");
      expect(system).not.toContain(", set by the user)");
    });

    it("lists the user's instruction rules the profile sees, marked as set by the user", async () => {
      const deps = mockExtractionDeps(
        { corrections: [] },
        {
          getCorrections: vi.fn().mockResolvedValue([ruleRow("learned", "Be concise")]),
          getInstructionRules: vi
            .fn()
            .mockResolvedValue([instructionRow("mine", "Don't use bullet points")]),
        },
      );

      await extractCorrections(sampleHistory, SCOPE, deps);

      expect(deps.store.getInstructionRules).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ profileId: "profile-1", userId: "user-1" }),
      );
      const system = systemPromptOf(deps);
      expect(system).toContain("[R1] (style, all channels) Be concise");
      expect(system).toContain(
        "[R2] (style, all channels, set by the user) Don't use bullet points",
      );
    });

    it("tells the model a successful rule tool call is handled, and an already-set rule reinforced", async () => {
      const deps = mockExtractionDeps(
        { corrections: [] },
        {
          getInstructionRules: vi
            .fn()
            .mockResolvedValue([instructionRow("mine", "Don't use bullet points")]),
        },
      );

      await extractCorrections(sampleHistory, SCOPE, deps);

      const system = systemPromptOf(deps);
      expect(system).toContain(
        "An instruction or retraction that a successful `rule_set` or `rule_remove` call recorded is handled: extract nothing for it.",
      );
      expect(system).toContain(
        'When `rule_set` answered that the rule is already set, the user had to say it again: "reinforce" the rule marked "set by the user" that it names.',
      );
    });

    it("defines the memory category as what the assistant remembers, tracks or must not store", async () => {
      const deps = mockExtractionDeps({ corrections: [] });

      await extractCorrections(sampleHistory, SCOPE, deps);

      expect(systemPromptOf(deps)).toContain(
        '"memory": What the assistant remembers, tracks or must not store',
      );
    });

    it("reinforces an instruction rule by its label, counting no promotion", async () => {
      const deps = mockExtractionDeps(
        {
          corrections: [
            {
              rule: "Don't use bullet points",
              category: "style",
              reasoning: "Stated again",
              matchedExistingRuleId: "R1",
              action: "reinforce",
            },
          ],
        },
        {
          getInstructionRules: vi
            .fn()
            .mockResolvedValue([instructionRow("mine", "Don't use bullet points")]),
        },
      );

      const result = await extractCorrections(sampleHistory, SCOPE, deps);

      expect(result).toMatchObject({ reinforced: 1, promoted: 0 });
      expect(deps.store.upsertCorrection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ existingRuleId: "mine" }),
      );
    });

    it("drops a new correction an instruction rule holds in its scope, with a warning", async () => {
      const deps = mockExtractionDeps(
        {
          corrections: [
            {
              rule: "No emojis",
              category: "style",
              reasoning: "The user asked",
              matchedExistingRuleId: null,
              action: "new",
              channelType: "telegram",
            },
          ],
        },
        { hasInstructionRule: vi.fn().mockResolvedValue(true) },
        ["telegram"],
      );
      const warn = vi.spyOn(logger, "warn");

      const result = await extractCorrections(sampleHistory, SCOPE, deps);

      expect(result.extracted).toBe(0);
      expect(deps.store.hasInstructionRule).toHaveBeenCalledWith(expect.anything(), {
        userId: "user-1",
        text: "No emojis",
        profileId: null,
        channelType: "telegram",
      });
      expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ rule: "No emojis" }),
        expect.stringContaining("instruction rule"),
      );
      warn.mockRestore();
    });

    it("checks the backstop in the scope the rule would be written to, after channel coercion", async () => {
      const deps = mockExtractionDeps(
        {
          corrections: [
            {
              rule: "No emojis",
              category: "style",
              reasoning: "The user asked",
              matchedExistingRuleId: null,
              action: "new",
              channelType: "slack",
            },
          ],
        },
        undefined,
        ["web"],
      );

      const result = await extractCorrections(sampleHistory, SCOPE, deps);

      expect(result.extracted).toBe(1);
      expect(deps.store.hasInstructionRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ text: "No emojis", channelType: null }),
      );
    });

    it("checks the backstop against the user's rules even when the model doesn't see them", async () => {
      const deps = mockExtractionDeps(
        {
          corrections: [
            {
              rule: "No emojis",
              category: "style",
              reasoning: "The user asked",
              matchedExistingRuleId: null,
              action: "new",
              channelType: null,
            },
          ],
        },
        { hasInstructionRule: vi.fn().mockResolvedValue(true) },
      );

      const result = await extractCorrections(
        sampleHistory,
        { ...SCOPE, seesUserRules: false },
        deps,
      );

      expect(result.extracted).toBe(0);
    });
  });

  describe("a contradiction", () => {
    it("retires a rule still learning", async () => {
      const deps = mockExtractionDeps(contradiction("R1"), {
        getCorrections: vi.fn().mockResolvedValue([learningRow("learning", "Use bullet points")]),
      });

      const result = await extractCorrections(sampleHistory, SCOPE, deps);

      expect(result).toMatchObject({ contradictions: 1, retired: 1, extracted: 0 });
      expect(deps.store.retireLearningRule).toHaveBeenCalledWith(expect.anything(), "learning");
      expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
    });

    it("only logs one against an active learned rule or an instruction rule", async () => {
      for (const store of [
        { getCorrections: vi.fn().mockResolvedValue([ruleRow("active", "Use bullet points")]) },
        {
          getInstructionRules: vi
            .fn()
            .mockResolvedValue([instructionRow("mine", "Use bullet points")]),
        },
      ]) {
        const deps = mockExtractionDeps(contradiction("R1"), store);

        const result = await extractCorrections(sampleHistory, SCOPE, deps);

        expect(result).toMatchObject({ contradictions: 1, retired: 0 });
        expect(deps.store.retireLearningRule).not.toHaveBeenCalled();
      }
    });

    it("leaves a learning rule scoped to a channel the conversation isn't on", async () => {
      const deps = mockExtractionDeps(
        contradiction("R1"),
        {
          getCorrections: vi
            .fn()
            .mockResolvedValue([learningRow("learning", "Use bullet points", "telegram")]),
        },
        ["web"],
      );
      const warn = vi.spyOn(logger, "warn");
      const info = vi.spyOn(logger, "info");

      const result = await extractCorrections(sampleHistory, SCOPE, deps);

      expect(result).toMatchObject({
        contradictions: 1,
        retired: 0,
        outOfScopeContradictionsSkipped: 1,
      });
      expect(deps.store.retireLearningRule).not.toHaveBeenCalled();
      const logged = [...warn.mock.calls, ...info.mock.calls].filter(
        ([fields]) =>
          typeof fields === "object" &&
          fields !== null &&
          "rule" in fields &&
          fields.rule === "Bullet points are fine",
      );
      expect(logged).toHaveLength(1);
      warn.mockRestore();
      info.mockRestore();
    });

    it("counts no retirement when the rule was promoted or retired since it was listed", async () => {
      const deps = mockExtractionDeps(contradiction("R1"), {
        getCorrections: vi.fn().mockResolvedValue([learningRow("learning", "Use bullet points")]),
        retireLearningRule: vi.fn().mockResolvedValue(false),
      });

      const result = await extractCorrections(sampleHistory, SCOPE, deps);

      expect(result).toMatchObject({ contradictions: 1, retired: 0 });
    });
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

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.extracted).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Use fetch_url for weather lookups",
      category: "domain",
      profileId: null,
      channelType: null,
    });
  });

  it("inserts a new correction whose output omits matchedExistingRuleId", async () => {
    // Where decoding isn't constrained to the schema, the model can drop a
    // field whose only legal value is null, and drop it again on the retry.
    const deps = mockExtractionDeps({
      corrections: [
        {
          rule: "Use fetch_url for weather lookups",
          category: "domain",
          reasoning: "User corrected tool choice",
          action: "new",
          channelType: null,
        },
      ],
    });

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.extracted).toBe(1);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Use fetch_url for weather lookups",
      category: "domain",
      profileId: null,
      channelType: null,
    });
  });

  it("reinforces the rule whose label the model returns", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Keep replies short",
            category: "style",
            reasoning: "Said again",
            matchedExistingRuleId: "R2",
            action: "reinforce",
          },
        ],
      },
      { getCorrections: vi.fn().mockResolvedValue(LABELLED_RULES) },
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.reinforced).toBe(1);
    expect(result.unknownRuleReinforcementsSkipped).toBe(0);
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(expect.anything(), {
      rule: "Keep replies short",
      category: "style",
      profileId: null,
      channelType: null,
      existingRuleId: "rule-b",
    });
  });

  it("skips a reinforce whose label names no listed rule", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Keep replies short",
            category: "style",
            reasoning: "Off by one",
            matchedExistingRuleId: "R3",
            action: "reinforce",
          },
        ],
      },
      { getCorrections: vi.fn().mockResolvedValue(LABELLED_RULES) },
    );
    const warn = vi.spyOn(logger, "warn");

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.reinforced).toBe(0);
    expect(result.unknownRuleReinforcementsSkipped).toBe(1);
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ matchedLabel: "R3" }),
      expect.stringContaining("unknown rule"),
    );
    warn.mockRestore();
  });

  it("shows the model a label for each existing rule, never its id", async () => {
    const deps = mockExtractionDeps(
      { corrections: [] },
      { getCorrections: vi.fn().mockResolvedValue(LABELLED_RULES) },
    );

    await extractCorrections(sampleHistory, SCOPE, deps);

    const system = expectDefined(vi.mocked(deps.provider.chat).mock.calls[0], "chat call")[0]
      .system;
    expect(system).toContain("[R1] (style, all channels) Be concise");
    expect(system).toContain("[R2] (style, all channels) Keep replies short");
    expect(system).not.toContain("rule-a");
    expect(system).not.toContain("rule-b");
  });

  it("labels rules by priority, then text, whatever order their ids sort in", async () => {
    // Ids and creation order differ between runs; labels must not.
    const rules = [
      { ...ruleRow("rule-a", "Zebra rule"), priority: 100 },
      { ...ruleRow("rule-b", "Alpha rule"), priority: 100 },
      { ...ruleRow("rule-c", "Yak rule"), priority: 50 },
    ];
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Alpha rule",
            category: "style",
            reasoning: "Said again",
            matchedExistingRuleId: "R2",
            action: "reinforce",
          },
        ],
      },
      { getCorrections: vi.fn().mockResolvedValue(rules) },
    );

    await extractCorrections(sampleHistory, SCOPE, deps);

    const system = expectDefined(vi.mocked(deps.provider.chat).mock.calls[0], "chat call")[0]
      .system;
    expect(system).toContain("[R1] (style, all channels) Yak rule");
    expect(system).toContain("[R2] (style, all channels) Alpha rule");
    expect(system).toContain("[R3] (style, all channels) Zebra rule");
    expect(deps.store.upsertCorrection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ existingRuleId: "rule-b" }),
    );
  });

  it("skips a contradiction whose label names no listed rule, without counting it", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Be verbose",
            category: "style",
            reasoning: "Off by one",
            matchedExistingRuleId: "R3",
            action: "contradiction",
          },
        ],
      },
      { getCorrections: vi.fn().mockResolvedValue(LABELLED_RULES) },
    );
    const warn = vi.spyOn(logger, "warn");

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.contradictions).toBe(0);
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ matchedLabel: "R3" }),
      expect.stringContaining("contradiction names an unknown rule"),
    );
    warn.mockRestore();
  });

  it("reinforces existing correction", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Use fetch_url for weather",
            category: "domain",
            reasoning: "Same correction again",
            matchedExistingRuleId: "R1",
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
            priority: 100,
            channelType: null,
          },
        ]),
      },
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Always use web_search for lookups",
            category: "domain",
            reasoning: "Contradicts existing fetch_url preference",
            matchedExistingRuleId: "R1",
            action: "contradiction",
          },
        ],
      },
      {
        getCorrections: vi
          .fn()
          .mockResolvedValue([ruleRow("existing-rule-1", "Use fetch_url for lookups")]),
      },
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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
            matchedExistingRuleId: "R1",
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
            priority: 100,
            channelType: null,
          },
        ]),
        upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: true }),
      },
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.promoted).toBe(1);
    expect(result.reinforced).toBe(1);
  });

  it("flags consolidationNeeded once the active learned rules pass 20", async () => {
    const deps = mockExtractionDeps(
      { corrections: [] },
      { countActiveLearnedRules: vi.fn().mockResolvedValue(21) },
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);
    expect(result.consolidationNeeded).toBe(true);
    expect(deps.store.countActiveLearnedRules).toHaveBeenCalledWith(FAKE_TX, "profile-1");
  });

  it("does not flag consolidation at 20", async () => {
    const deps = mockExtractionDeps(
      { corrections: [] },
      { countActiveLearnedRules: vi.fn().mockResolvedValue(20) },
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);
    expect(result.consolidationNeeded).toBe(false);
  });

  it("skips a reinforcement whose rule was retired after the list was read", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Be concise",
            category: "style",
            reasoning: "Said again",
            matchedExistingRuleId: "R1",
            action: "reinforce",
          },
        ],
      },
      {
        getCorrections: vi.fn().mockResolvedValue([ruleRow("rule-1", "Be concise")]),
        upsertCorrection: vi.fn().mockResolvedValue(null),
      },
    );
    const warn = vi.spyOn(logger, "warn");

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result).toMatchObject({
      reinforced: 0,
      promoted: 0,
      unknownRuleReinforcementsSkipped: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ matchedId: "rule-1" }),
      expect.stringContaining("retired"),
    );
    warn.mockRestore();
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
            matchedExistingRuleId: "R1",
            action: "reinforce",
          },
          {
            rule: "Contradicting rule",
            category: "style",
            reasoning: "conflicts",
            matchedExistingRuleId: "R2",
            action: "contradiction",
          },
        ],
      },
      {
        // Labelled by text: R1 is the reinforced rule, R2 the contradicted one.
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "rule-2",
            rule: "Reinforced rule",
            category: "domain",
            active: true,
            observationCount: 1,
            priority: 100,
            channelType: null,
          },
          ruleRow("rule-3", "Search the web first"),
        ]),
      },
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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
            matchedExistingRuleId: "R1",
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
            priority: 100,
            channelType: null,
          },
        ]),
      },
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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
            matchedExistingRuleId: "R1",
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
            priority: 100,
            channelType: "telegram",
          },
        ]),
      },
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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
            matchedExistingRuleId: "R1",
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
            priority: 100,
            channelType: "slack",
          },
        ]),
      },
      ["telegram"],
    );

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.reinforced).toBe(0);
    expect(result.outOfScopeReinforcementsSkipped).toBe(1);
    expect(result.unknownRuleReinforcementsSkipped).toBe(0);
    expect(deps.store.upsertCorrection).not.toHaveBeenCalled();
  });

  it("skips a reinforce that names something other than a label when no rule is listed", async () => {
    const deps = mockExtractionDeps(
      {
        corrections: [
          {
            rule: "Be concise",
            category: "style",
            reasoning: "LLM hallucinated the match",
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

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

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
            priority: 100,
            channelType: null,
          },
          {
            id: "rule-2",
            rule: "Avoid markdown headings on Telegram",
            category: "style",
            active: true,
            observationCount: 2,
            priority: 100,
            channelType: "telegram",
          },
        ]),
      },
      ["telegram"],
    );

    await extractCorrections(sampleHistory, SCOPE, deps);

    expect(deps.provider.chat).toHaveBeenCalledOnce();
    const call = vi.mocked(deps.provider.chat).mock.calls[0]?.[0];
    const system = call?.system ?? "";
    expect(system).toContain("`telegram`");
    expect(system).toContain("[R1] (style, channel:telegram) Avoid markdown headings on Telegram");
    expect(system).toContain("[R2] (style, all channels) Be concise");
  });

  it("instructs the LLM to default to null when no channels are active", async () => {
    const deps = mockExtractionDeps({ corrections: [] }, undefined, []);

    await extractCorrections(sampleHistory, SCOPE, deps);

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

    const result = await extractCorrections(thinkingOnly, SCOPE, deps);

    expect(result).toEqual({
      extracted: 0,
      reinforced: 0,
      contradictions: 0,
      retired: 0,
      promoted: 0,
      outOfScopeReinforcementsSkipped: 0,
      outOfScopeContradictionsSkipped: 0,
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
    const deps: ExtractionDeps = { ...mockExtractionDeps({ corrections: [] }), provider };

    const result = await extractCorrections(sampleHistory, SCOPE, deps);

    expect(result.extracted).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });
});
