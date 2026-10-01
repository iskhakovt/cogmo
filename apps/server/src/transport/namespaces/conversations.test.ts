import { err } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { CompactConversationResult } from "../../agent/conversation/compact-conversation.js";
import type { Transactor } from "../../db/index.js";
import { AllProvidersFailedError } from "../../llm/fallback.js";
import { ProviderConfigError } from "../../llm/resolver.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createConversations } from "./conversations.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

// Every `inngest.send` call whose payload carries `eventName`. Returning all
// matches lets a test assert the event fired exactly once.
function inngestSendCallsForEvent(calls: unknown[][], eventName: string): unknown[][] {
  return calls.filter((c) => {
    const payload = c[0];
    return (
      typeof payload === "object" &&
      payload !== null &&
      "name" in payload &&
      payload.name === eventName
    );
  });
}

function setup(overrides?: {
  transportStore?: ReturnType<typeof mockTransportStore>;
  agentStore?: ReturnType<typeof mockAgentStore>;
}) {
  const transportStore = overrides?.transportStore ?? mockTransportStore();
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const inngestSend = vi.fn().mockResolvedValue(undefined);
  const inngest = { send: inngestSend } as any;
  const conversations = createConversations({
    channelId: "ch-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
    inngest,
    mcpRegistry: undefined,
    compactConversation: undefined,
  });
  return { conversations, transportStore, agentStore, inngestSend };
}

describe("conversations.setAlias", () => {
  it("returns access_denied when caller does not own the conversation", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "someone-else", profileId: "p", isPrivate: true }),
    });
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue({ userId: "user-1" }),
    });
    const { conversations } = setup({ transportStore, agentStore });

    const res = await conversations.setAlias("handle", "c1", "work");
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
  });

  it("rejects non-private conversations with access_denied", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p", isPrivate: false }),
    });
    const { conversations } = setup({ agentStore });

    const res = await conversations.setAlias("handle", "c1", "work");
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("non-private"),
    });
  });

  it("maps alias_taken through", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p", isPrivate: true }),
      setAlias: vi.fn().mockResolvedValue(err({ kind: "alias_taken" })),
    });
    const { conversations } = setup({ agentStore });

    const res = await conversations.setAlias("handle", "c1", "work");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "alias_taken" });
  });
});

describe("conversations.getMessages", () => {
  it("returns identity_rejected when the handle doesn't resolve", async () => {
    const transportStore = mockTransportStore({ resolveUser: vi.fn().mockResolvedValue(null) });
    const { conversations } = setup({ transportStore });
    const res = await conversations.getMessages("handle", "c1");
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "identity_rejected" });
  });

  it("returns conversation_not_found for a missing conversation", async () => {
    const agentStore = mockAgentStore({ getConversation: vi.fn().mockResolvedValue(undefined) });
    const { conversations } = setup({ agentStore });
    const res = await conversations.getMessages("handle", "c1");
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "conversation_not_found" });
  });

  it("returns access_denied when caller does not own the conversation", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "someone-else", profileId: "p", isPrivate: true }),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.getMessages("handle", "c1");
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
  });

  it("flattens content to text and drops tool-only turns", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p", isPrivate: true }),
      listMessages: vi.fn().mockResolvedValue([
        { id: "m1", role: "user", content: "hello" },
        {
          id: "m2",
          role: "assistant",
          content: [
            { type: "text", text: "hi " },
            { type: "text", text: "there" },
          ],
        },
        {
          id: "m3",
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
        },
        {
          id: "m4",
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }],
        },
      ]),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.getMessages("handle", "c1");
    expect(res._unsafeUnwrap()).toEqual([
      { id: "m1", role: "user", text: "hello" },
      { id: "m2", role: "assistant", text: "hi there" },
    ]);
  });
});

