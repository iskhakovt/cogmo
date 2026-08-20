/**
 * Crash recovery / step replay tests for handle-message.
 *
 * These tests use `@inngest/test`'s `steps:` mechanism — Inngest's memoization
 * model exposed for tests. Providing a step in `steps:` simulates "this step
 * already completed in a prior attempt and Inngest is re-invoking the function
 * with cached state". The user's `step.run` body is NOT executed; the cached
 * value is returned instead.
 *
 * What these tests prove:
 *   1. Side effects inside `step.run("X", ...)` are NOT re-executed when X is
 *      cached on resume — i.e., user/assistant messages are inserted exactly
 *      once across an Inngest retry.
 *   2. The expensive summarization LLM call inside `compact-context` is cached.
 *   3. The streaming section's bare-body glue IS re-invoked on every replay,
 *      while the expensive work inside it — each `llm-iter<N>` model call,
 *      each durable tool handler, the `degraded-reply` off-ramp, and
 *      `auto-recall` — replays from the step cache without re-executing or
 *      re-emitting.
 *
 * See design/crash-recovery.md for the full contract.
 */

import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../inngest/client.js";
import {
  fakeRunInTx,
  mockAgentStore,
  mockDeliveryHandle,
  mockDeliveryRouter,
  mockFilesService,
  mockMemoryProvider,
  mockProvider,
  mockResolver,
  mockToolRegistry,
  mockTransportStore,
  spyOnInngestSend,
} from "../test/factories.js";
import type { HandleMessageDeps } from "./handle-message.js";
import { createHandleMessage } from "./handle-message.js";
import { runStreamingAgentLoop } from "./loop.js";

// Stub the singleton Inngest client's private `_send` so step.sendEvent calls
// inside the function under test don't try to reach a real Inngest dev server.
// @inngest/test mocks step.* on the ctx, but the engine internally invokes
// `inngest._send` (not the public `send`). Without this stub each test waits
// ~2s for an ECONNREFUSED retry. The cast that bridges Inngest's private
// `_send` to `vi.spyOn` lives in `spyOnInngestSend` (src/test/factories.ts).
//
// Failure modes:
//   - If Inngest renames or removes `_send`, `vi.spyOn` throws synchronously
//     in `beforeEach` ("property is not defined on the object") — Vitest
//     handles this loudly, no extra guard needed.
//   - The one residual risk: `_send` still exists but the engine stops calling
//     it (e.g., a future release moves to a different internal code path).
//     The first test below has an `expect(sendSpy).toHaveBeenCalled()` anchor
//     to catch this — it would otherwise reintroduce the ECONNREFUSED delay
//     silently.
let sendSpy: ReturnType<typeof spyOnInngestSend>;

beforeEach(() => {
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: [] });
});

afterEach(() => {
  // Restore the singleton spy so it doesn't leak into other test files that
  // share the worker process.
  vi.restoreAllMocks();
});

