import { describe, expect, it, vi } from "vitest";
import { mockProvider } from "../../test/factories.js";
import { type ConsolidationDeps, consolidateRules } from "./consolidate-rules.js";

function mockConsolidationDeps(
  chatTypedResponse: { groups: Array<Record<string, unknown>> },
  storeOverrides?: Partial<ConsolidationDeps["store"]>,
): ConsolidationDeps {
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
    store: {
      getCorrections: vi.fn().mockResolvedValue([
        { id: "r1", rule: "Be concise", category: "style", active: true, observationCount: 3 },
        { id: "r2", rule: "Keep it short", category: "style", active: true, observationCount: 2 },
        {
          id: "r3",
          rule: "Use tables for data",
          category: "domain",
          active: true,
          observationCount: 4,
        },
      ]),
      replaceRules: vi.fn().mockResolvedValue({ id: "new-rule-1" }),
      ...storeOverrides,
    },
  };
}

describe("consolidateRules", () => {
  it("merges similar rules and calls replaceRules", async () => {
    const deps = mockConsolidationDeps({
      groups: [
        {
          originalIds: ["r1", "r2"],
          mergedRule: "Be concise and brief in responses",
          category: "style",
        },
      ],
    });

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(1);
    expect(result.rulesRemoved).toBe(1); // 2 rules → 1 = 1 removed
    expect(deps.store.replaceRules).toHaveBeenCalledWith({
      oldIds: ["r1", "r2"],
      newRule: {
        rule: "Be concise and brief in responses",
        category: "style",
        profileId: null,
        priority: 100,
        observationCount: 5, // 3 + 2
      },
    });
  });

  it("returns zeros when no merges needed", async () => {
    const deps = mockConsolidationDeps({ groups: [] });

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(0);
    expect(result.rulesRemoved).toBe(0);
    expect(deps.store.replaceRules).not.toHaveBeenCalled();
  });

  it("skips consolidation when fewer than 2 rules exist", async () => {
    const deps = mockConsolidationDeps(
      { groups: [] },
      {
        getCorrections: vi
          .fn()
          .mockResolvedValue([
            { id: "r1", rule: "Only one", category: "style", active: true, observationCount: 1 },
          ]),
      },
    );

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(0);
    // chatTyped should not have been called
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("skips invalid merge groups from LLM", async () => {
    const deps = mockConsolidationDeps({
      groups: [
        {
          originalIds: ["r1", "unknown-id"],
          mergedRule: "Bad merge",
          category: "style",
        },
      ],
    });

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(0);
    expect(result.rulesRemoved).toBe(0);
    expect(deps.store.replaceRules).not.toHaveBeenCalled();
  });

  it("skips only inactive rules before consolidating", async () => {
    const deps = mockConsolidationDeps(
      { groups: [] },
      {
        getCorrections: vi.fn().mockResolvedValue([
          { id: "r1", rule: "Active", category: "style", active: true, observationCount: 2 },
          { id: "r2", rule: "Learning", category: "style", active: false, observationCount: 1 },
        ]),
      },
    );

    const result = await consolidateRules("profile-1", deps);

    // Only 1 active rule — below threshold of 2, skips LLM call
    expect(result.mergedGroups).toBe(0);
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });
});