describe("conversations.setProfile", () => {
  it("returns conversation_not_found when conversation missing", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(null),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setProfile("handle", "c1", "p1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
  });

  it("allows switching to an org profile (user_id = null)", async () => {
    const setConversationProfile = vi.fn();
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-old",
        isPrivate: true,
        cooldownState: null,
      }),
      getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
      setConversationProfile,
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setProfile("handle", "c1", "p-org");
    expect(res.isOk()).toBe(true);
    expect(setConversationProfile).toHaveBeenCalledWith(expect.anything(), "c1", "p-org");
  });

  it("rejects switching to another user's profile", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "user-1", profileId: "p-old", isPrivate: true }),
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-2" }),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setProfile("handle", "c1", "p-their");
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("not visible"),
    });
  });

  // Auto-repair clear trigger — switching profile is a context change
  // that should end any active cooldown so the new profile's
  // provider/tools get a clean slate. Same-tx so a partial commit
  // can't leave "switched profile but still cooling down". Verify
  // the clear fires when cooldown_state was set.
  it("clears cooldown_state in the same tx as the profile switch", async () => {
    const setConversationProfile = vi.fn();
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-old",
        isPrivate: true,
        cooldownState: {
          lastErroredAt: "2026-05-19T11:00:00.000Z",
          cooldownSeconds: 60,
          consecutiveFailures: 1,
        },
      }),
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      setConversationProfile,
      clearCooldown,
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setProfile("handle", "c1", "p-new");
    expect(res.isOk()).toBe(true);
    expect(setConversationProfile).toHaveBeenCalledWith(expect.anything(), "c1", "p-new");
    expect(clearCooldown).toHaveBeenCalledWith(expect.anything(), "c1");
  });

  // Symmetric to the success-path clear in handle-message:
  // skipping the UPDATE when cooldown_state is already NULL avoids
  // a per-call pointless write.
  it("does NOT call clearCooldown when cooldown_state was already NULL", async () => {
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-old",
        isPrivate: true,
        cooldownState: null,
      }),
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      clearCooldown,
    });
    const { conversations } = setup({ agentStore });
    await conversations.setProfile("handle", "c1", "p-new");
    expect(clearCooldown).not.toHaveBeenCalled();
  });

  // Telemetry — emit AFTER the tx commits so a rolled-back tx
  // doesn't produce a phantom `cleared` event. Emit fires only
  // when a clear actually happened (prior cooldown_state non-null).
  it("emits conversation/cooldown/cleared with clearedBy=profile_switch when a clear happens", async () => {
    // Fake timers pin `elapsedCooldownSeconds` to an exact value
    // (3600s = the gap between `lastErroredAt` and `now`). Without
    // fake timers the integration assertion can only do
    // `expect.any(Number)`, missing a Math.max regression or a
    // wrong-anchor wiring slip.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
    try {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-old",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      });
      const { conversations, inngestSend } = setup({ agentStore });
      await conversations.setProfile("handle", "c1", "p-new");
      const clearedCalls = inngestSendCallsForEvent(
        inngestSend.mock.calls,
        "conversation/cooldown/cleared",
      );
      expect(clearedCalls).toHaveLength(1);
      expect(clearedCalls[0]?.[0]).toMatchObject({
        name: "conversation/cooldown/cleared",
        // Bus-dedup id keyed on (conversationId, lastErroredAt).
        id: "cooldown-cleared-c1-2026-05-19T11:00:00.000Z",
        data: {
          conversationId: "c1",
          clearedBy: "profile_switch",
          elapsedCooldownSeconds: 3600,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT emit cleared when cooldown_state was already NULL", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-old",
        isPrivate: true,
        cooldownState: null,
      }),
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
    });
    const { conversations, inngestSend } = setup({ agentStore });
    await conversations.setProfile("handle", "c1", "p-new");
    expect(
      inngestSendCallsForEvent(inngestSend.mock.calls, "conversation/cooldown/cleared"),
    ).toHaveLength(0);
  });
});

