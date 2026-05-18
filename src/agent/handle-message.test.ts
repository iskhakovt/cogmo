import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { z } from "zod";
import type { inboundReady } from "../inngest/events.js";
import { ProviderConfigError } from "../llm/resolver.js";
import { logger } from "../logger.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { SkillRunner } from "../skills/runner.js";
import { expectDefined } from "../test/assertions.js";
import {
  invokeInngestFn,
  invokeInngestOnFailure,
  type MockStep,
  mockAgentStore,
  mockDeliveryHandle,
  mockDeliveryRouter,
  mockMemoryProvider,
  mockProvider,
  mockResolver,
  mockStep,
  mockToolRegistry,
  mockTransportStore,
  mockVoiceBundle,
  mockVoiceResolver,
} from "../test/factories.js";
import type { HandleMessageDeps } from "./handle-message.js";
import { createHandleMessage } from "./handle-message.js";
import type { ImageToolsLoader } from "./image-tools-loader.js";
import { ToolRegistry } from "./tools.js";

type InboundReadyData = z.infer<typeof inboundReady.schema>;

interface HandleMessageCtx {
  event: { data: InboundReadyData };
  step: MockStep;
  runId: string;
}

// Shape Inngest passes to `onFailure`: `data` wraps the original event
// alongside `run_id`. `step` here is a partial — onFailure only calls
// `run` + `sendEvent`, so we keep the minimal surface our handler
// touches rather than reach for the full Inngest step type.
interface HandleMessageFailureCtx {
  event: {
    data: {
      run_id: string;
      event: { data: InboundReadyData };
    };
  };
  error: Error;
  step: {
    run: ReturnType<typeof vi.fn>;
    sendEvent: ReturnType<typeof vi.fn>;
  };
}

function mockDeps(overrides?: Partial<HandleMessageDeps>): HandleMessageDeps {
  return {
    runInTx: (cb) => cb({} as never),
    agentStore: mockAgentStore(),
    transportStore: mockTransportStore(),
    resolveProvider: mockResolver(),
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
    userTimezone: "UTC",
    ...overrides,
  };
}

const testEvent: { data: InboundReadyData } = {
  data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
};

const testRunId = "run-123";

