import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockProvider } from "../../test/factories.js";
import { type ConsolidationDeps, consolidateRules } from "./consolidate-rules.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

interface CorrectionRow {
  id: string;
  rule: string;
  category: string;
  active: boolean;
  observationCount: number;
  channelType: string | null;
}

/**
 * Build deps where each LLM call returns a fixed response. The provider
 * is called once per channel-scoped group (>=2 rules), so a test with
 * mixed scopes passes one entry per scope in `chatTypedResponses` —
 * iteration order matches `Object.entries` of the grouped record.
 */
function mockConsolidationDeps(
  chatTypedResponses: Array<{ groups: Array<Record<string, unknown>> }>,
  storeOverrides?: Partial<ConsolidationDeps["store"]>,
): ConsolidationDeps {
  const chatMock = vi.fn();
  for (const response of chatTypedResponses) {
    chatMock.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(response) }],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }

  const provider = mockProvider({ chat: chatMock });

  const defaultRules: CorrectionRow[] = [
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
  ];

  return {
    provider,
    model: "test-model",
    runInTx: fakeRunInTx,
    store: {
      getCorrections: vi.fn().mockResolvedValue(defaultRules),
      replaceRules: vi.fn().mockResolvedValue({ id: "new-rule-1" }),
      ...storeOverrides,
    },
  };
}