describe("conversations.repair", () => {
  it("returns identity_rejected when handle does not resolve", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { conversations } = setup({ transportStore });
    const res = await conversations.repair("ghost", "c1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns conversation_not_found when conversation missing", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(null),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.repair("handle", "c1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
  });

  it("returns access_denied when caller does not own the conversation", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-other",
        profileId: "p1",
        isPrivate: true,
        cooldownState: {
          lastErroredAt: "2026-05-19T11:00:00.000Z",
          cooldownSeconds: 60,
          consecutiveFailures: 1,
        },
      }),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.repair("handle", "c1");
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("not owned"),
    });
  });

  it("clears cooldown_state and reports wasCoolingDown: true", async () => {
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p1",
        isPrivate: true,
        cooldownState: {
          lastErroredAt: "2026-05-19T11:00:00.000Z",
          cooldownSeconds: 60,
          consecutiveFailures: 1,
        },
      }),
      clearCooldown,
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.repair("handle", "c1");
    expect(res._unsafeUnwrap()).toEqual({ wasCoolingDown: true });
    expect(clearCooldown).toHaveBeenCalledWith(expect.anything(), "c1");
  });

  it("is idempotent on conversations not cooling down and skips the write", async () => {
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p1",
        isPrivate: true,
        cooldownState: null,
      }),
      clearCooldown,
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.repair("handle", "c1");
    expect(res._unsafeUnwrap()).toEqual({ wasCoolingDown: false });
    expect(clearCooldown).not.toHaveBeenCalled();
  });

  it("emits conversation/cooldown/cleared with clearedBy=user_repair on a real clear", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T11:00:30.000Z")); // 30s into the cooldown
    try {
      const agentStore = mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p1",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
      });
      const { conversations, inngestSend } = setup({ agentStore });
      await conversations.repair("handle", "c1");
      const clearedCalls = inngestSendCallsForEvent(
        inngestSend.mock.calls,
        "conversation/cooldown/cleared",
      );
      expect(clearedCalls).toHaveLength(1);
      expect(clearedCalls[0]?.[0]).toMatchObject({
        name: "conversation/cooldown/cleared",
        id: "cooldown-cleared-c1-2026-05-19T11:00:00.000Z",
        // Clear fired mid-window — elapsed < the prior cooldownSeconds
        data: { conversationId: "c1", clearedBy: "user_repair", elapsedCooldownSeconds: 30 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT emit cleared when /repair was a no-op", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p1",
        isPrivate: true,
        cooldownState: null,
      }),
    });
    const { conversations, inngestSend } = setup({ agentStore });
    await conversations.repair("handle", "c1");
    expect(
      inngestSendCallsForEvent(inngestSend.mock.calls, "conversation/cooldown/cleared"),
    ).toHaveLength(0);
  });
});