function mockDeps(overrides?: Partial<HandleMessageDeps>): HandleMessageDeps {
  return {
    runInTx: fakeRunInTx,
    agentStore: mockAgentStore(),
    transportStore: mockTransportStore(),
    resolveProvider: mockResolver(),
    tools: mockToolRegistry(),
    memory: mockMemoryProvider(),
    promptSource: { assemble: vi.fn().mockResolvedValue("system prompt") },
    fileService: mockFilesService(),
    attachments: {
      upload: vi.fn().mockResolvedValue("inbound/test.jpg"),
      download: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
    },
    debounceConfig: { idleTimeoutMs: 0, maxWaitMs: 0, resumePolicy: "debounce" as const },
    deliveryRouter: mockDeliveryRouter({
      prepare: vi.fn().mockResolvedValue(mockDeliveryHandle()),
    }),
    runStreamingAgentLoop: vi.fn().mockResolvedValue({
      text: "Hello from assistant",
      messages: [],
      newMessages: [
        { role: "assistant", content: [{ type: "text", text: "Hello from assistant" }] },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "mock-model",
      iterations: 1,
      streamed: { text: "", toolUseIds: [] },
    }),
    userTimezone: "UTC",
    ...overrides,
  };
}

const event = {
  name: "inbound/ready",
  data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
} as const;

describe("handle-message — crash recovery / step replay", () => {
  it("does not re-insert the user message when create-user-message is cached", async () => {
    const deps = mockDeps();
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      // Simulate: a prior attempt completed `create-user-message` already.
      // The handler returns the cached value (void in this case — the step
      // body returns nothing).
      steps: [{ id: "create-user-message", handler: () => undefined }],
    });

    await engine.execute();

    // Anchor: confirm the singleton `_send` spy was actually invoked. If
    // Inngest ever moves to a different internal code path that bypasses
    // `_send`, this assertion catches it before the silent ECONNREFUSED
    // slowdown returns. (Vitest already throws if `_send` is removed, so
    // this only needs to live in one test.)
    expect(sendSpy).toHaveBeenCalled();

    // Assistant messages are still inserted (via insertMessages, not cached), but the
    // user message is NOT — that step's body never runs.
    const userInserts = (
      deps.agentStore.insertMessage as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([params]) => params.role === "user");
    expect(userInserts).toHaveLength(0);

    expect(deps.agentStore.insertMessages).toHaveBeenCalledTimes(1);
  });

  it("does not re-insert the assistant message when persist-new-messages is cached", async () => {
    const deps = mockDeps();
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "persist-new-messages",
          handler: () => ({ id: "cached-assistant-msg-id" }),
        },
      ],
    });

    await engine.execute();

    // insertMessages was not called — the persist step was cached
    expect(deps.agentStore.insertMessages).not.toHaveBeenCalled();
  });

  it("does not re-run the summarization LLM call when summarize-prefix is cached", async () => {
    // To exercise the summarize step, we need the compaction pipeline to
    // actually call its `summarize` callback. That requires:
    //   - getLastTokens past the fast-path threshold so countTokens runs
    //   - countTokens reporting > 80% of budget so the SUMMARIZE strategy fires
    //   - history with more than DEFAULT_KEEP_TURNS messages (6) so there's
    //     a prefix to summarize
    // Then we cache `summarize-prefix` and assert provider.chat is never
    // called for the summarization round trip.
    const countTokens = vi.fn().mockResolvedValue(800_000); // claude-sonnet-4-6 budget is 926_000; 800_000 > 80%
    const chat = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "fresh summary" }],
      stopReason: "end_turn",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const deps = mockDeps({
      resolveProvider: mockResolver(mockProvider({ countTokens, chat })),
      agentStore: mockAgentStore({
        getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 800_000, outputTokens: 2_000 }),
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
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "summarize-prefix",
          // Cached value: the summary text from a prior attempt.
          handler: () => "[cached summary from prior attempt]",
        },
      ],
    });

    await engine.execute();

    // The summarization round trip lives inside the cached step. On replay,
    // the step body never runs, so provider.chat is never called for it.
    expect(chat).not.toHaveBeenCalled();

    // Non-vacuity check: prove summarize was actually invoked and the cached
    // value reached the agent loop. compactMessages threads the summary into
    // the message history as a synthetic user message ("[Previous conversation
    // summary]\n\n…"). If we see our cached marker in the history passed to
    // the agent loop, the cached step was hit.
    const loopCalls = (deps.runStreamingAgentLoop as ReturnType<typeof vi.fn>).mock.calls;
    expect(loopCalls.length).toBeGreaterThanOrEqual(1);
    const messages = loopCalls[0]?.[0]?.messages as Array<{ content: unknown }>;
    const summaryMessage = messages.find(
      (m) =>
        typeof m.content === "string" && m.content.includes("[cached summary from prior attempt]"),
    );
    expect(summaryMessage).toBeDefined();
  });

  it("does not re-execute a durable tool step body when the iteration-keyed step is cached", async () => {
    // Verifies that when the agent loop emits a `tool-iter<N>-<P>` step,
    // Inngest's cache returns the stored value and skips the handler
    // body. The id format itself is asserted in `loop.test.ts`; this
    // test covers the handle-message ⇄ Inngest cache wire only.
    const handlerBody = vi.fn().mockResolvedValue("fresh-result");
    const deps = mockDeps({
      runStreamingAgentLoop: vi.fn().mockImplementation(async (params) => {
        const cached = await params.stepRun("tool-iter1-0", handlerBody);
        return {
          text: cached,
          messages: [],
          newMessages: [{ role: "assistant", content: [{ type: "text", text: cached }] }],
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock-model",
          iterations: 1,
          streamed: { text: "", toolUseIds: [] },
        };
      }),
    });
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [{ id: "tool-iter1-0", handler: () => "cached-tool-output" }],
    });

    await engine.execute();

    // Cached step → body never runs.
    expect(handlerBody).not.toHaveBeenCalled();
    // The cached value flowed back through stepRun's return into the
    // loop. Persisting confirms the loop actually consumed it
    // — insertMessages call shape is (tx, { messages, ... }).
    const insertArgs = (deps.agentStore.insertMessages as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as { messages: Array<{ content: unknown }> } | undefined;
    expect(insertArgs?.messages?.[0]?.content).toEqual([
      { type: "text", text: "cached-tool-output" },
    ]);
  });

  it("re-invokes the streaming agent loop on resume even when all durable steps are cached", async () => {
    // This test documents the design tradeoff: the streaming section is
    // intentionally non-durable. Even if every durable boundary is cached,
    // resume re-runs the agent loop (and its tool calls). See
    // design/crash-recovery.md → "Non-durable section".
    //
    // Note: @inngest/test re-invokes the function once per step boundary
    // (faithfully simulating Inngest's wire-level execution), so non-durable
    // code may be called more than once across the multi-pass run. We assert
    // ">= 1" — the point is that it runs even when no work is left for it.
    const deps = mockDeps();
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "load-conversation",
          handler: () => ({
            id: "conv-1",
            userId: "user-1",
            profileId: "profile-1",
            isPrivate: true,
            cooldownState: null,
            voiceMode: null,
          }),
        },
        { id: "last-assistant", handler: () => null },
        { id: "load-inbound", handler: () => [{ id: "inbound-1", content: "hi" }] },
        { id: "create-user-message", handler: () => undefined },
        { id: "load-history", handler: () => [] },
        { id: "assemble-prompt", handler: () => "system prompt" },
        // `summarize-prefix` is conditional — only created when compaction
        // decides to summarize. The default mock countTokens stays under
        // threshold, so the step is never invoked here and we don't list it.
        { id: "persist-new-messages", handler: () => ({ id: "asst-1" }) },
      ],
    });

    await engine.execute();

    // Streaming agent loop is outside any step → runs at least once even on
    // full-cache replay. (This is the canary: if a developer wraps the agent
    // loop in a step.run, this assertion stays true but the surrounding
    // streaming behavior breaks.)
    //
    // Lower bound: ≥1 proves the non-durable contract.
    // Upper bound: <10 catches a regression where the loop runs on every step
    // boundary (8 step.run calls + 1 sendEvent currently → would explode if
    // someone added expensive setup to the function body). Currently 2.
    const loopCallCount = (deps.runStreamingAgentLoop as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(loopCallCount).toBeGreaterThanOrEqual(1);
    expect(loopCallCount).toBeLessThan(10);
    // No DB writes happened — every persist step was cached.
    expect(deps.agentStore.insertMessage).not.toHaveBeenCalled();
    expect(deps.agentStore.insertMessages).not.toHaveBeenCalled();
  });

  it("does not call the provider when the llm-iter1 step is cached", async () => {
    // Wire test for the durable-iteration contract with the REAL streaming
    // loop: a cached `llm-iter1` outcome must reproduce the turn without a
    // chatStream call (no re-billing) and without pushing any text to the
    // delivery layer (no duplicate preambles) — the exact replay that the
    // executor performs at every step boundary of a clean run.
    const chatStream = vi.fn(() => {
      throw new Error("provider must not be streamed on a cached iteration");
    });
    const provider = mockProvider({ chatStream });
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      resolveProvider: mockResolver(provider),
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop,
    });
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "llm-iter1",
          handler: () => ({
            kind: "drained",
            content: [{ type: "text", text: "cached reply" }],
            stopReason: "end_turn",
            model: "mock-model",
            usage: { inputTokens: 10, outputTokens: 5 },
            repaired: null,
            emitted: { text: "cached reply", toolUseIds: [] },
          }),
        },
      ],
    });

    await engine.execute();

    expect(chatStream).not.toHaveBeenCalled();
    const textPushes = vi
      .mocked(handle.push)
      .mock.calls.flat()
      .filter((e) => (e as { type: string }).type === "text_delta");
    expect(textPushes).toHaveLength(0);
    // The cached iteration's content still reaches persistence.
    const insertArgs = (deps.agentStore.insertMessages as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as { messages: Array<{ content: unknown }> } | undefined;
    expect(insertArgs?.messages?.[0]?.content).toEqual([{ type: "text", text: "cached reply" }]);
  });

  it("does not re-run synthesis or the apology pushes when degraded-reply is cached", async () => {
    // The degraded off-ramp (billable synthesis + retract/apology pushes)
    // runs inside the `degraded-reply` step. On replay the cached apology
    // must be persisted verbatim with no second LLM call and no duplicate
    // pushes onto the user's live message.
    const chat = vi.fn();
    const provider = mockProvider({ chat });
    const handle = mockDeliveryHandle();
    const deps = mockDeps({
      resolveProvider: mockResolver(provider),
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      runStreamingAgentLoop: vi.fn().mockResolvedValue({
        text: "",
        messages: [],
        newMessages: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "mock-model",
        iterations: 1,
        streamed: { text: "dangling fragment", toolUseIds: [] },
        degraded: { reason: "model refused the request", subtype: "refusal" },
      }),
    });
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [{ id: "degraded-reply", handler: () => "cached apology from prior attempt" }],
    });

    await engine.execute();

    // No synthesis round trip, no retraction, no apology delta — all of it
    // lives inside the cached step.
    expect(chat).not.toHaveBeenCalled();
    const pushes = vi.mocked(handle.push).mock.calls.flat() as Array<{ type: string }>;
    expect(pushes.filter((e) => e.type === "retract")).toHaveLength(0);
    expect(pushes.filter((e) => e.type === "text_delta")).toHaveLength(0);
    // The cached apology is what gets persisted.
    const insertArgs = (deps.agentStore.insertMessages as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as { messages: Array<{ content: unknown }> } | undefined;
    expect(insertArgs?.messages?.at(-1)?.content).toEqual([
      { type: "text", text: "cached apology from prior attempt" },
    ]);
  });

  it("does not re-run the recall round trip when auto-recall is cached", async () => {
    // Auto-recall costs an embedding round trip per execution and feeds the
    // system prompt; the cached result must be reused on replay so the
    // prompt stays identical across invocations and Hindsight isn't
    // re-queried at every boundary.
    const recall = vi.fn();
    const deps = mockDeps({
      memory: mockMemoryProvider({ recall }),
      transportStore: mockTransportStore({
        getUnbatchedInbound: vi
          .fn()
          .mockResolvedValue([
            { id: "inbound-1", content: "tell me about my homelab setup", source: "user" },
          ]),
      }),
    });
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "auto-recall",
          handler: () => ({ memories: [{ type: "world", content: "cached homelab memory" }] }),
        },
      ],
    });

    await engine.execute();

    expect(recall).not.toHaveBeenCalled();
    // Non-vacuity: the cached memories reached the agent loop's prompt.
    const loopCalls = (deps.runStreamingAgentLoop as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = loopCalls[0]?.[0]?.systemPrompt as string;
    expect(systemPrompt).toContain("cached homelab memory");
  });
});