describe("consolidateRules", () => {
  it("merges similar rules and calls replaceRules", async () => {
    const deps = mockConsolidationDeps([
      {
        groups: [
          {
            originalIds: ["r1", "r2"],
            mergedRule: "Be concise and brief in responses",
            category: "style",
          },
        ],
      },
    ]);

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(1);
    expect(result.rulesRemoved).toBe(1); // 2 rules → 1 = 1 removed
    expect(deps.store.replaceRules).toHaveBeenCalledWith(expect.anything(), {
      oldIds: ["r1", "r2"],
      newRule: {
        rule: "Be concise and brief in responses",
        category: "style",
        profileId: null,
        channelType: null,
        priority: 100,
        observationCount: 5, // 3 + 2
      },
    });
  });

  it("returns zeros when no merges needed", async () => {
    const deps = mockConsolidationDeps([{ groups: [] }]);

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(0);
    expect(result.rulesRemoved).toBe(0);
    expect(deps.store.replaceRules).not.toHaveBeenCalled();
  });

  it("skips consolidation when fewer than 2 rules exist", async () => {
    const deps = mockConsolidationDeps([{ groups: [] }], {
      getCorrections: vi.fn().mockResolvedValue([
        {
          id: "r1",
          rule: "Only one",
          category: "style",
          active: true,
          observationCount: 1,
          channelType: null,
        },
      ] satisfies CorrectionRow[]),
    });

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(0);
    // chatTyped should not have been called
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("skips invalid merge groups from LLM", async () => {
    const deps = mockConsolidationDeps([
      {
        groups: [
          {
            originalIds: ["r1", "unknown-id"],
            mergedRule: "Bad merge",
            category: "style",
          },
        ],
      },
    ]);

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(0);
    expect(result.rulesRemoved).toBe(0);
    expect(deps.store.replaceRules).not.toHaveBeenCalled();
  });

  it("skips only inactive rules before consolidating", async () => {
    const deps = mockConsolidationDeps([{ groups: [] }], {
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
      ] satisfies CorrectionRow[]),
    });

    const result = await consolidateRules("profile-1", deps);

    // Only 1 active rule — below threshold of 2, skips LLM call
    expect(result.mergedGroups).toBe(0);
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("merges same-channel rules within a group", async () => {
    const deps = mockConsolidationDeps(
      [
        {
          groups: [
            {
              originalIds: ["r1", "r2"],
              mergedRule: "Avoid markdown headings in Telegram replies",
              category: "style",
            },
          ],
        },
      ],
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "r1",
            rule: "Don't use markdown headings on Telegram",
            category: "style",
            active: true,
            observationCount: 3,
            channelType: "telegram",
          },
          {
            id: "r2",
            rule: "Skip section headings in Telegram messages",
            category: "style",
            active: true,
            observationCount: 2,
            channelType: "telegram",
          },
        ] satisfies CorrectionRow[]),
      },
    );

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(1);
    expect(result.rulesRemoved).toBe(1);
    expect(deps.store.replaceRules).toHaveBeenCalledTimes(1);
    expect(deps.store.replaceRules).toHaveBeenCalledWith(expect.anything(), {
      oldIds: ["r1", "r2"],
      newRule: {
        rule: "Avoid markdown headings in Telegram replies",
        category: "style",
        profileId: null,
        channelType: "telegram",
        priority: 100,
        observationCount: 5,
      },
    });
  });

  it("consolidates global and channel-scoped rules independently in one fire", async () => {
    // The two scopes are consolidated as independent LLM calls, each
    // emitting a `replaceRules` write that preserves its scope's
    // `channelType`. Order between scopes is not part of the contract;
    // the chat mock dispatches by which rule IDs appear in the prompt
    // so iteration order can change without breaking the test.
    const globalResponse = {
      groups: [
        {
          originalIds: ["g1", "g2"],
          mergedRule: "Be concise globally",
          category: "style",
        },
      ],
    };
    const telegramResponse = {
      groups: [
        {
          originalIds: ["t1", "t2"],
          mergedRule: "Avoid markdown headings on Telegram",
          category: "style",
        },
      ],
    };
    const chatMock = vi.fn(async ({ system }: { system: string }) => {
      const response = system.includes("[g1]") ? globalResponse : telegramResponse;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
        stopReason: "end_turn" as const,
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const provider = mockProvider({ chat: chatMock });
    const deps: ConsolidationDeps = {
      provider,
      model: "test-model",
      runInTx: fakeRunInTx,
      store: {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "g1",
            rule: "Be concise",
            category: "style",
            active: true,
            observationCount: 3,
            channelType: null,
          },
          {
            id: "g2",
            rule: "Keep it short",
            category: "style",
            active: true,
            observationCount: 2,
            channelType: null,
          },
          {
            id: "t1",
            rule: "Don't use markdown headings on Telegram",
            category: "style",
            active: true,
            observationCount: 4,
            channelType: "telegram",
          },
          {
            id: "t2",
            rule: "Skip section headings in Telegram messages",
            category: "style",
            active: true,
            observationCount: 1,
            channelType: "telegram",
          },
        ] satisfies CorrectionRow[]),
        replaceRules: vi.fn().mockResolvedValue({ id: "new-rule-1" }),
      },
    };

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(2);
    expect(result.rulesRemoved).toBe(2);
    expect(deps.provider.chat).toHaveBeenCalledTimes(2);
    expect(deps.store.replaceRules).toHaveBeenCalledTimes(2);

    const replaceCalls = vi.mocked(deps.store.replaceRules).mock.calls;
    expect(replaceCalls).toEqual(
      expect.arrayContaining([
        [
          expect.anything(),
          {
            oldIds: ["g1", "g2"],
            newRule: {
              rule: "Be concise globally",
              category: "style",
              profileId: null,
              channelType: null,
              priority: 100,
              observationCount: 5,
            },
          },
        ],
        [
          expect.anything(),
          {
            oldIds: ["t1", "t2"],
            newRule: {
              rule: "Avoid markdown headings on Telegram",
              category: "style",
              profileId: null,
              channelType: "telegram",
              priority: 100,
              observationCount: 5,
            },
          },
        ],
      ]),
    );
  });

  it("does not call LLM for a single-rule channel group", async () => {
    // Telegram group has 1 rule (below threshold), global group has 2.
    // Only the global group should trigger an LLM call.
    const deps = mockConsolidationDeps(
      [
        {
          groups: [
            {
              originalIds: ["g1", "g2"],
              mergedRule: "Be concise globally",
              category: "style",
            },
          ],
        },
      ],
      {
        getCorrections: vi.fn().mockResolvedValue([
          {
            id: "g1",
            rule: "Be concise",
            category: "style",
            active: true,
            observationCount: 3,
            channelType: null,
          },
          {
            id: "g2",
            rule: "Keep it short",
            category: "style",
            active: true,
            observationCount: 2,
            channelType: null,
          },
          {
            id: "t1",
            rule: "Don't use markdown headings on Telegram",
            category: "style",
            active: true,
            observationCount: 4,
            channelType: "telegram",
          },
        ] satisfies CorrectionRow[]),
      },
    );

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(1);
    expect(result.rulesRemoved).toBe(1);
    expect(deps.provider.chat).toHaveBeenCalledTimes(1);
    expect(deps.store.replaceRules).toHaveBeenCalledTimes(1);
  });

  it("recovers a trailing-comma consolidation response via chatTyped repair", async () => {
    // Regression: consolidate-rules passes `repair: {}` into chatTyped, so a
    // trailing comma in the structured-output response is fixed by the
    // jsonrepair pre-pass instead of crashing the consolidation run.
    const chatMock = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"groups":[{"originalIds":["r1","r2"],"mergedRule":"Be concise and brief","category":"style",},],}',
        },
      ],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const deps: ConsolidationDeps = {
      provider: mockProvider({ chat: chatMock }),
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
        ] satisfies CorrectionRow[]),
        replaceRules: vi.fn().mockResolvedValue({ id: "new-rule-1" }),
      },
    };

    const result = await consolidateRules("profile-1", deps);

    expect(result.mergedGroups).toBe(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});
