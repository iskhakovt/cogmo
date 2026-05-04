import { describe, expect, it, vi } from "vitest";
import {
  mockAgentStore,
  mockDeliveryHandle,
  mockDeliveryRouter,
  mockMemoryProvider,
  mockProvider,
  mockStep,
  mockToolRegistry,
  mockTransportStore,
} from "../test/factories.js";
import type { HandleMessageDeps } from "./handle-message.js";
import { createHandleMessage } from "./handle-message.js";
import { ToolRegistry } from "./tools.js";

function mockDeps(overrides?: Partial<HandleMessageDeps>): HandleMessageDeps {
  return {
    agentStore: mockAgentStore(),
    transportStore: mockTransportStore(),
    provider: mockProvider(),
    tools: mockToolRegistry(),
    memory: mockMemoryProvider(),
    promptSource: { assemble: vi.fn().mockResolvedValue("system prompt") },
    fileService: {
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    attachments: {
      upload: vi.fn().mockResolvedValue("inbound/test.jpg"),
      download: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
    },
    debounceConfig: { idleTimeoutMs: 0, maxWaitMs: 0, resumePolicy: "debounce" as const },
    deliveryRouter: mockDeliveryRouter(),
    runStreamingAgentLoop: vi.fn().mockResolvedValue({
      text: "Hello from assistant",
      messages: [],
      newMessages: [
        { role: "assistant", content: [{ type: "text", text: "Hello from assistant" }] },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "mock-model",
      iterations: 1,
    }),
    ...overrides,
  };
}

const testEvent = {
  data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
};

const testRunId = "run-123";

describe("createHandleMessage", () => {
  it("loads unbatched inbound messages via transportStore", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.transportStore.getUnbatchedInbound).toHaveBeenCalledWith("conv-1", null);
  });

  it("calls promptSource.assemble with agentStore and profileId", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.promptSource.assemble).toHaveBeenCalledWith(deps.agentStore, {
      profileId: "profile-1",
      channelTypes: [],
    });
  });

  it("uses model from profile", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.runStreamingAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-20250514" }),
    );
  });

  it("creates service with memory recall and retain", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.runStreamingAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        service: expect.objectContaining({
          memory: expect.objectContaining({
            recall: expect.any(Function),
            retain: expect.any(Function),
          }),
        }),
      }),
    );
  });

  it("freezes profile+model snapshot at turn start — survives mid-turn profile switch", async () => {
    // Simulate getProfile being called once at snapshot time (returning snapshot model),
    // then a second getProfile call later (e.g. for auto-recall) returning a different model
    // — the stamps on messages must still reflect the snapshot, not the later value.
    const getProfile = vi
      .fn()
      .mockResolvedValueOnce({
        id: "profile-1",
        userId: null,
        name: "assistant",
        basePrompt: "a",
        model: "claude-sonnet-4-20250514",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic" as const,
        toolSet: [],
      })
      .mockResolvedValue({
        id: "profile-1",
        userId: null,
        name: "assistant",
        basePrompt: "b",
        model: "claude-opus-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic" as const,
        toolSet: [],
      });
    const deps = mockDeps({
      agentStore: mockAgentStore({ getProfile }),
    });
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Pin that the mid-turn reload actually happened — the test would false-pass if
    // the second getProfile call were removed (e.g., someone caches the snapshot globally).
    expect(getProfile.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Both inserts stamped with the first (snapshot) profile+model, not the later change
    expect(deps.agentStore.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-1", model: "claude-sonnet-4-20250514" }),
    );
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-1", model: "claude-sonnet-4-20250514" }),
    );
  });

  it("inserts user and assistant messages via agentStore", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // User message via insertMessage — stamped with the turn snapshot
    expect(deps.agentStore.insertMessage).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        lastInboundMessageId: "inbound-1",
        profileId: "profile-1",
        model: "claude-sonnet-4-20250514",
      }),
    );
    // Assistant + tool turns via insertMessages (atomic batch) — same snapshot
    expect(deps.agentStore.insertMessages).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        lastInboundMessageId: "inbound-1",
        profileId: "profile-1",
        model: "claude-sonnet-4-20250514",
      }),
    );
  });

  it("emits response/ready with conversationId and messageId", async () => {
    const deps = mockDeps();
    const step = mockStep();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step,
      runId: testRunId,
    });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "send-response",
      expect.objectContaining({
        name: "response/ready",
        data: { conversationId: "conv-1", messageId: "msg-1" },
      }),
    );
  });

  it("calls deliveryRouter.prepare with full routing context", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.deliveryRouter.prepare).toHaveBeenCalledWith({
      conversationId: "conv-1",
      runId: "run-123",
      isPrivate: true,
      maxInboundId: "inbound-1",
      prevCursor: null,
    });
  });

  it("passes onEvent that calls delivery.push", async () => {
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockImplementation(async (params) => {
        await params.onEvent({ type: "text_delta", text: "hi" });
        return {
          text: "hi",
          messages: [],
          newMessages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock",
          iterations: 1,
        };
      }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(handle.push).toHaveBeenCalledWith({ type: "text_delta", text: "hi" });
  });

  it("calls delivery.finish on success", async () => {
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(handle.finish).toHaveBeenCalled();
  });

  it("calls delivery.abort on error and re-throws", async () => {
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockRejectedValue(new Error("LLM failed")),
    });

    await expect(
      (createHandleMessage(deps) as any).fn({
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      }),
    ).rejects.toThrow("LLM failed");

    expect(handle.abort).toHaveBeenCalledWith("LLM failed");
    expect(handle.finish).not.toHaveBeenCalled();
  });

  it("calls delivery.deliverBatch after persist when there are batch targets", async () => {
    const handle = mockDeliveryHandle({
      hasBatchTargets: vi.fn().mockReturnValue(true),
    });
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(handle.deliverBatch).toHaveBeenCalledWith("Hello from assistant", undefined);
  });

  it("skips deliverBatch when there are no batch targets (streaming-only setup)", async () => {
    const handle = mockDeliveryHandle({
      hasBatchTargets: vi.fn().mockReturnValue(false),
    });
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // No batch targets → no S3 downloads, no deliverBatch call.
    expect(handle.deliverBatch).not.toHaveBeenCalled();
  });

  it("skips processing when triggerInboundId is stale", async () => {
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getLastAssistantMessage: vi
          .fn()
          .mockResolvedValue({ id: "msg-2", lastInboundMessageId: "inbound-5" }),
      }),
    });

    const result = await (createHandleMessage(deps) as any).fn({
      event: { data: { conversationId: "conv-1", triggerInboundId: "inbound-3" } },
      step: mockStep(),
      runId: testRunId,
    });

    expect(result).toEqual({ status: "skipped", reason: "stale" });
    expect(deps.runStreamingAgentLoop).not.toHaveBeenCalled();
  });

  it("skips with null triggerInboundId (flush) — does NOT trigger staleness guard", async () => {
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getLastAssistantMessage: vi
          .fn()
          .mockResolvedValue({ id: "msg-2", lastInboundMessageId: "inbound-5" }),
      }),
    });

    const result = await (createHandleMessage(deps) as any).fn({
      event: { data: { conversationId: "conv-1", triggerInboundId: null } },
      step: mockStep(),
      runId: testRunId,
    });

    // Should process, not skip — null trigger bypasses staleness guard
    expect(result).toEqual({ status: "processed", conversationId: "conv-1" });
  });

  it("emits flush event when resume policy is flush", async () => {
    const step = mockStep();
    const deps = mockDeps({
      debounceConfig: { idleTimeoutMs: 3000, maxWaitMs: 30000, resumePolicy: "flush" as const },
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step,
      runId: testRunId,
    });

    // Should have called sendEvent twice: send-response + flush
    expect(step.sendEvent).toHaveBeenCalledWith(
      "flush",
      expect.objectContaining({
        name: "inbound/ready",
        data: { conversationId: "conv-1", triggerInboundId: null },
      }),
    );
  });

  it("does not emit flush when resume policy is debounce", async () => {
    const step = mockStep();
    const deps = mockDeps({
      debounceConfig: { idleTimeoutMs: 3000, maxWaitMs: 30000, resumePolicy: "debounce" as const },
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step,
      runId: testRunId,
    });

    // Only send-response, no flush
    const flushCalls = step.sendEvent.mock.calls.filter(([id]: any) => id === "flush");
    expect(flushCalls).toHaveLength(0);
  });

  it("skips countTokens when fast path detects under budget", async () => {
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 1000, outputTokens: 100 }),
      }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // countTokens should NOT be called — fast path skips it
    expect(deps.provider.countTokens).not.toHaveBeenCalled();
  });

  it("forces counting when prior output is the -1 pre-migration sentinel", async () => {
    // Pre-migration rows carry outputTokens = -1. The fast path must NOT skip.
    const countTokens = vi.fn().mockResolvedValue(50_000);
    const deps = mockDeps({
      provider: mockProvider({ countTokens }),
      agentStore: mockAgentStore({
        getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 1000, outputTokens: -1 }),
      }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(countTokens).toHaveBeenCalled();
  });

  it("persists inputTokens and outputTokens on assistant message", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Both counts from the loop's usage must reach insertMessages so the
    // next turn's fast path can include them in the starting-input estimate.
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        lastMessageInputTokens: 10,
        lastMessageOutputTokens: 5,
      }),
    );
  });

  it("runs compaction when countTokens reports over threshold", async () => {
    // countTokens returns over 60% of budget (173_616 * 0.6 ≈ 104_170)
    // First call: over threshold. Second call (after clearing): under.
    const countTokens = vi.fn().mockResolvedValueOnce(120_000).mockResolvedValueOnce(50_000);
    const deps = mockDeps({
      provider: mockProvider({ countTokens }),
      agentStore: mockAgentStore({
        // No prior tokens → fast path won't skip
        getLastTokens: vi.fn().mockResolvedValue(null),
      }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // countTokens should have been called (compaction ran)
    expect(countTokens).toHaveBeenCalled();
    // Agent loop should still have been called
    expect(deps.runStreamingAgentLoop).toHaveBeenCalled();
  });

  it("pushes status event through delivery when summarization runs", async () => {
    // Over 80% of budget → triggers summarization
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(150_000) // initial: over 80%
      .mockResolvedValueOnce(150_000) // after tool clearing (nothing to clear): still over
      .mockResolvedValueOnce(50_000); // after summarization: under
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      provider: mockProvider({
        countTokens,
        // Summarization uses provider.chat — return a text response
        chat: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Summary of conversation" }],
          stopReason: "end_turn",
          model: "mock",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      }),
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      agentStore: mockAgentStore({
        getLastTokens: vi.fn().mockResolvedValue(null),
        // Need history with enough messages to trigger summarization (> keepTurns=6)
        getHistory: vi.fn().mockResolvedValue([
          { role: "user", content: "m1" },
          { role: "assistant", content: "r1" },
          { role: "user", content: "m2" },
          { role: "assistant", content: "r2" },
          { role: "user", content: "m3" },
          { role: "assistant", content: "r3" },
          { role: "user", content: "m4" },
          { role: "assistant", content: "r4" },
        ]),
      }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Should have pushed a status event for summarization
    const statusCalls = handle.push.mock.calls.filter(([event]: any) => event.type === "status");
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0][0].message).toBe("Summarizing conversation...");
  });

  it("calls mcpRegistry.resolveTools with the profile's toolSet globs", async () => {
    const resolveTools = vi.fn().mockResolvedValue([]);
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: null,
          name: "assistant",
          basePrompt: "test",
          model: "claude-sonnet-4-20250514",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          toolSet: ["mcp__github__*", "memory_*"],
        }),
      }),
      mcpRegistry: {
        start: vi.fn(),
        stop: vi.fn(),
        resolveTools,
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn(),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(resolveTools).toHaveBeenCalledWith({
      toolGlobs: ["mcp__github__*", "memory_*"],
    });
  });

  it("merges MCP tools into the per-turn registry alongside built-ins", async () => {
    const mcpToolSpec = {
      name: "mcp__github__create_pr",
      description: "Open a PR",
      inputSchema: { type: "object" as const, properties: {} },
      durable: true,
      handler: vi.fn().mockResolvedValue("ok"),
    };
    // Real ToolRegistry — mockToolRegistry doesn't populate snapshot()
    // because register/snapshot are vi.fn stubs.
    const builtIns = new ToolRegistry();
    builtIns.register({
      name: "memory_recall",
      description: "recall",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "ok",
    });
    const deps = mockDeps({
      tools: builtIns,
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: null,
          name: "assistant",
          basePrompt: "test",
          model: "claude-sonnet-4-20250514",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          toolSet: ["*"],
        }),
      }),
      mcpRegistry: {
        start: vi.fn(),
        stop: vi.fn(),
        resolveTools: vi.fn().mockResolvedValue([mcpToolSpec]),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn(),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // The merged ToolRegistry passed into runStreamingAgentLoop must contain both.
    const passedTools = (deps.runStreamingAgentLoop as any).mock.calls[0][0].tools;
    expect(passedTools.get("memory_recall")).toBeDefined();
    expect(passedTools.get("mcp__github__create_pr")).toBeDefined();
  });

  it("returns no tools for an empty profile.toolSet (chat-only profile)", async () => {
    const builtIns = new ToolRegistry();
    builtIns.register({
      name: "memory_recall",
      description: "recall",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "ok",
    });
    const deps = mockDeps({
      tools: builtIns,
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: null,
          name: "assistant",
          basePrompt: "test",
          model: "claude-sonnet-4-20250514",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          toolSet: [],
        }),
      }),
    });

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    const passedTools = (deps.runStreamingAgentLoop as any).mock.calls[0][0].tools;
    expect(passedTools.snapshot()).toHaveLength(0);
  });
});
