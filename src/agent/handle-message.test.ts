import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { ProviderConfigError } from "../llm/resolver.js";
import {
  mockAgentStore,
  mockDeliveryHandle,
  mockDeliveryRouter,
  mockMemoryProvider,
  mockProvider,
  mockResolver,
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
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
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
      expect.objectContaining({ profileId: "profile-1", model: "claude-sonnet-4-6" }),
    );
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-1", model: "claude-sonnet-4-6" }),
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
        model: "claude-sonnet-4-6",
      }),
    );
    // Assistant + tool turns via insertMessages (atomic batch) — same snapshot
    expect(deps.agentStore.insertMessages).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.insertMessages).toHaveBeenCalledWith(
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
      await (createHandleMessage(deps) as any).fn({
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
    const fn = createHandleMessage(deps) as any;
    const onFailure = fn.opts.onFailure;
    expect(onFailure).toBeDefined();

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

    await onFailure({ event: failureEvent, error, step: stepCtx });

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
    const fn = createHandleMessage(deps) as any;
    const onFailure = fn.opts.onFailure;
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

    await onFailure({ event: failureEvent, error, step: stepCtx });

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
    const fn = createHandleMessage(deps) as any;
    const onFailure = fn.opts.onFailure;

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
    await expect(onFailure({ event: failureEvent, error, step: stepCtx })).resolves.toBeUndefined();

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
      await (createHandleMessage(deps) as any).fn({
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

    await (createHandleMessage(deps) as any).fn({
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

    await (createHandleMessage(deps) as any).fn({
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

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(deps.attachments.download).toHaveBeenCalledWith("inbound/abc.pdf");

    // The last user message handed to the agent loop must contain the resolved
    // DocumentBlock with base64-encoded bytes and the original filename.
    const callArgs = (deps.runStreamingAgentLoop as any).mock.calls[0][0];
    const lastMsg = callArgs.messages.at(-1);
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

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    const callArgs = (deps.runStreamingAgentLoop as any).mock.calls[0][0];
    const lastMsg = callArgs.messages.at(-1);
    const docBlock = (lastMsg.content as any[]).find((b) => b.type === "document");
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

    await (createHandleMessage(deps) as any).fn({
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

    await (createHandleMessage(deps) as any).fn({
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
    const result = await (createHandleMessage(deps) as any).fn({
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
    const countTokens = vi.fn().mockResolvedValue(0);
    const deps = mockDeps({
      resolveProvider: mockResolver(mockProvider({ countTokens })),
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
          model: "claude-sonnet-4-6",
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

  describe("per-turn provider dispatch", () => {
    it("resolves the provider for the snapshot's model and threads it into the loop", async () => {
      const turnProvider = mockProvider();
      const resolveProvider = vi.fn().mockResolvedValue(turnProvider);
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
            toolSet: [],
          }),
        }),
      });

      await (createHandleMessage(deps) as any).fn({
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
      const loopArgs = (deps.runStreamingAgentLoop as any).mock.calls[0][0];
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
      const resolveProvider = vi.fn().mockResolvedValue(provider);
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

      await (createHandleMessage(deps) as any).fn({
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
        if (model === "claude-sonnet-4-6") return turnProvider;
        if (model === "claude-haiku-4-5-20251001") return summaryProvider;
        throw new Error(`unexpected model ${model}`);
      });

      const deps = mockDeps({
        resolveProvider,
        summarizationModel: "claude-haiku-4-5-20251001",
        agentStore: mockAgentStore({
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

      await (createHandleMessage(deps) as any).fn({
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
        if (model === "claude-sonnet-4-6") return turnProvider;
        // A misconfigured summarization model would throw here. The whole
        // point of the test is that we never get this far.
        throw new Error(`summarization model "${model}" not configured`);
      });

      const deps = mockDeps({
        resolveProvider,
        summarizationModel: "claude-haiku-4-5-20251001",
        agentStore: mockAgentStore({
          // Force the slow path so countTokens actually runs (the fast
          // path skip would also happen to mask this bug).
          getLastTokens: vi.fn().mockResolvedValue(null),
        }),
      });

      // Turn must complete without ever resolving the summarization model.
      await (createHandleMessage(deps) as any).fn({
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
            toolSet: [],
          }),
        }),
      });

      const caught = await (createHandleMessage(deps) as any)
        .fn({
          event: testEvent,
          step: mockStep(),
          runId: testRunId,
        })
        .catch((e: unknown) => e);

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
            toolSet: [],
          }),
        }),
      });

      const caught = await (createHandleMessage(deps) as any)
        .fn({
          event: testEvent,
          step: mockStep(),
          runId: testRunId,
        })
        .catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(NonRetriableError);
      expect((caught as NonRetriableError).cause).toBeInstanceOf(ProviderConfigError);
      expect((caught as NonRetriableError).message).toMatch(/No provider configured/);
      expect(deps.runStreamingAgentLoop).not.toHaveBeenCalled();
    });
  });
});