describe("createHandleMessage", () => {
  it("loads unbatched inbound messages via transportStore", async () => {
    const deps = mockDeps();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.transportStore.getUnbatchedInbound).toHaveBeenCalledWith(
      expect.anything(),
      "conv-1",
      null,
    );
  });

  it("calls promptSource.assemble with the loaded conversation context", async () => {
    const deps = mockDeps();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // assemble now receives pre-loaded data (profile + rules + the per-turn
    // tool catalog), not a store reference. The use case
    // `loadConversationContext` does the loading inside one transaction;
    // the prompt source is a pure formatter.
    expect(deps.promptSource.assemble).toHaveBeenCalledWith({
      profile: expect.objectContaining({ id: "profile-1" }),
      rules: [],
      voiceMode: false,
      toolDefinitions: expect.any(Array),
    });
  });

  it("uses model from profile", async () => {
    const deps = mockDeps();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.runStreamingAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
    );
  });

  it("creates service with memory recall and retain", async () => {
    const deps = mockDeps();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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
        model: "claude-sonnet-4-6",
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
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Pin that the mid-turn reload actually happened — the test would false-pass if
    // the second getProfile call were removed (e.g., someone caches the snapshot globally).
    expect(getProfile.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Both inserts stamped with the first (snapshot) profile+model, not the later change
    expect(deps.agentStore.insertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profileId: "profile-1", model: "claude-sonnet-4-6" }),
    );
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profileId: "profile-1", model: "claude-sonnet-4-6" }),
    );
  });

  it("inserts user and assistant messages via agentStore", async () => {
    const deps = mockDeps();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // User message via insertMessage — stamped with the turn snapshot
    expect(deps.agentStore.insertMessage).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.insertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "user",
        lastInboundMessageId: "inbound-1",
        profileId: "profile-1",
        model: "claude-sonnet-4-6",
      }),
    );
    // Assistant + tool turns via insertMessages (atomic batch) — same snapshot
    expect(deps.agentStore.insertMessages).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "conv-1",
        lastInboundMessageId: "inbound-1",
        profileId: "profile-1",
        model: "claude-sonnet-4-6",
      }),
    );
  });

  it("emits response/ready with conversationId and messageId", async () => {
    const deps = mockDeps();
    const step = mockStep();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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

  // Per-invocation child logger threads runId + conversationId through the
  // agent loop so future Class C/D telemetry inside the loop can be joined
  // to `conversation/degraded` / `conversation/errored` events by those two
  // fields without per-emission ceremony. See design/agent-resilience.md →
  // Telemetry.
  it("passes a child turnLogger bound to runId + conversationId into the agent loop", async () => {
    // Module-level `const log = logger.child(...)` calls elsewhere in `src/`
    // execute at import time — before this spy is installed — so they don't
    // route through it. The spy reliably catches only the orchestrator's
    // per-turn child creation, which is what we want to assert against.
    const childLogger = mock<ReturnType<typeof logger.child>>();
    const childSpy = vi.spyOn(logger, "child").mockReturnValue(childLogger);

    try {
      const deps = mockDeps();
      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(childSpy).toHaveBeenCalledTimes(1);
      expect(childSpy).toHaveBeenCalledWith({
        runId: testRunId,
        conversationId: "conv-1",
      });
      expect(deps.runStreamingAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({ turnLogger: childLogger }),
      );
    } finally {
      childSpy.mockRestore();
    }
  });

  it("calls deliveryRouter.prepare with full routing context", async () => {
    const deps = mockDeps();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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
      kind: "reply",
      streamOpts: { chunkChars: 4000, allowEdits: true },
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

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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
      invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      }),
    ).rejects.toThrow("LLM failed");

    expect(handle.abort).toHaveBeenCalledWith("LLM failed");
    expect(handle.finish).not.toHaveBeenCalled();
  });

  // Provider-error → Inngest retry policy translation. A 400 (or any 4xx
  // except 408/425/429) is deterministic — same request, same failure.
  // Wrapping in NonRetriableError stops Inngest from burning retries.
  it("wraps non-retriable provider errors in NonRetriableError", async () => {
    const handle = mockDeliveryHandle();
    const apiError = Object.assign(new Error("Bad Request"), { status: 400 });
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockRejectedValue(apiError),
    });

    let caught: unknown;
    try {
      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).constructor.name).toBe("NonRetriableError");
    expect((caught as Error).message).toBe("Bad Request");
    expect((caught as Error & { cause?: unknown }).cause).toBe(apiError);
    expect(handle.abort).toHaveBeenCalledWith("Bad Request");
  });

  // Inngest invokes `onFailure` after retries exhaust (or immediately on a
  // NonRetriableError). Without this handler the run dies silently — no user
  // notification, no downstream signal. The handler reaches the user via
  // `notifyConversation` (no in-flight stream to push status into) and emits
  // `conversation/errored` so future recovery / evolution paths can react.
  it("onFailure notifies user and emits conversation/errored", async () => {
    const notifyConversation = vi.fn().mockResolvedValue(undefined);
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ notifyConversation }),
    });
    const fn = createHandleMessage(deps);

    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const stepRun = vi
      .fn()
      .mockImplementation(async (_id: string, body: () => Promise<unknown>) => body());
    const stepCtx = { run: stepRun, sendEvent };
    const failureEvent = {
      data: {
        run_id: "run-failed-1",
        event: { data: { conversationId: "conv-1", triggerInboundId: "inbound-1" } },
      },
    };
    // Reflect the production shape: handle-message rewraps non-retriable
    // provider errors as NonRetriableError, so `error` Inngest passes to
    // onFailure has name=NonRetriableError and `cause` carries the original
    // (e.g. BadRequestError). Asserting against the unwrapped class would
    // false-pass; we want both surfaced.
    const upstream = new Error("Bad Request");
    upstream.name = "BadRequestError";
    const error = new Error("Bad Request", { cause: upstream });
    error.name = "NonRetriableError";

    // Track call order — emission must precede notification so the durable
    // signal is recorded before the best-effort user-facing courtesy.
    const callOrder: string[] = [];
    sendEvent.mockImplementation(async (_id: string) => {
      callOrder.push("sendEvent");
    });
    notifyConversation.mockImplementation(async () => {
      callOrder.push("notifyConversation");
    });

    await invokeInngestOnFailure<HandleMessageFailureCtx>(fn, {
      event: failureEvent,
      error,
      step: stepCtx,
    });

    expect(callOrder).toEqual(["sendEvent", "notifyConversation"]);

    expect(notifyConversation).toHaveBeenCalledTimes(1);
    expect(notifyConversation.mock.calls[0]![0]).toBe("conv-1");
    expect(notifyConversation.mock.calls[0]![1]).toMatch(/error/i);

    expect(sendEvent).toHaveBeenCalledTimes(1);
    const [stepId, payload] = sendEvent.mock.calls[0]!;
    expect(stepId).toBe("emit-conversation-errored");
    expect(payload).toMatchObject({
      name: "conversation/errored",
      data: {
        conversationId: "conv-1",
        runId: "run-failed-1",
        triggerInboundId: "inbound-1",
        errorClass: "NonRetriableError",
        causeClass: "BadRequestError",
        errorMessage: "Bad Request",
      },
    });
  });

  // When the run failed without an upstream cause (e.g. our own programmer
  // error rather than a wrapped provider error), causeClass is null —
  // distinguishable from "we didn't capture it" so downstream consumers
  // know there's nothing to unwrap.
  it("onFailure emits causeClass: null when error has no cause", async () => {
    const deps = mockDeps();
    const fn = createHandleMessage(deps);
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const stepRun = vi
      .fn()
      .mockImplementation(async (_id: string, body: () => Promise<unknown>) => body());
    const stepCtx = { run: stepRun, sendEvent };
    const failureEvent = {
      data: {
        run_id: "run-failed-3",
        event: { data: { conversationId: "conv-3", triggerInboundId: null } },
      },
    };
    const error = new Error("internal");

    await invokeInngestOnFailure<HandleMessageFailureCtx>(fn, {
      event: failureEvent,
      error,
      step: stepCtx,
    });

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent.mock.calls[0]![1]).toMatchObject({
      data: {
        triggerInboundId: null,
        causeClass: null,
      },
    });
  });

  // Notification is best-effort. If `notifyConversation` throws (e.g. DB
  // outage on session lookup), the handler must NOT propagate the error —
  // `conversation/errored` has already been emitted (the durable signal is
  // safe), and onFailure throwing would just produce a useless retry storm.
  it("onFailure swallows notifyConversation failures so the durable event sticks", async () => {
    const notifyConversation = vi.fn().mockRejectedValue(new Error("db offline"));
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ notifyConversation }),
    });
    const fn = createHandleMessage(deps);

    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const stepRun = vi
      .fn()
      .mockImplementation(async (_id: string, body: () => Promise<unknown>) => body());
    const stepCtx = { run: stepRun, sendEvent };
    const failureEvent = {
      data: {
        run_id: "run-failed-2",
        event: { data: { conversationId: "conv-2", triggerInboundId: "inbound-2" } },
      },
    };
    const error = new Error("boom");

    // Must NOT throw, even though notifyConversation rejects.
    await expect(
      invokeInngestOnFailure<HandleMessageFailureCtx>(fn, {
        event: failureEvent,
        error,
        step: stepCtx,
      }),
    ).resolves.toBeUndefined();

    // Durable signal still emitted — the whole point.
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent.mock.calls[0]![0]).toBe("emit-conversation-errored");
    // Notify was attempted.
    expect(notifyConversation).toHaveBeenCalledTimes(1);
  });

  it("rethrows retriable provider errors as-is so Inngest retries them", async () => {
    const handle = mockDeliveryHandle();
    const transientError = Object.assign(new Error("rate limited"), { status: 429 });
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockRejectedValue(transientError),
    });

    let caught: unknown;
    try {
      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(transientError);
    expect((caught as Error).constructor.name).not.toBe("NonRetriableError");
  });

  it("calls delivery.deliverBatch after persist when there are batch targets", async () => {
    const handle = mockDeliveryHandle({
      hasBatchTargets: vi.fn().mockReturnValue(true),
    });
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(handle.deliverBatch).toHaveBeenCalledWith("Hello from assistant", undefined, undefined);
  });

  it("skips deliverBatch when there are no batch targets (streaming-only setup)", async () => {
    const handle = mockDeliveryHandle({
      hasBatchTargets: vi.fn().mockReturnValue(false),
    });
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // No batch targets → no S3 downloads, no deliverBatch call.
    expect(handle.deliverBatch).not.toHaveBeenCalled();
  });

  it("resolves inbound document_ref into a base64 DocumentBlock for the agent loop", async () => {
    const docBytes = Buffer.from("PDF body bytes");
    const deps = mockDeps({
      // History must contain at least one user message — handle-message
      // overrides the trailing user message with resolved blocks.
      agentStore: mockAgentStore({
        getHistory: vi
          .fn()
          .mockResolvedValue([{ role: "user", content: "summarize this document" }]),
      }),
      transportStore: mockTransportStore({
        getUnbatchedInbound: vi.fn().mockResolvedValue([
          {
            id: "inbound-1",
            content: [
              { type: "text", text: "summarize" },
              {
                type: "document",
                path: "inbound/abc.pdf",
                mediaType: "application/pdf",
                name: "report.pdf",
              },
            ],
          },
        ]),
      }),
      attachments: {
        upload: vi.fn().mockResolvedValue("inbound/x"),
        download: vi.fn().mockResolvedValue(docBytes),
      },
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.attachments.download).toHaveBeenCalledWith("inbound/abc.pdf");

    // The last user message handed to the agent loop must contain the resolved
    // DocumentBlock with base64-encoded bytes and the original filename.
    const callArgs = expectDefined(
      vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
      "runStreamingAgentLoop call",
    )[0];
    const lastMsg = expectDefined(callArgs.messages.at(-1), "last message");
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContainEqual({
      type: "document",
      source: "base64",
      data: docBytes.toString("base64"),
      mediaType: "application/pdf",
      name: "report.pdf",
    });
  });

  it("omits name on resolved DocumentBlock when inbound block had no name", async () => {
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getHistory: vi.fn().mockResolvedValue([{ role: "user", content: "see attached" }]),
      }),
      transportStore: mockTransportStore({
        getUnbatchedInbound: vi.fn().mockResolvedValue([
          {
            id: "inbound-1",
            content: [
              {
                type: "document",
                path: "inbound/abc.pdf",
                mediaType: "application/pdf",
              },
            ],
          },
        ]),
      }),
      attachments: {
        upload: vi.fn().mockResolvedValue("inbound/x"),
        download: vi.fn().mockResolvedValue(Buffer.from("x")),
      },
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    const callArgs = expectDefined(
      vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
      "runStreamingAgentLoop call",
    )[0];
    const lastMsg = expectDefined(callArgs.messages.at(-1), "last message");
    if (!Array.isArray(lastMsg.content)) throw new Error("expected ContentBlock[]");
    const docBlock = lastMsg.content.find((b) => b.type === "document");
    expect(docBlock).not.toHaveProperty("name");
  });

  it("delivers generated documents via batch path when send_document tool ran", async () => {
    const docBytes = Buffer.from("# Hello");
    const handle = mockDeliveryHandle({
      hasBatchTargets: vi.fn().mockReturnValue(true),
    });
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      attachments: {
        upload: vi.fn().mockResolvedValue("inbound/x"),
        download: vi.fn().mockResolvedValue(docBytes),
      },
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "here you go",
        messages: [],
        newMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "send_document",
                input: { filename: "report.md", content: "# Hello" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tu_1",
                content: JSON.stringify({
                  path: "generated/abc.md",
                  mediaType: "text/markdown",
                  name: "report.md",
                }),
              },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "here you go" }] },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 1,
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.attachments.download).toHaveBeenCalledWith("generated/abc.md");
    expect(handle.deliverBatch).toHaveBeenCalledWith("here you go", undefined, [
      { data: docBytes, mediaType: "text/markdown", name: "report.md" },
    ]);
  });

  it("survives a partial document download failure (one ok, one rejected)", async () => {
    const okBytes = Buffer.from("ok");
    const handle = mockDeliveryHandle({
      hasBatchTargets: vi.fn().mockReturnValue(true),
    });
    const download = vi
      .fn()
      // first download succeeds
      .mockResolvedValueOnce(okBytes)
      // second rejects
      .mockRejectedValueOnce(new Error("S3 boom"));

    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      attachments: { upload: vi.fn().mockResolvedValue("inbound/x"), download },
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "here",
        messages: [],
        newMessages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu_a", name: "send_document", input: {} },
              { type: "tool_use", id: "tu_b", name: "send_document", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tu_a",
                content: JSON.stringify({
                  path: "generated/a.md",
                  mediaType: "text/markdown",
                  name: "a.md",
                }),
              },
              {
                type: "tool_result",
                toolUseId: "tu_b",
                content: JSON.stringify({
                  path: "generated/b.md",
                  mediaType: "text/markdown",
                  name: "b.md",
                }),
              },
            ],
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "mock-model",
        iterations: 1,
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Only the fulfilled document is delivered; the failed one is logged-and-skipped.
    expect(handle.deliverBatch).toHaveBeenCalledWith("here", undefined, [
      { data: okBytes, mediaType: "text/markdown", name: "a.md" },
    ]);
  });

  // Status guard — `recover-conversation` flips a conversation to `errored`
  // after retries on this function exhausted (or it failed non-retriably).
  // handle-message must refuse to spend more LLM calls until status flips
  // back to `active` — covers any unrecoverable failure class (auth
  // revoked, model deprecated, content moderation, malformed tool schema,
  // programmer bug) that would otherwise produce a retry-storm with every
  // new inbound.
  it("early-returns with reason: errored when conversations.status is 'errored'", async () => {
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: "conv-1",
          userId: "user-1",
          profileId: "profile-1",
          isPrivate: true,
          status: "errored",
        }),
      }),
    });
    const result = await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });
    expect(result).toEqual({ status: "skipped", reason: "errored" });
    expect(deps.runStreamingAgentLoop).not.toHaveBeenCalled();
    expect(deps.agentStore.insertMessage).not.toHaveBeenCalled();
  });

  it("skips processing when triggerInboundId is stale", async () => {
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getLastAssistantMessage: vi
          .fn()
          .mockResolvedValue({ id: "msg-2", lastInboundMessageId: "inbound-5" }),
      }),
    });

    const result = await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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

    const result = await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step,
      runId: testRunId,
    });

    // Only send-response, no flush
    const flushCalls = step.sendEvent.mock.calls.filter(([id]: any) => id === "flush");
    expect(flushCalls).toHaveLength(0);
  });

  it("skips countTokens when fast path detects under budget", async () => {
    const countTokens = vi.fn().mockResolvedValue(0);
    const deps = mockDeps({
      resolveProvider: mockResolver(mockProvider({ countTokens })),
      agentStore: mockAgentStore({
        getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 1000, outputTokens: 100 }),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // countTokens should NOT be called — fast path skips it
    expect(countTokens).not.toHaveBeenCalled();
  });

  it("forces counting when prior output is the -1 pre-migration sentinel", async () => {
    // Pre-migration rows carry outputTokens = -1. The fast path must NOT skip.
    const countTokens = vi.fn().mockResolvedValue(50_000);
    const deps = mockDeps({
      resolveProvider: mockResolver(mockProvider({ countTokens })),
      agentStore: mockAgentStore({
        getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 1000, outputTokens: -1 }),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(countTokens).toHaveBeenCalled();
  });

  it("persists inputTokens and outputTokens on assistant message", async () => {
    const deps = mockDeps();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Both counts from the loop's usage must reach insertMessages so the
    // next turn's fast path can include them in the starting-input estimate.
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lastMessageInputTokens: 10,
        lastMessageOutputTokens: 5,
      }),
    );
  });

  it("runs compaction when countTokens reports over threshold", async () => {
    // countTokens returns over 60% of budget (926_000 * 0.6 ≈ 555_600)
    // First call: over threshold. Second call (after clearing): under.
    const countTokens = vi.fn().mockResolvedValueOnce(600_000).mockResolvedValueOnce(50_000);
    const deps = mockDeps({
      resolveProvider: mockResolver(mockProvider({ countTokens })),
      agentStore: mockAgentStore({
        // No prior tokens → fast path won't skip
        getLastTokens: vi.fn().mockResolvedValue(null),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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
    // Over 80% of budget (926_000 * 0.8 ≈ 740_800) → triggers summarization
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(800_000) // initial: over 80%
      .mockResolvedValueOnce(800_000) // after tool clearing (nothing to clear): still over
      .mockResolvedValueOnce(50_000); // after summarization: under
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      resolveProvider: mockResolver(
        mockProvider({
          countTokens,
          // Summarization uses provider.chat — return a text response
          chat: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "Summary of conversation" }],
            stopReason: "end_turn",
            model: "mock",
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
        }),
      ),
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

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Should have pushed a status event for summarization
    const statusCalls = vi
      .mocked(handle.push)
      .mock.calls.filter(([event]) => event.type === "status");
    expect(statusCalls).toHaveLength(1);
    const firstStatus = statusCalls[0]?.[0];
    if (firstStatus?.type !== "status") throw new Error("expected first status event");
    expect(firstStatus.message).toBe("Summarizing conversation...");
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
          model: "claude-sonnet-4-6",
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
        toolBudget: () => 25,
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn(),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
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
          model: "claude-sonnet-4-6",
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
        toolBudget: () => 25,
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn(),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // The merged ToolRegistry passed into runStreamingAgentLoop must contain both.
    const passedTools = expectDefined(
      vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
      "runStreamingAgentLoop call",
    )[0].tools;
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
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          toolSet: [],
        }),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    const passedTools = expectDefined(
      vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
      "runStreamingAgentLoop call",
    )[0].tools;
    expect(passedTools.snapshot()).toHaveLength(0);
  });

  describe("per-turn tool catalog flows into promptSource.assemble", () => {
    // Regression guards for the prompt-introspection bug: the `# Tools`
    // section in the system prompt was built from the static bootstrap
    // catalog while `composeTurnTools` advertised a wider per-turn set
    // (built-ins + image + skills + MCP) to the LLM API. The model could
    // call those tools but couldn't see them in its own self-description.
    // These tests pin that every per-turn source surfaces in the
    // `toolDefinitions` arg, and that the prompt catalog stays in sync
    // with the registry handed to `runStreamingAgentLoop`.

    function toolNames(defs: ReadonlyArray<{ name: string }>): string[] {
      return defs.map((d) => d.name);
    }

    function profileWithAllTools() {
      return {
        id: "profile-1",
        userId: null,
        name: "assistant",
        basePrompt: "test",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic" as const,
        toolSet: ["*"],
      };
    }

    function firstAssembleArg(deps: HandleMessageDeps) {
      const [call] = expectDefined(
        vi.mocked(deps.promptSource.assemble).mock.calls[0],
        "promptSource.assemble call",
      );
      return call;
    }

    it("surfaces image tools in the toolDefinitions arg", async () => {
      const imageToolsLoader = mock<ImageToolsLoader>();
      imageToolsLoader.getTools.mockResolvedValue([
        {
          name: "generate_image",
          description: "generate",
          inputSchema: { type: "object", properties: {} },
          handler: async () => "ok",
        },
      ]);
      const deps = mockDeps({
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue(profileWithAllTools()),
        }),
        imageToolsLoader,
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(toolNames(firstAssembleArg(deps).toolDefinitions ?? [])).toContain("generate_image");
    });

    it("surfaces skill tools in the toolDefinitions arg", async () => {
      const skillRunner = mock<SkillRunner>();
      skillRunner.listToolDefs.mockResolvedValue([
        {
          name: "echo",
          description: "echo a number",
          inputs: { type: "object", properties: {} },
          tier: "wasm",
          riskTier: "notify",
          gitSha: "abc1234",
        },
      ]);
      const deps = mockDeps({
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue(profileWithAllTools()),
        }),
        skillRunner,
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(toolNames(firstAssembleArg(deps).toolDefinitions ?? [])).toContain("echo");
    });

    it("surfaces MCP tools in the toolDefinitions arg", async () => {
      const mcpRegistry = mock<McpRegistry>();
      mcpRegistry.resolveTools.mockResolvedValue([
        {
          name: "mcp__github__create_pr",
          description: "open a PR",
          inputSchema: { type: "object", properties: {} },
          durable: true,
          handler: async () => "ok",
        },
      ]);
      const deps = mockDeps({
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue(profileWithAllTools()),
        }),
        mcpRegistry,
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(toolNames(firstAssembleArg(deps).toolDefinitions ?? [])).toContain(
        "mcp__github__create_pr",
      );
    });

    it("passes an empty toolDefinitions array when profile.toolSet is empty", async () => {
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
          getProfile: vi.fn().mockResolvedValue({ ...profileWithAllTools(), toolSet: [] }),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(firstAssembleArg(deps).toolDefinitions).toEqual([]);
    });

    it("toolDefinitions in assemble matches the tool names in runStreamingAgentLoop.tools", async () => {
      // Single source of truth: the catalog the model sees in its prompt
      // must be the same set we advertise to the LLM API. A future
      // refactor that splits these two call sites should fail here.
      const builtIns = new ToolRegistry();
      builtIns.register({
        name: "memory_recall",
        description: "recall",
        inputSchema: { type: "object", properties: {} },
        handler: async () => "ok",
      });
      const mcpRegistry = mock<McpRegistry>();
      mcpRegistry.resolveTools.mockResolvedValue([
        {
          name: "mcp__github__create_pr",
          description: "open a PR",
          inputSchema: { type: "object", properties: {} },
          durable: true,
          handler: async () => "ok",
        },
      ]);
      const deps = mockDeps({
        tools: builtIns,
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue(profileWithAllTools()),
        }),
        mcpRegistry,
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      const [loopCall] = expectDefined(
        vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
        "runStreamingAgentLoop call",
      );
      const promptNames = toolNames(firstAssembleArg(deps).toolDefinitions ?? []).sort();
      const apiNames = toolNames(loopCall.tools.definitions()).sort();
      expect(promptNames).toEqual(apiNames);
      expect(promptNames).toEqual(["mcp__github__create_pr", "memory_recall"]);
    });
  });

  describe("per-turn provider dispatch", () => {
    it("resolves the provider for the snapshot's model and threads it into the loop", async () => {
      const turnProvider = mockProvider();
      const resolveProvider = vi.fn().mockResolvedValue({
        provider: turnProvider,
        limits: { contextWindow: null, maxOutputTokens: null },
      });
      const deps = mockDeps({
        resolveProvider,
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "assistant",
            basePrompt: "test",
            model: "x-ai/grok-4.20",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "auto",
            toolSet: [],
            memoryScope: null,
          }),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // The resolver is called with the snapshot's model — not the default
      // profile's model, not "claude-sonnet-4-6". This is the regression
      // guard for the original bug: bootstrap-time resolution would have
      // pinned the provider to whatever was configured for the default
      // profile.
      expect(resolveProvider).toHaveBeenCalledWith("x-ai/grok-4.20");
      const loopArgs = expectDefined(
        vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
        "runStreamingAgentLoop call",
      )[0];
      expect(loopArgs.provider).toBe(turnProvider);
      expect(loopArgs.model).toBe("x-ai/grok-4.20");
    });

    it("reuses the turn provider for summarization when summarization_model matches", async () => {
      // Threshold: budget * 0.8 ≈ 740_800 for the claude-sonnet-4-6 budget;
      // 800_000 > 80% triggers summarization.
      const countTokens = vi
        .fn()
        .mockResolvedValueOnce(800_000)
        .mockResolvedValueOnce(800_000)
        .mockResolvedValueOnce(50_000);
      const chat = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "summary" }],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const provider = mockProvider({ countTokens, chat });
      const resolveProvider = vi.fn().mockResolvedValue({
        provider,
        limits: { contextWindow: null, maxOutputTokens: null },
      });
      const deps = mockDeps({
        resolveProvider,
        agentStore: mockAgentStore({
          getLastTokens: vi.fn().mockResolvedValue(null),
          // Need ≥ keepTurns history to actually trigger summarization
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

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // No `summarizationModel` override → handle-message uses the turn
      // provider directly. The resolver is called once.
      expect(resolveProvider).toHaveBeenCalledTimes(1);
      // And summarization landed on the same provider's `chat` mock.
      expect(chat).toHaveBeenCalled();
    });

    it("resolves a separate provider for summarization when summarization_model differs", async () => {
      const countTokens = vi
        .fn()
        .mockResolvedValueOnce(800_000)
        .mockResolvedValueOnce(800_000)
        .mockResolvedValueOnce(50_000);
      const turnProvider = mockProvider({ countTokens });
      const summaryChat = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "summary" }],
        stopReason: "end_turn",
        model: "haiku",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const summaryProvider = mockProvider({ chat: summaryChat });

      const resolveProvider = vi.fn().mockImplementation(async (model: string) => {
        const limits = { contextWindow: null, maxOutputTokens: null };
        if (model === "claude-sonnet-4-6") return { provider: turnProvider, limits };
        if (model === "claude-haiku-4-5-20251001") return { provider: summaryProvider, limits };
        throw new Error(`unexpected model ${model}`);
      });

      const deps = mockDeps({
        resolveProvider,
        agentStore: mockAgentStore({
          // Profile carries the summarization-model override now (per-profile
          // evolution model). Bootstrap-time `summarizationModel` dep is gone.
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "assistant",
            basePrompt: "test",
            model: "claude-sonnet-4-6",
            summarizationModel: "claude-haiku-4-5-20251001",
            extractionModel: null,
            autoRecall: "heuristic" as const,
            voiceMode: "auto" as const,
            toolSet: [],
            memoryScope: null,
          }),
          getLastTokens: vi.fn().mockResolvedValue(null),
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

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // Both models were resolved.
      expect(resolveProvider).toHaveBeenCalledTimes(2);
      expect(resolveProvider).toHaveBeenCalledWith("claude-sonnet-4-6");
      expect(resolveProvider).toHaveBeenCalledWith("claude-haiku-4-5-20251001");

      // Summarization went to the SEPARATE provider — this is the
      // cross-provider summarization scenario the design promises.
      expect(summaryChat).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
      );
      // And the turn provider's chat was NOT used for summarization.
      expect(turnProvider.chat).not.toHaveBeenCalled();
    });

    it("does not resolve summarization_model when summarization is skipped", async () => {
      // Regression guard for an earlier draft of this PR which resolved
      // the summarization provider eagerly at turn start. That meant a
      // misconfigured `summarization_model` (missing routing row, missing
      // secret) failed every turn — even tiny messages whose token count
      // never approaches the summarization threshold. The fix is lazy
      // resolution inside the `summarize` callback; this test pins it.

      // Token count well under the 80%-of-budget summarization threshold —
      // compaction's strategy never enters the SUMMARIZE branch.
      const countTokens = vi.fn().mockResolvedValue(1_000);
      const turnProvider = mockProvider({ countTokens });

      const resolveProvider = vi.fn().mockImplementation(async (model: string) => {
        if (model === "claude-sonnet-4-6") {
          return { provider: turnProvider, limits: { contextWindow: null, maxOutputTokens: null } };
        }
        // A misconfigured summarization model would throw here. The whole
        // point of the test is that we never get this far.
        throw new Error(`summarization model "${model}" not configured`);
      });

      // Profile carries summarizationModel — the snapshot picks it up from
      // here, not from a deps field.
      const deps = mockDeps({
        resolveProvider,
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "assistant",
            basePrompt: "test",
            model: "claude-sonnet-4-6",
            summarizationModel: "claude-haiku-4-5-20251001",
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "auto",
            toolSet: [],
            memoryScope: null,
          }),
          // Force the slow path so countTokens actually runs (the fast
          // path skip would also happen to mask this bug).
          getLastTokens: vi.fn().mockResolvedValue(null),
        }),
      });

      // Turn must complete without ever resolving the summarization model.
      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(resolveProvider).toHaveBeenCalledTimes(1);
      expect(resolveProvider).toHaveBeenCalledWith("claude-sonnet-4-6");
      expect(resolveProvider).not.toHaveBeenCalledWith("claude-haiku-4-5-20251001");
    });

    it("propagates transient resolver errors so Inngest retries", async () => {
      const resolveProvider = vi.fn().mockRejectedValue(new Error("ECONNRESET (db)"));
      const deps = mockDeps({
        resolveProvider,
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "assistant",
            basePrompt: "test",
            model: "x-ai/grok-4.20",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "auto",
            toolSet: [],
            memoryScope: null,
          }),
        }),
      });

      const caught = await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      }).catch((e: unknown) => e);

      // Plain Error → Inngest sees a regular rejection and runs its retry
      // path. Must NOT be wrapped in NonRetriableError, otherwise a real
      // DB blip would burn through retries on the first attempt.
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(NonRetriableError);
      expect((caught as Error).message).toMatch(/ECONNRESET/);
      expect(deps.runStreamingAgentLoop).not.toHaveBeenCalled();
    });

    it("rewraps ProviderConfigError as NonRetriableError so Inngest aborts immediately", async () => {
      // Permanent config error (no routing row, missing secret, etc.)
      // should fail the run on the first attempt instead of burning all
      // `retries: 2` attempts before `onFailure` notifies the user.
      const resolveProvider = vi
        .fn()
        .mockRejectedValue(
          new ProviderConfigError('No provider configured for model "x-ai/grok-4.20"'),
        );
      const deps = mockDeps({
        resolveProvider,
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "assistant",
            basePrompt: "test",
            model: "x-ai/grok-4.20",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "auto",
            toolSet: [],
            memoryScope: null,
          }),
        }),
      });

      const caught = await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      }).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(NonRetriableError);
      expect((caught as NonRetriableError).cause).toBeInstanceOf(ProviderConfigError);
      expect((caught as NonRetriableError).message).toMatch(/No provider configured/);
      expect(deps.runStreamingAgentLoop).not.toHaveBeenCalled();
    });
  });

  describe("voice", () => {
    it("transcribes inbound voice blocks via stt provider before persisting the user message", async () => {
      const stt = vi.fn().mockResolvedValue({ text: "hello there" });
      const sttProvider = { name: "openai", stt };
      const insertMessage = vi.fn().mockResolvedValue({ id: "msg-1" });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ stt: sttProvider })),
        agentStore: mockAgentStore({
          insertMessage,
          getHistory: vi.fn().mockResolvedValue([{ role: "user", content: "hello there" }]),
        }),
        attachments: {
          upload: vi.fn().mockResolvedValue("inbound/x"),
          download: vi.fn().mockResolvedValue(Buffer.from("ogg-bytes")),
        },
        transportStore: mockTransportStore({
          getUnbatchedInbound: vi.fn().mockResolvedValue([
            {
              id: "inbound-1",
              content: [{ type: "voice", path: "inbound/v.ogg", mediaType: "audio/ogg" }],
            },
          ]),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(stt).toHaveBeenCalledWith({
        audio: expect.any(Buffer),
        mediaType: "audio/ogg",
        model: "gpt-4o-mini-transcribe",
      });
      // Persisted user message contains the transcript text, not the voice
      // block JSON literal — so subsequent turns load it cleanly.
      expect(insertMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ role: "user", content: "hello there" }),
      );
    });

    it("transcribed text reaches the agent loop as a text block", async () => {
      const sttProvider = { name: "openai", stt: vi.fn().mockResolvedValue({ text: "speak" }) };
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ stt: sttProvider })),
        agentStore: mockAgentStore({
          getHistory: vi.fn().mockResolvedValue([{ role: "user", content: "speak" }]),
        }),
        attachments: {
          upload: vi.fn().mockResolvedValue("inbound/x"),
          download: vi.fn().mockResolvedValue(Buffer.from("bytes")),
        },
        transportStore: mockTransportStore({
          getUnbatchedInbound: vi.fn().mockResolvedValue([
            {
              id: "inbound-1",
              content: [{ type: "voice", path: "inbound/v.ogg", mediaType: "audio/ogg" }],
            },
          ]),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      const callArgs = expectDefined(
        vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
        "runStreamingAgentLoop call",
      )[0];
      // History was rewritten with the resolved trailing user message
      // because `hasAttachments` is false for voice — but the transcript
      // already lives in the persisted text via getHistory's mock.
      expect(callArgs.messages.at(-1)).toEqual({ role: "user", content: "speak" });
    });

    it("delivers TTS voice via deliverVoice when voice mode is on and within the cap", async () => {
      const ttsAudio = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
      const ttsProvider = {
        name: "openai",
        tts: vi.fn().mockResolvedValue({ audio: ttsAudio, mediaType: "audio/ogg" }),
      };
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
        hasBatchTargets: vi.fn().mockReturnValue(false),
      });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts: ttsProvider })),
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "assistant",
            basePrompt: "p",
            model: "claude-sonnet-4-6",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "always",
            toolSet: [],
          }),
        }),
        deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
        transportStore: mockTransportStore({
          getVoiceMaxReplyChars: vi.fn().mockResolvedValue(700),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(ttsProvider.tts).toHaveBeenCalledWith({
        text: "Hello from assistant",
        voice: "alloy",
        model: "gpt-4o-mini-tts",
        format: "ogg",
      });
      expect(handle.deliverVoice).toHaveBeenCalledWith({
        audio: ttsAudio,
        mediaType: "audio/ogg",
      });
    });

    it("over-cap notify failure is swallowed — turn still succeeds", async () => {
      // The streamed text reply already landed, so a notify failure on
      // the over-cap branch (Telegram rate limit, network blip) must
      // not fail the whole turn. Without the try/catch, Inngest would
      // retry an already-successful turn.
      const ttsProvider = { name: "openai", tts: vi.fn() };
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
        hasBatchTargets: vi.fn().mockReturnValue(false),
      });
      const notifyConversation = vi.fn().mockRejectedValue(new Error("rate limited"));
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts: ttsProvider })),
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "x",
            basePrompt: "x",
            model: "claude-sonnet-4-6",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "always",
            toolSet: [],
          }),
        }),
        deliveryRouter: mockDeliveryRouter({
          prepare: vi.fn().mockResolvedValue(handle),
          notifyConversation,
        }),
        transportStore: mockTransportStore({
          getVoiceMaxReplyChars: vi.fn().mockResolvedValue(5),
        }),
      });

      // Turn must complete without rethrowing the notify failure.
      await expect(
        invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
          event: testEvent,
          step: mockStep(),
          runId: testRunId,
        }),
      ).resolves.toMatchObject({ status: "processed" });

      expect(notifyConversation).toHaveBeenCalled();
      expect(ttsProvider.tts).not.toHaveBeenCalled();
    });

    it("skips TTS when text exceeds the per-channel cap and posts a note", async () => {
      const ttsProvider = { name: "openai", tts: vi.fn() };
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
        hasBatchTargets: vi.fn().mockReturnValue(false),
      });
      const notifyConversation = vi.fn().mockResolvedValue(undefined);
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts: ttsProvider })),
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "x",
            basePrompt: "x",
            model: "claude-sonnet-4-6",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "always",
            toolSet: [],
          }),
        }),
        deliveryRouter: mockDeliveryRouter({
          prepare: vi.fn().mockResolvedValue(handle),
          notifyConversation,
        }),
        transportStore: mockTransportStore({
          // Tiny cap that the canned reply ("Hello from assistant" = 20 chars) exceeds.
          getVoiceMaxReplyChars: vi.fn().mockResolvedValue(5),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(ttsProvider.tts).not.toHaveBeenCalled();
      expect(handle.deliverVoice).not.toHaveBeenCalled();
      // The user gets a brief note that voice was skipped — text already
      // streamed via the normal path.
      expect(notifyConversation).toHaveBeenCalledWith(
        "conv-1",
        expect.stringContaining("too long for voice"),
      );
    });

    it("mixed inbound (caption + voice) joins both into the persisted user text", async () => {
      // Realistic Telegram shape: a voice clip with an attached caption.
      // The transcribe-substitute step rewrites the voice block to a text
      // block; since both blocks are now text the orchestrator joins them
      // with "\n" rather than serialising as JSON. Regression guard for
      // the `allText` branch in userContentText: deleting the check would
      // silently produce a JSON literal in messages.content for any
      // text+voice combo.
      const sttProvider = {
        name: "openai",
        stt: vi.fn().mockResolvedValue({ text: "the meeting was rescheduled" }),
      };
      const insertMessage = vi.fn().mockResolvedValue({ id: "msg-1" });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ stt: sttProvider })),
        agentStore: mockAgentStore({
          insertMessage,
          getHistory: vi
            .fn()
            .mockResolvedValue([
              { role: "user", content: "check this out\nthe meeting was rescheduled" },
            ]),
        }),
        attachments: {
          upload: vi.fn().mockResolvedValue("inbound/x"),
          download: vi.fn().mockResolvedValue(Buffer.from("ogg-bytes")),
        },
        transportStore: mockTransportStore({
          getUnbatchedInbound: vi.fn().mockResolvedValue([
            {
              id: "inbound-1",
              content: [
                { type: "text", text: "check this out" },
                { type: "voice", path: "inbound/v.ogg", mediaType: "audio/ogg" },
              ],
            },
          ]),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // Persisted user message is the joined caption + transcript, NOT a
      // JSON-stringified block array — even though the inbound row had
      // two blocks, both became text after STT substitution.
      expect(insertMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          role: "user",
          content: "check this out\nthe meeting was rescheduled",
        }),
      );
      // Defensive: assert the persisted content is NOT JSON. A regression
      // (e.g. someone removes the `allText` check) would land "[{...}]".
      // First arg is the tx handle; the params object is at index 1.
      const call = insertMessage.mock.calls[0]![1];
      expect(call.content).not.toMatch(/^\[/);
    });

    it("auto + voice inbound mirrors → TTS fires (the UX-default path)", async () => {
      // The actual user flow: profile is "auto" (default), no conversation
      // override, last inbound was voice → reply should be voiced. Combines
      // STT + voice mode resolution + TTS in one happy path.
      const ttsAudio = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
      const ttsProvider = {
        name: "openai",
        tts: vi.fn().mockResolvedValue({ audio: ttsAudio, mediaType: "audio/ogg" }),
      };
      const sttProvider = {
        name: "openai",
        stt: vi.fn().mockResolvedValue({ text: "what's the weather" }),
      };
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
        hasBatchTargets: vi.fn().mockReturnValue(false),
      });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts: ttsProvider, stt: sttProvider })),
        // Profile defaults to auto — mirror inbound
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "x",
            basePrompt: "x",
            model: "claude-sonnet-4-6",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "auto",
            toolSet: [],
          }),
          getHistory: vi.fn().mockResolvedValue([{ role: "user", content: "what's the weather" }]),
        }),
        attachments: {
          upload: vi.fn().mockResolvedValue("inbound/x"),
          download: vi.fn().mockResolvedValue(Buffer.from("ogg-bytes")),
        },
        deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
        transportStore: mockTransportStore({
          // Voice inbound — last inbound was voice, so auto mirrors true.
          getUnbatchedInbound: vi.fn().mockResolvedValue([
            {
              id: "inbound-1",
              content: [{ type: "voice", path: "inbound/v.ogg", mediaType: "audio/ogg" }],
            },
          ]),
          getVoiceMaxReplyChars: vi.fn().mockResolvedValue(700),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // STT happened (transcription before persist).
      expect(sttProvider.stt).toHaveBeenCalledWith({
        audio: expect.any(Buffer),
        mediaType: "audio/ogg",
        model: "gpt-4o-mini-transcribe",
      });
      // TTS happened — the "auto + voice in → voice out" reflex.
      expect(ttsProvider.tts).toHaveBeenCalledWith({
        text: "Hello from assistant",
        voice: "alloy",
        model: "gpt-4o-mini-tts",
        format: "ogg",
      });
      expect(handle.deliverVoice).toHaveBeenCalledWith({
        audio: ttsAudio,
        mediaType: "audio/ogg",
      });
    });

    it("auto + batch [voice, text] → no TTS (user typed last)", async () => {
      // Debounced batch where the user dictated, then typed a follow-up.
      // Their most recent intent is text — shouldn't get a voice reply
      // just because the batch started with voice. Pins the
      // last-inbound-only resolution rule.
      const ttsProvider = { name: "openai", tts: vi.fn() };
      const sttProvider = {
        name: "openai",
        stt: vi.fn().mockResolvedValue({ text: "first message" }),
      };
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
        hasBatchTargets: vi.fn().mockReturnValue(false),
      });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts: ttsProvider, stt: sttProvider })),
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "x",
            basePrompt: "x",
            model: "claude-sonnet-4-6",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "auto",
            toolSet: [],
          }),
        }),
        attachments: {
          upload: vi.fn().mockResolvedValue("inbound/x"),
          download: vi.fn().mockResolvedValue(Buffer.from("ogg-bytes")),
        },
        deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
        transportStore: mockTransportStore({
          getUnbatchedInbound: vi.fn().mockResolvedValue([
            {
              id: "inbound-1",
              content: [{ type: "voice", path: "inbound/v.ogg", mediaType: "audio/ogg" }],
            },
            {
              id: "inbound-2",
              content: "actually wait, type response please",
            },
          ]),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // STT still runs — earlier voice message in the batch needs transcription.
      expect(sttProvider.stt).toHaveBeenCalled();
      // But TTS does NOT — last inbound was text.
      expect(ttsProvider.tts).not.toHaveBeenCalled();
      expect(handle.deliverVoice).not.toHaveBeenCalled();
    });

    it("auto + batch [text, voice] → TTS (user dictated last)", async () => {
      // Mirror of the previous test: user typed first, then sent a voice
      // follow-up. Last intent is voice → reply voiced.
      const ttsAudio = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
      const ttsProvider = {
        name: "openai",
        tts: vi.fn().mockResolvedValue({ audio: ttsAudio, mediaType: "audio/ogg" }),
      };
      const sttProvider = {
        name: "openai",
        stt: vi.fn().mockResolvedValue({ text: "follow-up by voice" }),
      };
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
        hasBatchTargets: vi.fn().mockReturnValue(false),
      });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts: ttsProvider, stt: sttProvider })),
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "x",
            basePrompt: "x",
            model: "claude-sonnet-4-6",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "auto",
            toolSet: [],
          }),
        }),
        attachments: {
          upload: vi.fn().mockResolvedValue("inbound/x"),
          download: vi.fn().mockResolvedValue(Buffer.from("ogg-bytes")),
        },
        deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
        transportStore: mockTransportStore({
          getUnbatchedInbound: vi.fn().mockResolvedValue([
            { id: "inbound-1", content: "let me think out loud" },
            {
              id: "inbound-2",
              content: [{ type: "voice", path: "inbound/v.ogg", mediaType: "audio/ogg" }],
            },
          ]),
          getVoiceMaxReplyChars: vi.fn().mockResolvedValue(700),
        }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(ttsProvider.tts).toHaveBeenCalled();
      expect(handle.deliverVoice).toHaveBeenCalledWith({
        audio: ttsAudio,
        mediaType: "audio/ogg",
      });
    });

    it("does not run TTS when voice mode resolves to false (auto + text inbound)", async () => {
      const ttsProvider = { name: "openai", tts: vi.fn() };
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
        hasBatchTargets: vi.fn().mockReturnValue(false),
      });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts: ttsProvider })),
        // Profile defaults to "auto"; no voice inbound; conversation override null.
        deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(ttsProvider.tts).not.toHaveBeenCalled();
      expect(handle.deliverVoice).not.toHaveBeenCalled();
    });

    it("passes voiceMode: true into prompt assembly when voice is on", async () => {
      const handle = mockDeliveryHandle({
        canDeliverVoice: vi.fn().mockReturnValue(true),
      });
      const deps = mockDeps({
        voiceResolver: mockVoiceResolver(
          mockVoiceBundle({
            tts: {
              name: "openai",
              tts: vi.fn().mockResolvedValue({ audio: Buffer.from([]), mediaType: "audio/ogg" }),
            },
          }),
        ),
        agentStore: mockAgentStore({
          getProfile: vi.fn().mockResolvedValue({
            id: "profile-1",
            userId: null,
            name: "x",
            basePrompt: "x",
            model: "claude-sonnet-4-6",
            summarizationModel: null,
            extractionModel: null,
            autoRecall: "heuristic",
            voiceMode: "always",
            toolSet: [],
          }),
        }),
        deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      });

      await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(deps.promptSource.assemble).toHaveBeenCalledWith(
        expect.objectContaining({ voiceMode: true }),
      );
    });
  });

  it("auto-recall passes the profile's memoryScope through as a tag_groups filter", async () => {
    const memory = mockMemoryProvider();
    const deps = mockDeps({
      memory,
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: null,
          name: "coder",
          basePrompt: "test",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "always" as const,
          toolSet: [],
          memoryScope: {
            compartments: ["work", "technical"],
            trust: ["first-party"],
          },
        }),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(memory.recall).toHaveBeenCalled();
    const recallCall = expectDefined(vi.mocked(memory.recall).mock.calls[0], "recall call");
    const opts = expectDefined(recallCall[2], "recall opts");
    expect(opts).toMatchObject({
      tagGroups: [
        {
          and: [
            { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
          ],
        },
      ],
      maxTokens: 2000,
    });
    // tags / tagsMatch must NOT be on the request — caller didn't pass any
    // and the scope filter folds everything into tagGroups.
    expect(opts.tags).toBeUndefined();
    expect(opts.tagsMatch).toBeUndefined();
  });

  it("auto-recall passes opts unchanged when profile.memoryScope is null", async () => {
    const memory = mockMemoryProvider();
    const deps = mockDeps({
      memory,
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: null,
          name: "default",
          basePrompt: "test",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "always" as const,
          toolSet: [],
          memoryScope: null,
        }),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(memory.recall).toHaveBeenCalledWith("user-1", expect.any(String), {
      maxTokens: 2000,
    });
  });

  it("auto-recall folds restricted classes into a NOT leaf, with the speaker's own class auto-included", async () => {
    // End-to-end wiring proof: handle-message loads the user's
    // profile_classes registry, filters down to the restricted set,
    // and passes it (alongside the profile's profile_class) into
    // createService. The Service then composes a NOT leaf for any
    // restricted class the profile hasn't opted into. We observe the
    // resulting tag_groups by inspecting memory.recall's args.
    const memory = mockMemoryProvider();
    const listProfileClasses = vi.fn().mockResolvedValue([
      {
        id: "c-1",
        userId: "user-1",
        name: "intimate",
        description: "x",
        restricted: true,
        createdAt: new Date("2026-04-16T12:00:00Z"),
      },
      {
        id: "c-2",
        userId: "user-1",
        name: "secret",
        description: "y",
        restricted: true,
        createdAt: new Date("2026-04-16T12:00:00Z"),
      },
      {
        id: "c-3",
        userId: "user-1",
        name: "general",
        description: "z",
        restricted: false,
        createdAt: new Date("2026-04-16T12:00:00Z"),
      },
    ]);
    const deps = mockDeps({
      memory,
      agentStore: mockAgentStore({
        listProfileClasses,
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: "user-1",
          name: "private",
          basePrompt: "test",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "always" as const,
          toolSet: [],
          memoryScope: null,
          profileClass: "intimate",
        }),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // Registry was loaded keyed on the conversation user (not the
    // profile's userId — they coincide here, but the wiring should pass
    // the conversation user even for org-owned profiles).
    expect(listProfileClasses).toHaveBeenCalledWith(expect.anything(), "user-1");

    // The recall request carries a NOT leaf for `secret` only:
    // - `intimate` is restricted but auto-included as the speaker's class
    // - `secret` is restricted and not in any opt-in set → excluded
    // - `general` is unrestricted → never appears in the NOT leaf
    expect(memory.recall).toHaveBeenCalled();
    const recallCall = vi.mocked(memory.recall).mock.calls[0];
    const opts = recallCall?.[2];
    expect(opts).toMatchObject({
      tagGroups: [
        {
          and: [{ not: { tags: ["profile_class:secret"], match: "any" } }],
        },
      ],
      maxTokens: 2000,
    });
  });

  it("no NOT leaf when no profile classes are flagged restricted (today-fast-path preserved)", async () => {
    // Belt-and-braces: a deployment without any restricted classes must
    // see exactly the pre-feature recall payload — no tagGroups at all
    // when memoryScope is null. Catches a regression where the wiring
    // emits an empty NOT leaf or a stray AND wrapper.
    const memory = mockMemoryProvider();
    const deps = mockDeps({
      memory,
      agentStore: mockAgentStore({
        listProfileClasses: vi.fn().mockResolvedValue([
          {
            id: "c-1",
            userId: "user-1",
            name: "general",
            description: "z",
            restricted: false,
            createdAt: new Date("2026-04-16T12:00:00Z"),
          },
        ]),
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: "user-1",
          name: "assistant",
          basePrompt: "test",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "always" as const,
          toolSet: [],
          memoryScope: null,
          profileClass: "general",
        }),
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(memory.recall).toHaveBeenCalledWith("user-1", expect.any(String), {
      maxTokens: 2000,
    });
  });

  // --- Class C / D degraded off-ramp ---
  //
  // When the agent loop returns `{ degraded: { reason, subtype } }`, the
  // orchestrator pushes a user-facing apology onto the stream, persists it
  // as the final assistant message, emits `conversation/degraded`, and
  // proceeds with the normal post-turn flow. Conversation stays `active`.
  // See design/agent-resilience.md → Degraded reply.

  it("appends the default degraded apology to the stream and persists it", async () => {
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        newMessages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 2,
        degraded: { reason: "model returned an empty turn", subtype: "empty_end_turn" },
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    // The user-facing apology was pushed onto the streaming delivery.
    const textPushes = vi
      .mocked(handle.push)
      .mock.calls.flat()
      .filter((e) => (e as { type: string }).type === "text_delta");
    expect(textPushes).toHaveLength(1);
    expect(textPushes[0]).toEqual({
      type: "text_delta",
      text: "I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?",
    });

    // Stream still finished (no abort).
    expect(handle.finish).toHaveBeenCalled();
    expect(handle.abort).not.toHaveBeenCalled();

    // Persistence included the synthetic apology assistant message —
    // newMessages was empty when the loop returned, so the orchestrator
    // appended it.
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?",
              },
            ],
          },
        ],
      }),
    );
  });

  it("uses the refusal-specific apology when subtype is refusal", async () => {
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        newMessages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 1,
        degraded: { reason: "model refused the request", subtype: "refusal" },
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    const textPushes = vi
      .mocked(handle.push)
      .mock.calls.flat()
      .filter((e) => (e as { type: string }).type === "text_delta");
    expect(textPushes[0]).toEqual({
      type: "text_delta",
      text: "The model declined that request. Try rephrasing, or switch model with `/model`.",
    });
  });

  it("emits conversation/degraded with subtype, reason, runId, conversationId, triggerInboundId", async () => {
    const deps = mockDeps({
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        newMessages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 2,
        degraded: {
          reason: "streamed tool-call arguments could not be parsed",
          subtype: "stream_truncation",
        },
      }),
    });

    const step = mockStep();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step,
      runId: testRunId,
    });

    // The orchestrator emits `conversation/degraded` via a dedicated
    // `step.sendEvent` after the persist step — same pattern as
    // `conversation/errored` in `onFailure`. Inngest's bus-level dedup on
    // the named step provides exactly-once delivery.
    expect(step.sendEvent).toHaveBeenCalledWith(
      "emit-conversation-degraded",
      expect.objectContaining({
        name: "conversation/degraded",
        data: {
          conversationId: "conv-1",
          runId: testRunId,
          triggerInboundId: "inbound-1",
          subtype: "stream_truncation",
          reason: "streamed tool-call arguments could not be parsed",
        },
      }),
    );
  });

  it("emits conversation/degraded with subtype: stuck_loop for the Class D consecutive trip", async () => {
    const deps = mockDeps({
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        newMessages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 3,
        degraded: { reason: "stuck_loop", subtype: "stuck_loop" },
      }),
    });

    const step = mockStep();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step,
      runId: testRunId,
    });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "emit-conversation-degraded",
      expect.objectContaining({
        name: "conversation/degraded",
        data: {
          conversationId: "conv-1",
          runId: testRunId,
          triggerInboundId: "inbound-1",
          subtype: "stuck_loop",
          reason: "stuck_loop",
        },
      }),
    );
  });

  it("emits conversation/degraded with subtype: stuck_loop_cumulative for the Class D cumulative trip", async () => {
    const deps = mockDeps({
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        newMessages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 9,
        degraded: { reason: "stuck_loop", subtype: "stuck_loop_cumulative" },
      }),
    });

    const step = mockStep();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step,
      runId: testRunId,
    });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "emit-conversation-degraded",
      expect.objectContaining({
        name: "conversation/degraded",
        data: {
          conversationId: "conv-1",
          runId: testRunId,
          triggerInboundId: "inbound-1",
          subtype: "stuck_loop_cumulative",
          reason: "stuck_loop",
        },
      }),
    );
  });

  it("preserves successful intermediate iterations and appends the apology", async () => {
    const handle = mockDeliveryHandle({
      hasBatchTargets: vi.fn().mockReturnValue(false),
    });
    const successfulToolRound = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "t1", name: "echo", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, toolUseId: "t1", content: "ok" }],
      },
    ];
    const deps = mockDeps({
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        // The successful tool round IS persisted; the apology is appended.
        // The failing iteration's assistant content is already excluded
        // upstream by the loop.
        newMessages: successfulToolRound,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 3,
        degraded: { reason: "model returned an empty turn", subtype: "empty_end_turn" },
      }),
    });

    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.agentStore.insertMessages).toHaveBeenCalledTimes(1);
    const persistCall = vi.mocked(deps.agentStore.insertMessages).mock.calls[0];
    const persistArgs = expectDefined(persistCall, "persist call")[1] as {
      messages: ReadonlyArray<unknown>;
    };
    expect(persistArgs.messages).toHaveLength(3);
    // Successful tool_use + tool_result preserved.
    expect(persistArgs.messages[0]).toEqual(successfulToolRound[0]);
    expect(persistArgs.messages[1]).toEqual(successfulToolRound[1]);
    // Final assistant is the apology.
    expect(persistArgs.messages[2]).toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?",
        },
      ],
    });
  });

  it("still emits response/ready on the degraded path so downstream consumers run", async () => {
    const deps = mockDeps({
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        newMessages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 1,
        degraded: { reason: "model refused the request", subtype: "refusal" },
      }),
    });

    const step = mockStep();
    await invokeInngestFn<HandleMessageCtx>(createHandleMessage(deps), {
      event: testEvent,
      step,
      runId: testRunId,
    });

    // response/ready still fires — degraded is an event, not a status,
    // and downstream consumers (Observer extraction, metrics) still want
    // to see the turn closed out.
    expect(step.sendEvent).toHaveBeenCalledWith(
      "send-response",
      expect.objectContaining({ name: "response/ready" }),
    );
  });
});