describe("conversations.summary", () => {
  function makeAgentStore(overrides?: Parameters<typeof mockAgentStore>[0]) {
    return mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p1",
        isPrivate: true,
        cooldownState: null,
        voiceMode: null,
      }),
      getProfile: vi.fn().mockResolvedValue({
        id: "p1",
        userId: "user-1",
        name: "main",
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: ["recall_memory", "retain_memory"],
        memoryScope: null,
      }),
      getConversationStats: vi.fn().mockResolvedValue({
        createdAt: new Date("2026-04-16T10:00:00Z"),
        messageCount: 7,
        lastMessageAt: new Date("2026-04-16T11:30:00Z"),
      }),
      getAliasForConversation: vi.fn().mockResolvedValue("work"),
      getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 12_345, outputTokens: 678 }),
      getActiveRules: vi.fn().mockResolvedValue([
        { rule: "Operator", section: "always", channelType: null },
        { rule: "Learned", section: "learned", channelType: null },
        { rule: "Default", section: "channel_defaults", channelType: "telegram" },
      ]),
      ...overrides,
    });
  }

  function makeTransportStore() {
    return mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue({
        id: "s1",
        channelId: "ch-1",
        platformAddress: "addr-1",
        conversationId: "c1",
        status: "active",
        receive: "routed",
      }),
    });
  }

  it("returns identity_rejected when handle does not resolve", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { conversations } = setup({ transportStore });
    const res = await conversations.summary("ghost", "addr-1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns ok(null) when no active session for the address", async () => {
    const { conversations } = setup();
    const res = await conversations.summary("handle", "addr-empty");
    expect(res._unsafeUnwrap()).toBeNull();
  });

  it("returns ok(null) when conversation is not owned by the caller (mirrors getCurrent)", async () => {
    const agentStore = makeAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-other",
        profileId: "p1",
        isPrivate: true,
        cooldownState: null,
        voiceMode: null,
      }),
    });
    const { conversations } = setup({ agentStore, transportStore: makeTransportStore() });
    const res = await conversations.summary("handle", "addr-1");
    expect(res._unsafeUnwrap()).toBeNull();
  });

  it("returns profile_not_found when profile row is missing", async () => {
    const agentStore = makeAgentStore({
      getProfile: vi.fn().mockResolvedValue(undefined),
    });
    const { conversations } = setup({ agentStore, transportStore: makeTransportStore() });
    const res = await conversations.summary("handle", "addr-1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
  });

  it("returns conversation_not_found when stats row is missing (race)", async () => {
    const agentStore = makeAgentStore({
      getConversationStats: vi.fn().mockResolvedValue(undefined),
    });
    const { conversations } = setup({ agentStore, transportStore: makeTransportStore() });
    const res = await conversations.summary("handle", "addr-1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
  });

  it("aggregates conversation, profile, last-turn tokens, steering rules, and budget", async () => {
    const agentStore = makeAgentStore();
    const { conversations } = setup({ agentStore, transportStore: makeTransportStore() });
    const res = await conversations.summary("handle", "addr-1");
    const value = res._unsafeUnwrap();
    expect(value).toMatchObject({
      conversationId: "c1",
      alias: "work",
      cooldownState: null,
      messageCount: 7,
      profile: {
        id: "p1",
        name: "main",
        model: "claude-sonnet-4-6",
        toolCount: 2,
        autoRecall: "heuristic",
      },
      lastTurn: { inputTokens: 12_345, outputTokens: 678 },
      steeringRulesCount: 3,
    });
    expect(agentStore.getActiveRules).toHaveBeenCalledWith(expect.anything(), {
      profileId: "p1",
      userId: "user-1",
    });
    // claude-sonnet-4-6: contextWindow 1_000_000 - maxOutputTokens 64_000 - safetyBuffer 10_000
    expect(value?.contextBudget).toBe(926_000);
    // No mcpRegistry wired in setup() → mcp namespace is null.
    expect(value?.mcp).toBeNull();
  });

  it("counts the rules a third-party profile renders, without the user's instruction rules", async () => {
    const agentStore = makeAgentStore({
      getProfile: vi.fn().mockResolvedValue({
        id: "p1",
        userId: "user-1",
        name: "plugin",
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: [],
        memoryScope: { compartments: ["personal"], trust: ["any"] },
      }),
    });
    const { conversations } = setup({ agentStore, transportStore: makeTransportStore() });

    await conversations.summary("handle", "addr-1");

    expect(agentStore.getActiveRules).toHaveBeenCalledWith(expect.anything(), {
      profileId: "p1",
      userId: null,
    });
  });

  it("normalizes missing last-turn tokens to null", async () => {
    const agentStore = makeAgentStore({
      getLastTokens: vi.fn().mockResolvedValue(undefined),
    });
    const { conversations } = setup({ agentStore, transportStore: makeTransportStore() });
    const res = await conversations.summary("handle", "addr-1");
    expect(res._unsafeUnwrap()?.lastTurn).toBeNull();
  });

  it("returns contextBudget=null when the model is unknown to both DB and LiteLLM", async () => {
    // Resolver still returns a conservative default for the agent loop,
    // but `/status` elides the budget so the UI doesn't display the
    // resolver's guess as fact.
    const agentStore = makeAgentStore({
      getProfile: vi.fn().mockResolvedValue({
        id: "p1",
        userId: "user-1",
        name: "main",
        basePrompt: "",
        model: "totally-made-up-model-xyz-2099",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: [],
        memoryScope: null,
      }),
    });
    const { conversations } = setup({ agentStore, transportStore: makeTransportStore() });
    const res = await conversations.summary("handle", "addr-1");
    expect(res._unsafeUnwrap()?.contextBudget).toBeNull();
  });
});

