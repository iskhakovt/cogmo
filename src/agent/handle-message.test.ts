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
      voiceMode: false,
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
    // countTokens returns over 60% of budget (926_000 * 0.6 ≈ 555_600)
    // First call: over threshold. Second call (after clearing): under.
    const countTokens = vi.fn().mockResolvedValueOnce(600_000).mockResolvedValueOnce(50_000);
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
    // Over 80% of budget (926_000 * 0.8 ≈ 740_800) → triggers summarization
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(800_000) // initial: over 80%
      .mockResolvedValueOnce(800_000) // after tool clearing (nothing to clear): still over
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

  describe("voice", () => {
    function voiceConfigStub() {
      return { ttsVoice: "alloy", ttsModel: "gpt-4o-mini-tts" };
    }

    it("transcribes inbound voice blocks via stt provider before persisting the user message", async () => {
      const stt = vi.fn().mockResolvedValue({ text: "hello there" });
      const sttProvider = { name: "openai", stt };
      const insertMessage = vi.fn().mockResolvedValue({ id: "msg-1" });
      const deps = mockDeps({
        sttProvider,
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

      await (createHandleMessage(deps) as any).fn({
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(stt).toHaveBeenCalledWith({ audio: expect.any(Buffer), mediaType: "audio/ogg" });
      // Persisted user message contains the transcript text, not the voice
      // block JSON literal — so subsequent turns load it cleanly.
      expect(insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: "user", content: "hello there" }),
      );
    });

    it("transcribed text reaches the agent loop as a text block", async () => {
      const sttProvider = { name: "openai", stt: vi.fn().mockResolvedValue({ text: "speak" }) };
      const deps = mockDeps({
        sttProvider,
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

      await (createHandleMessage(deps) as any).fn({
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      const callArgs = (deps.runStreamingAgentLoop as any).mock.calls[0][0];
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
        ttsProvider,
        voiceConfig: voiceConfigStub(),
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

      await (createHandleMessage(deps) as any).fn({
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
        ttsProvider,
        voiceConfig: voiceConfigStub(),
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
        (createHandleMessage(deps) as any).fn({
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
        ttsProvider,
        voiceConfig: voiceConfigStub(),
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

      await (createHandleMessage(deps) as any).fn({
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
        sttProvider,
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

      await (createHandleMessage(deps) as any).fn({
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // Persisted user message is the joined caption + transcript, NOT a
      // JSON-stringified block array — even though the inbound row had
      // two blocks, both became text after STT substitution.
      expect(insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          content: "check this out\nthe meeting was rescheduled",
        }),
      );
      // Defensive: assert the persisted content is NOT JSON. A regression
      // (e.g. someone removes the `allText` check) would land "[{...}]".
      const call = insertMessage.mock.calls[0]![0];
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
        ttsProvider,
        sttProvider,
        voiceConfig: voiceConfigStub(),
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

      await (createHandleMessage(deps) as any).fn({
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      // STT happened (transcription before persist).
      expect(sttProvider.stt).toHaveBeenCalledWith({
        audio: expect.any(Buffer),
        mediaType: "audio/ogg",
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
        ttsProvider,
        sttProvider,
        voiceConfig: voiceConfigStub(),
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

      await (createHandleMessage(deps) as any).fn({
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
        ttsProvider,
        sttProvider,
        voiceConfig: voiceConfigStub(),
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

      await (createHandleMessage(deps) as any).fn({
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
        ttsProvider,
        voiceConfig: voiceConfigStub(),
        // Profile defaults to "auto"; no voice inbound; conversation override null.
        deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      });

      await (createHandleMessage(deps) as any).fn({
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
        ttsProvider: {
          name: "openai",
          tts: vi.fn().mockResolvedValue({ audio: Buffer.from([]), mediaType: "audio/ogg" }),
        },
        voiceConfig: voiceConfigStub(),
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

      await (createHandleMessage(deps) as any).fn({
        event: testEvent,
        step: mockStep(),
        runId: testRunId,
      });

      expect(deps.promptSource.assemble).toHaveBeenCalledWith(
        deps.agentStore,
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

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(memory.recall).toHaveBeenCalled();
    const recallCall = (memory.recall as any).mock.calls[0];
    const opts = recallCall[2];
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

    await (createHandleMessage(deps) as any).fn({
      event: testEvent,
      step: mockStep(),
      runId: testRunId,
    });

    expect(memory.recall).toHaveBeenCalledWith("user-1", expect.any(String), {
      maxTokens: 2000,
    });
  });
});
