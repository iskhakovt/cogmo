import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { MemoryProvider } from "../../memory/provider.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore } from "../store/index.js";
import { triggerReflection } from "./trigger-reflection.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const CONV_ID = "11111111-1111-7111-8111-111111111111";
const USER_ID = "22222222-2222-7222-8222-222222222222";
const PROFILE_ID = "33333333-3333-7333-8333-333333333333";

describe("triggerReflection", () => {
  it("short-circuits when the conversation is not found", async () => {
    const agentStore = mock<AgentStore>();
    agentStore.getConversation.mockResolvedValue(undefined);
    const result = await triggerReflection(CONV_ID, {
      runInTx: fakeRunInTx,
      agentStore,
      transportStore: mock<Pick<TransportStore, "getActiveChannelTypes">>(),
      resolveProvider: vi.fn(),
      memory: mock<Pick<MemoryProvider, "retainBatch">>(),
    });
    expect(result).toEqual({ status: "skipped", reason: "conversation_not_found" });
    // No persistence on skipped fires — the table only records `processed`.
    expect(agentStore.recordEvolutionEvent).not.toHaveBeenCalled();
  });

  it("answers nothing_new, writing no row, when no turn is left to observe and nothing is staged", async () => {
    const agentStore = mock<AgentStore>();
    agentStore.getConversation.mockResolvedValue({
      id: CONV_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      isPrivate: true,
      cooldownState: null,
      voiceMode: null,
    });
    agentStore.getProfile.mockResolvedValue({
      id: PROFILE_ID,
      userId: null,
      name: "p",
      basePrompt: "",
      model: "m",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass: null,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
    });
    agentStore.listCustomCompartments.mockResolvedValue([]);
    agentStore.listUndiscoveredTurns.mockResolvedValue([]);
    agentStore.listOpenTurns.mockResolvedValue([]);
    agentStore.getMemoryRules.mockResolvedValue([]);
    agentStore.listHeldExtractedTurns.mockResolvedValue([]);
    agentStore.releaseHeldTurns.mockResolvedValue(0);
    agentStore.releaseHeldExtractedTurns.mockResolvedValue(0);
    agentStore.getPendingMemories.mockResolvedValue([]);
    const transportStore = mock<Pick<TransportStore, "getActiveChannelTypes">>();
    transportStore.getActiveChannelTypes.mockResolvedValue([]);
    const provider = mock<LlmProvider>();
    const result = await triggerReflection(CONV_ID, {
      runInTx: fakeRunInTx,
      agentStore,
      transportStore,
      resolveProvider: vi.fn().mockResolvedValue({ provider, model: "m" }),
      memory: mock<Pick<MemoryProvider, "retainBatch">>(),
    });
    expect(result).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(agentStore.recordEvolutionEvent).not.toHaveBeenCalled();
    expect(provider.chat).not.toHaveBeenCalled();
  });
});