describe("conversations.setVoiceMode", () => {
  it("returns identity_rejected when handle does not resolve", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { conversations } = setup({ transportStore });
    const res = await conversations.setVoiceMode("ghost", "c1", "always");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns conversation_not_found when conversation missing", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(null),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setVoiceMode("handle", "c1", "always");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
  });

  it("returns access_denied when caller does not own the conversation", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-other",
        profileId: "p1",
        isPrivate: true,
        cooldownState: null,
        voiceMode: null,
      }),
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setVoiceMode("handle", "c1", "always");
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("not owned"),
    });
  });

  it("persists the override on success (always)", async () => {
    const setConversationVoiceMode = vi.fn();
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p1",
        isPrivate: true,
        status: "active",
        voiceMode: null,
      }),
      setConversationVoiceMode,
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setVoiceMode("handle", "c1", "always");
    expect(res.isOk()).toBe(true);
    expect(setConversationVoiceMode).toHaveBeenCalledWith(expect.anything(), "c1", "always");
  });

  it("clears the override when called with null", async () => {
    const setConversationVoiceMode = vi.fn();
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p1",
        isPrivate: true,
        status: "active",
        voiceMode: "always",
      }),
      setConversationVoiceMode,
    });
    const { conversations } = setup({ agentStore });
    const res = await conversations.setVoiceMode("handle", "c1", null);
    expect(res.isOk()).toBe(true);
    expect(setConversationVoiceMode).toHaveBeenCalledWith(expect.anything(), "c1", null);
  });
});

