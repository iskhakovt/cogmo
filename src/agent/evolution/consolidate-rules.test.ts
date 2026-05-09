import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockProvider } from "../../test/factories.js";
import { type ConsolidationDeps, consolidateRules } from "./consolidate-rules.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

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
    runInTx: fakeRunInTx,
    store: {
      getCorrections: vi.fn().mockResolvedValue([
        {
          id: "r1",
          rule: "Be concise",
          category: "style",
          active: true,
          observationCount: 3,
          channelType: null,
        },
        {
          id: "r2",
          rule: "Keep it short",
          category: "style",
          active: true,
          observationCount: 2,
          channelType: null,
        },
        {
          id: "r3",
          rule: "Use tables for data",
          category: "domain",
          active: true,
          observationCount: 4,
          channelType: null,
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
    expect(deps.store.replaceRules).toHaveBeenCalledWith(expect.anything(), {
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
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "r1",
            rule: "Only one",
            category: "style",
            active: true,
            observationCount: 1,
            channelType: null,
          },
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

  it("excludes channel-scoped rules from consolidation", async () => {
    // Channel-scoped rules and global rules can share wording but are
    // conceptually distinct. `replaceRules` only emits global merged
    // rows, so consolidation must not see channel-scoped rules at all.
    const deps = mockConsolidationDeps(
      { groups: [] },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "r1",
            rule: "Be concise",
            category: "style",
            active: true,
            observationCount: 3,
            channelType: "telegram",
          },
          {
            id: "r2",
            rule: "Keep it short",
            category: "style",
            active: true,
            observationCount: 2,
            channelType: "direct",
          },
        ]),
      },
    );

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(0);
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("skips only inactive rules before consolidating", async () => {
    const deps = mockConsolidationDeps(
      { groups: [] },
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "r1",
            rule: "Active",
            category: "style",
            active: true,
            observationCount: 2,
            channelType: null,
          },
          {
            id: "r2",
            rule: "Learning",
            category: "style",
            active: false,
            observationCount: 1,
            channelType: null,
          },
        ]),
      },
    );

    const result = await consolidateRules("profile-1", deps);

    // Only 1 active rule — below threshold of 2, skips LLM call
    expect(result.mergedGroups).toBe(0);
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });
});
