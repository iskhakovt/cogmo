import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import type { Profile } from "../store/index.js";
import { loadConversationContext } from "./load-conversation-context.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    userId: null,
    name: "default",
    basePrompt: "be helpful",
    model: "m",
    summarizationModel: null,
    extractionModel: null,
    autoRecall: "heuristic",
    voiceMode: "auto",
    toolSet: [],
    memoryScope: null,
    profileClass: null,
    ...overrides,
  };
}

describe("loadConversationContext", () => {
  it("does not re-read the profile — uses the row passed in by the caller", async () => {
    const agentStore = mockAgentStore({
      getActiveRules: vi.fn().mockResolvedValue([{ rule: "Be concise" }]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram"]),
    });

    const result = await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", profile: profile() },
    );

    expect(result).toEqual({
      channelTypes: ["telegram"],
      rules: [{ rule: "Be concise" }],
    });

    expect(agentStore.getProfile).not.toHaveBeenCalled();
    expect(transportStore.getActiveChannelTypes).toHaveBeenCalledWith(FAKE_TX, "c1");
    expect(agentStore.getActiveRules).toHaveBeenCalledWith(FAKE_TX, "p1", ["telegram"]);
  });

  it("threads channelTypes from transport into agentStore.getActiveRules", async () => {
    const agentStore = mockAgentStore({
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram", "slack"]),
    });

    await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", profile: profile() },
    );

    expect(agentStore.getActiveRules).toHaveBeenCalledWith(FAKE_TX, "p1", ["telegram", "slack"]);
  });

  it("skips the rules lookup when profile is undefined", async () => {
    const agentStore = mockAgentStore({
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram"]),
    });

    const result = await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", profile: undefined },
    );

    expect(result.rules).toEqual([]);
    expect(agentStore.getActiveRules).not.toHaveBeenCalled();
  });
});