describe("conversations.compact", () => {
  function buildCompactTransport(
    opts: {
      identity?: { userId: string } | null;
      session?: { conversationId: string } | null;
      conv?: { id: string; userId: string } | null;
      compactConversation?: (id: string) => Promise<CompactConversationResult>;
    } = {},
  ) {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(opts.conv ?? null),
    });
    const transportStore = mockTransportStore({
      resolveUser: vi
        .fn()
        .mockResolvedValue(opts.identity === undefined ? { userId: "user-1" } : opts.identity),
      resolveSession: vi.fn().mockResolvedValue(opts.session ?? null),
    });
    const conversations = createConversations({
      channelId: "ch-1",
      runInTx: fakeRunInTx,
      transportStore,
      agentStore,
      inngest: { send: vi.fn().mockResolvedValue(undefined) } as never,
      mcpRegistry: undefined,
      compactConversation: opts.compactConversation,
    });
    return { conversations };
  }

  const OWNED = {
    identity: { userId: "user-1" },
    session: { conversationId: "c1" },
    conv: { id: "c1", userId: "user-1" },
  };

  it("compaction_unavailable when the driver isn't wired", async () => {
    const { conversations } = buildCompactTransport({});
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "compaction_unavailable" });
  });

  it("identity_rejected without invoking the driver", async () => {
    const driver = vi.fn();
    const { conversations } = buildCompactTransport({
      identity: null,
      compactConversation: driver,
    });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(driver).not.toHaveBeenCalled();
  });

  it("no_session when the address has no active conversation", async () => {
    const driver = vi.fn();
    const { conversations } = buildCompactTransport({
      identity: { userId: "user-1" },
      session: null,
      compactConversation: driver,
    });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({ status: "no_session" });
    expect(driver).not.toHaveBeenCalled();
  });

  it("no_session when the conversation belongs to someone else", async () => {
    const driver = vi.fn();
    const { conversations } = buildCompactTransport({
      identity: { userId: "user-1" },
      session: { conversationId: "c1" },
      conv: { id: "c1", userId: "other-user" },
      compactConversation: driver,
    });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({ status: "no_session" });
    expect(driver).not.toHaveBeenCalled();
  });

  it("passes the compacted outcome through", async () => {
    const driver = vi.fn().mockResolvedValue({
      status: "compacted",
      messagesSummarized: 12,
      messagesKept: 6,
      model: "claude-haiku-4-5",
    });
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({
      status: "compacted",
      messagesSummarized: 12,
      messagesKept: 6,
      model: "claude-haiku-4-5",
    });
    expect(driver).toHaveBeenCalledWith("c1");
  });

  it("passes a skip reason through", async () => {
    const driver = vi.fn().mockResolvedValue({ status: "skipped", reason: "too_short" });
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({ status: "skipped", reason: "too_short" });
  });

  it("converts a driver throw into compaction_failed rather than rejecting", async () => {
    // The method returns a Result, and the driver runs inline with no retry
    // budget behind it. An escaping rejection would skip the adapter's
    // isErr() branch and leave the user's pre-ack as the last thing they see.
    const driver = vi.fn().mockRejectedValue(new Error("boom"));
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "compaction_failed", reason: null });
  });

  it("withholds an arbitrary error's message from the reason", async () => {
    // A Drizzle failure stringifies as the whole INSERT plus its bound
    // params, which for this table is the entire summary text.
    const driver = vi
      .fn()
      .mockRejectedValue(
        new Error('Failed query: insert into "conversation_summaries" ...\nparams: secret'),
      );
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "compaction_failed", reason: null });
    expect(JSON.stringify(res._unsafeUnwrapErr())).not.toContain("secret");
  });

  it("surfaces a provider failure's status without its body", async () => {
    // 429 and 5xx are the likeliest way `/compact` fails and the only detail
    // that tells the user whether waiting helps; the body is not ours to relay.
    const overloaded = Object.assign(new Error("Overloaded: <long provider body>"), {
      status: 529,
    });
    const driver = vi.fn().mockRejectedValue(overloaded);
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    const error = res._unsafeUnwrapErr();
    expect(error).toEqual({
      code: "compaction_failed",
      reason: "the request failed with HTTP 529",
    });
    expect(JSON.stringify(error)).not.toContain("long provider body");
  });

  it("reads the status out of the fallback chain's aggregate error", async () => {
    // `FallbackLlmProvider` converts a final *retriable* failure into
    // `AllProvidersFailedError`, so 429 and 5xx — the statuses worth telling
    // the user about — never arrive as a bare error carrying `status`.
    const aggregate = new AllProvidersFailedError([
      { provider: "primary", error: Object.assign(new Error("overloaded"), { status: 529 }) },
    ]);
    const driver = vi.fn().mockRejectedValue(aggregate);
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "compaction_failed",
      reason: "the request failed with HTTP 529",
    });
  });

  it("surfaces the newest status in the aggregate, skipping attempts without one", async () => {
    // A chain can end on a DNS or TLS failure after earlier attempts
    // returned the statuses that say whether waiting helps.
    const aggregate = new AllProvidersFailedError([
      { provider: "primary", error: Object.assign(new Error("rate limited"), { status: 429 }) },
      { provider: "secondary", error: Object.assign(new Error("unavailable"), { status: 503 }) },
      { provider: "tertiary", error: new Error("ENOTFOUND") },
    ]);
    const driver = vi.fn().mockRejectedValue(aggregate);
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "compaction_failed",
      reason: "the request failed with HTTP 503",
    });
  });

  it("surfaces a provider-config message, which names only the model", async () => {
    const driver = vi
      .fn()
      .mockRejectedValue(new ProviderConfigError("no routing row for small-model"));
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "compaction_failed",
      reason: "no routing row for small-model",
    });
  });

  it("renders a vanished conversation as no_session", async () => {
    const driver = vi.fn().mockResolvedValue({ status: "not_found", missing: "conversation" });
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({ status: "no_session" });
  });

  it("reports a vanished profile as profile_not_found, not no_session", async () => {
    // The session resolved moments earlier, so "send a message first" would
    // be advice that cannot fix anything.
    const driver = vi.fn().mockResolvedValue({ status: "not_found", missing: "profile" });
    const { conversations } = buildCompactTransport({ ...OWNED, compactConversation: driver });
    const res = await conversations.compact("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
  });
});
