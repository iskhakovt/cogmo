import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { LlmProvider } from "../../llm/provider.js";
import {
  fakeRunInTx,
  mockAgentStore,
  mockProvider,
  mockResolver,
  mockTransportStore,
} from "../../test/factories.js";
import type { PromptSource } from "../prompt.js";
import type { AgentStore, CompactionSummary, Profile } from "../store/index.js";
import { type CompactConversationDeps, compactConversation } from "./compact-conversation.js";

const CONVERSATION_ID = "conv-1";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    userId: null,
    name: "default",
    basePrompt: "be helpful",
    model: "claude-sonnet-5",
    summarizationModel: "claude-haiku-4-5",
    extractionModel: null,
    autoRecall: "heuristic",
    voiceMode: "auto",
    toolSet: [],
    memoryScope: null,
    profileClass: null,
    streamChunkChars: 4000,
    streamEdits: true,
    codingAutoapproveMode: "off",
    ...overrides,
  };
}

/** `n` alternating user/assistant messages with sequential ids. */
function transcript(n: number): { id: string; role: "user" | "assistant"; content: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${i + 1}`,
  }));
}

function deps(
  overrides: { agentStore?: AgentStore; provider?: LlmProvider; promptSource?: PromptSource } = {},
): CompactConversationDeps {
  const promptSource =
    overrides.promptSource ??
    ({ assemble: vi.fn().mockResolvedValue("SYSTEM PROMPT") } satisfies PromptSource);
  return {
    runInTx: fakeRunInTx,
    agentStore: overrides.agentStore ?? mockAgentStore(),
    transportStore: mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram"]),
    }),
    resolveProvider: mockResolver(overrides.provider ?? mockProvider()),
    promptSource,
  };
}

function storeWith(
  messages: ReturnType<typeof transcript>,
  summary?: CompactionSummary,
): AgentStore {
  return mockAgentStore({
    getConversation: vi.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      userId: "user-1",
      profileId: "p1",
      isPrivate: true,
      cooldownState: null,
      voiceMode: null,
    }),
    getProfile: vi.fn().mockResolvedValue(profile()),
    getLatestSummary: vi.fn().mockResolvedValue(summary),
    listMessages: vi.fn().mockResolvedValue(messages),
    getHistoryAfter: vi.fn().mockResolvedValue(messages),
    getActiveRules: vi.fn().mockResolvedValue([]),
  });
}

describe("compactConversation", () => {
  it("summarizes everything outside the retain window and stores it", async () => {
    const agentStore = storeWith(transcript(10));
    const provider = mockProvider({
      chat: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "they discussed the schema" }],
        stopReason: "end_turn",
        model: "claude-haiku-4-5",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore, provider }));

    // 10 messages, 6 retained → the first 4 collapse.
    expect(result).toEqual({
      status: "compacted",
      messagesSummarized: 4,
      messagesKept: 6,
      model: "claude-haiku-4-5",
    });
    expect(agentStore.insertOrRecoverSummary).toHaveBeenCalledWith(expect.anything(), {
      conversationId: CONVERSATION_ID,
      summary: "they discussed the schema",
      throughMessageId: "m4",
      messagesSummarized: 4,
      model: "claude-haiku-4-5",
      source: "manual",
    });
  });

  it("sends only the summarized prefix to the model, with the instruction appended", async () => {
    const agentStore = storeWith(transcript(10));
    const provider = mockProvider();

    await compactConversation(CONVERSATION_ID, deps({ agentStore, provider }));

    const params = vi.mocked(provider.chat).mock.calls[0]?.[0];
    expect(params?.model).toBe("claude-haiku-4-5");
    expect(params?.system).toBe("SYSTEM PROMPT");
    // 4 prefix messages + the summarization instruction; nothing from the
    // retained tail, which the next turn still carries verbatim.
    expect(params?.messages).toHaveLength(5);
    expect(params?.messages.slice(0, 4).map((m) => m.content)).toEqual([
      "turn 1",
      "turn 2",
      "turn 3",
      "turn 4",
    ]);
  });

  it("falls back to the conversation model when no summarization model is set", async () => {
    const agentStore = storeWith(transcript(10));
    vi.mocked(agentStore.getProfile).mockResolvedValue(profile({ summarizationModel: null }));
    const provider = mockProvider();

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore, provider }));

    expect(result).toMatchObject({ status: "compacted", model: "claude-sonnet-5" });
    expect(vi.mocked(provider.chat).mock.calls[0]?.[0].model).toBe("claude-sonnet-5");
  });

  it("skips a conversation that still fits in full", async () => {
    const agentStore = storeWith(transcript(4));

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore }));

    expect(result).toEqual({ status: "skipped", reason: "too_short" });
    expect(agentStore.insertOrRecoverSummary).not.toHaveBeenCalled();
  });

  it("skips when the span outside the retain window is only the stored summary", async () => {
    // Six messages arrived since the last compaction: with the summary
    // prepended the array is 7 long, so the split lands at 1 — covering the
    // synthetic entry alone, which advances nothing.
    const summary: CompactionSummary = {
      id: "sum-1",
      conversationId: CONVERSATION_ID,
      summary: "earlier",
      throughMessageId: "m0",
      messagesSummarized: 3,
      model: "claude-haiku-4-5",
      source: "turn",
      createdAt: new Date(),
    };
    const agentStore = storeWith(transcript(6), summary);

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore }));

    expect(result).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(agentStore.insertOrRecoverSummary).not.toHaveBeenCalled();
  });

  it("re-summarizes the stored summary together with what followed it", async () => {
    const summary: CompactionSummary = {
      id: "sum-1",
      conversationId: CONVERSATION_ID,
      summary: "earlier",
      throughMessageId: "m0",
      messagesSummarized: 3,
      model: "claude-haiku-4-5",
      source: "turn",
      createdAt: new Date(),
    };
    const agentStore = storeWith(transcript(9), summary);
    const provider = mockProvider();

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore, provider }));

    // 1 synthetic + 9 rows = 10 entries, 6 retained → the first 4 collapse,
    // and the cutoff is the last real message inside them.
    expect(result).toMatchObject({ status: "compacted", messagesSummarized: 4, messagesKept: 6 });
    expect(agentStore.insertOrRecoverSummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ throughMessageId: "m3" }),
    );
    const sent = vi.mocked(provider.chat).mock.calls[0]?.[0].messages ?? [];
    expect(sent[0]?.content).toContain("[Previous conversation summary]");
  });

  it("stores nothing when the model returns no text", async () => {
    const agentStore = storeWith(transcript(10));
    const provider = mockProvider({
      chat: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "   " }],
        stopReason: "end_turn",
        model: "claude-haiku-4-5",
        usage: { inputTokens: 10, outputTokens: 0 },
      }),
    });

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore, provider }));

    expect(result).toEqual({ status: "skipped", reason: "empty_summary" });
    expect(agentStore.insertOrRecoverSummary).not.toHaveBeenCalled();
  });

  it("reports not_found when the conversation vanished", async () => {
    const agentStore = mockAgentStore({ getConversation: vi.fn().mockResolvedValue(undefined) });

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore }));

    expect(result).toEqual({ status: "not_found" });
  });

  it("reports not_found when the profile vanished", async () => {
    const agentStore = storeWith(transcript(10));
    vi.mocked(agentStore.getProfile).mockResolvedValue(undefined);

    const result = await compactConversation(CONVERSATION_ID, deps({ agentStore }));

    expect(result).toEqual({ status: "not_found" });
  });

  it("assembles the prompt from the conversation's own steering rules", async () => {
    const agentStore = storeWith(transcript(10));
    vi.mocked(agentStore.getActiveRules).mockResolvedValue([{ rule: "Be terse" }]);
    const promptSource = mock<PromptSource>();
    promptSource.assemble.mockResolvedValue("SYSTEM PROMPT");

    await compactConversation(CONVERSATION_ID, deps({ agentStore, promptSource }));

    expect(promptSource.assemble).toHaveBeenCalledWith({
      profile: profile(),
      rules: [{ rule: "Be terse" }],
    });
  });
});
