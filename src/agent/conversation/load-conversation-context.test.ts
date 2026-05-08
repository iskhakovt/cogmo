import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { loadConversationContext } from "./load-conversation-context.js";

// Sentinel `tx` token so we can verify the use case threads the same
// transaction handle through every store call. Real tx semantics are
// covered by the store-level PGlite tests; this file is contract-only.
const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("loadConversationContext", () => {
  it("loads profile, channelTypes, and rules in one transaction", async () => {
    const profile = {
      id: "p1",
      userId: null,
      name: "default",
      basePrompt: "be helpful",
      model: "m",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic" as const,
      voiceMode: "auto" as const,
      toolSet: [],
      memoryScope: null,
    };
    const agentStore = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(profile),
      getActiveRules: vi.fn().mockResolvedValue([{ rule: "Be concise" }]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram"]),
    });

    const result = await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", profileId: "p1" },
    );

    expect(result).toEqual({
      profile,
      channelTypes: ["telegram"],
      rules: [{ rule: "Be concise" }],
    });

    // Every store call shares the same `tx` — the use case must NOT
    // open a fresh transaction per call. Catches a regression where
    // someone wraps a single store call in its own `runInTx` inside
    // the use case.
    expect(agentStore.getProfile).toHaveBeenCalledWith(FAKE_TX, "p1");
    expect(transportStore.getActiveChannelTypes).toHaveBeenCalledWith(FAKE_TX, "c1");
    expect(agentStore.getActiveRules).toHaveBeenCalledWith(FAKE_TX, "p1", ["telegram"]);
  });

  it("threads channelTypes from transport into agentStore.getActiveRules", async () => {
    // Without the cross-store composition, channel-scoped rules would
    // never surface — `getActiveRules` returns global-only when
    // channelTypes is empty.
    const agentStore = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(undefined),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram", "slack"]),
    });

    await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", profileId: "p1" },
    );

    expect(agentStore.getActiveRules).toHaveBeenCalledWith(FAKE_TX, "p1", ["telegram", "slack"]);
  });

  it("returns undefined profile when not found", async () => {
    const agentStore = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(undefined),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue([]),
    });

    const result = await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", profileId: "missing" },
    );

    expect(result.profile).toBeUndefined();
  });
});
