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
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { inngest } from "../inngest/client.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import type { ChatParams, ChatStreamResult, StreamEvent, ToolDefinition } from "../llm/types.js";
import { agentIterations, memoryRecallFailures } from "../metrics.js";
import type { SkillRunner } from "../skills/runner.js";
import { expectDefined } from "../test/assertions.js";
import {
  fakeRunInTx,
  MOCK_MESSAGE_CREATED_AT,
  mockAgentStore,
  mockDeliveryHandle,
  mockDeliveryRouter,
  mockFilesService,
  mockMemoryProvider,
  mockProvider,
  mockResolver,
  mockToolRegistry,
  mockTransportStore,
  mockVoiceBundle,
  mockVoiceResolver,
  spyOnInngestSend,
  turnContextSent,
} from "../test/factories.js";
import { createWireRecorder } from "../test/wire-recorder.js";
import { canonicalKeyOrder } from "../util/canonical-key-order.js";
import type { HandleMessageDeps } from "./handle-message.js";
import { createHandleMessage } from "./handle-message.js";
import { runStreamingAgentLoop } from "./loop.js";
import { defineTool, ToolRegistry } from "./tools.js";

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
    promptSource: {
      assemble: vi.fn().mockResolvedValue("system prompt"),
      configuration: vi.fn().mockResolvedValue("configuration"),
    },
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

/** The turn's row as `load-turn-transcript` returns it: the history's `msg-1`, its time as a string. */
const TURN_ROW = { id: "msg-1", createdAt: MOCK_MESSAGE_CREATED_AT.toISOString() };

/** An epoch the turn's own row opened, as `open-system-prompt-epoch` returns it. */
const EPOCH = {
  openedBy: "msg-1",
  historyStart: "msg-1",
  rendered: "system prompt",
  configDigest: "digest",
};

/** A `load-system-prompt` result continuing `EPOCH`, with nothing to announce. */
const LOADED_SYSTEM_PROMPT = {
  rendered: "system prompt",
  configDigest: "digest",
  snapshot: EPOCH,
  channelTypes: [],
  coreMemoryChanges: [],
};

/** The system prompt the agent loop was given. */
function loopSystemPrompt(deps: HandleMessageDeps): string {
  return expectDefined(vi.mocked(deps.runStreamingAgentLoop).mock.calls[0], "agent loop call")[0]
    .systemPrompt;
}

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

  it("does not re-run the summarization LLM call when summarize-prefix-outcome is cached", async () => {
    // To exercise the summarize step, we need the compaction pipeline to
    // actually call its `summarize` callback. That requires:
    //   - getLastTokens past the fast-path threshold so countTokens runs
    //   - countTokens reporting > 80% of budget so the SUMMARIZE strategy fires
    //   - history with more than DEFAULT_KEEP_TURNS messages (6) so there's
    //     a prefix to summarize
    // Then we cache `summarize-prefix-outcome` and assert provider.chat is never
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
        listMessages: vi.fn().mockResolvedValue([
          { id: "m1", role: "user", content: "m1" },
          { id: "m2", role: "assistant", content: "r1" },
          { id: "m3", role: "user", content: "m2" },
          { id: "m4", role: "assistant", content: "r2" },
          { id: "m5", role: "user", content: "m3" },
          { id: "m6", role: "assistant", content: "r3" },
          { id: "msg-1", role: "user", content: "m4" },
          { id: "m8", role: "assistant", content: "r4" },
        ]),
      }),
    });
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "summarize-prefix-outcome",
          // Cached value: the summary text from a prior attempt.
          handler: () => ({
            text: "[cached summary from prior attempt]",
            stopReason: "end_turn",
          }),
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

  it("does not re-insert the summary when persist-summary is cached", async () => {
    // Same setup as the summarize-prefix-outcome replay above, plus the ids the
    // persist step needs to name a durable cutoff. Caching `persist-summary`
    // stands in for the crash-after-commit case: the row is already there, and
    // the replay must not write a second one.
    const deps = mockDeps({
      resolveProvider: mockResolver(
        mockProvider({
          countTokens: vi.fn().mockResolvedValue(800_000),
          chat: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "fresh summary" }],
            stopReason: "end_turn",
            model: "mock-model",
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
        }),
      ),
      agentStore: mockAgentStore({
        getLastTokens: vi.fn().mockResolvedValue({ inputTokens: 800_000, outputTokens: 2_000 }),
        listMessages: vi.fn().mockResolvedValue(
          Array.from({ length: 8 }, (_, i) => ({
            id: `m${i + 1}`,
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i + 1}`,
          })),
        ),
        // The turn's row: the last user row above.
        findUserMessageByInbound: vi
          .fn()
          .mockResolvedValue({ id: "m7", createdAt: MOCK_MESSAGE_CREATED_AT }),
      }),
    });
    const fn = createHandleMessage(deps);

    await new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        // Mirrors what the step actually returns — the row is projected down to
        // its id so the summary text doesn't land in Inngest state twice.
        { id: "persist-summary", handler: () => ({ id: "cached-summary-id" }) },
      ],
    }).execute();

    expect(deps.agentStore.insertOrRecoverSummary).not.toHaveBeenCalled();

    // Non-vacuity: the identical run without the cached step does reach the
    // store, so the assertion above is about the cache and not about the
    // pipeline having skipped summarization altogether.
    await new InngestTestEngine({ function: fn, events: [event] }).execute();
    expect(deps.agentStore.insertOrRecoverSummary).toHaveBeenCalledTimes(1);
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
        {
          id: "load-turn-transcript",
          handler: () => ({
            messages: [{ role: "user", content: "hi" }],
            messageIds: ["msg-1"],
            turnContexts: [null],
            turn: TURN_ROW,
          }),
        },
        {
          id: "load-system-prompt",
          handler: () => ({ ...LOADED_SYSTEM_PROMPT, snapshot: null }),
        },
        { id: "open-system-prompt-epoch", handler: () => EPOCH },
        // `summarize-prefix-outcome` is conditional — only created when compaction
        // decides to summarize. The default mock countTokens stays under
        // threshold, so the step is never invoked here and we don't list it.
        { id: "render-turn-context", handler: () => "<turn_context>cached</turn_context>\n\n" },
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
    expect(deps.agentStore.insertOrRecoverSystemPromptSnapshot).not.toHaveBeenCalled();
    expect(deps.agentStore.insertOrRecoverTurnContext).not.toHaveBeenCalled();
    expect(deps.agentStore.insertMessages).not.toHaveBeenCalled();
    // The loop sends the cached turn context.
    expect(turnContextSent(deps)).toBe("<turn_context>cached</turn_context>\n\n");
  });

  it("serves a turn whose create-user-message result is empty from the row it committed", async () => {
    // The row is found by its inbound cursor inside `load-turn-transcript`, so
    // the turn needs nothing from `create-user-message`'s result: an empty one
    // replays into the same turn as a fresh run.
    const deps = mockDeps();

    const { result } = await new InngestTestEngine({
      function: createHandleMessage(deps),
      events: [event],
      steps: [{ id: "create-user-message", handler: () => null }],
    }).execute();

    expect(result).toMatchObject({ status: "processed" });
    expect(deps.agentStore.insertMessage).not.toHaveBeenCalled();
    expect(deps.agentStore.findUserMessageByInbound).toHaveBeenCalledWith(
      expect.anything(),
      "conv-1",
      "inbound-1",
    );
    // The reply is persisted once, as on a fresh run.
    expect(deps.agentStore.insertMessages).toHaveBeenCalledTimes(1);
    const [, stored] = expectDefined(
      vi.mocked(deps.agentStore.insertOrRecoverTurnContext).mock.calls[0],
      "insertOrRecoverTurnContext call",
    );
    expect(stored.messageId).toBe("msg-1");
    // The row's `created_at`, as the turn context shows it.
    expect(turnContextSent(deps)).toContain(
      "Current time: Friday, September 25, 2026, 08:14 (UTC)",
    );
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

  it("records the turn's iteration count from inside the persist step", async () => {
    const record = vi.spyOn(agentIterations, "record");
    const deps = mockDeps();
    const fn = createHandleMessage(deps);

    await new InngestTestEngine({ function: fn, events: [event] }).execute();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(1, { model: "mock-model" });

    // After the write, not before it: a step body re-runs on every retry, so a
    // sample taken ahead of the transaction is repeated whenever the
    // transaction is what keeps failing.
    const insert = vi.mocked(deps.agentStore.insertMessages);
    expect(record.mock.invocationCallOrder[0]).toBeGreaterThan(
      expectDefined(insert.mock.invocationCallOrder[0], "insertMessages call order"),
    );
  });

  it("does not record the iteration count again when persist-new-messages is cached", async () => {
    // The anti-inflation contract, with the REAL loop so the assertion covers
    // the whole turn rather than a stubbed result. @inngest/test re-invokes
    // the function once per step boundary, so anything recording from the bare
    // body lands a sample on each pass — several per turn, all for the same
    // turn. Recording inside `persist-new-messages` means a cached step
    // contributes nothing.
    const record = vi.spyOn(agentIterations, "record");
    const deps = mockDeps({ runStreamingAgentLoop });
    const fn = createHandleMessage(deps);

    // `llm-iter1` is cached too, so the real loop completes a turn and reaches
    // its result builder without a provider call. Without it the loop dies on
    // the unimplemented `chatStream` before building a result, and the
    // assertion below passes for the wrong reason.
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
        { id: "persist-new-messages", handler: () => ({ id: "asst-1" }) },
      ],
    });

    await engine.execute();

    expect(record).not.toHaveBeenCalled();
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
    // turn context; the cached result must be reused on replay so the
    // context stays identical across invocations and Hindsight isn't
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
    // Non-vacuity: the cached memories reached the turn's context.
    expect(turnContextSent(deps)).toContain("- cached homelab memory");
  });

  it("counts a failed auto-recall once per turn, not once per re-invocation", async () => {
    // The engine re-invokes the function at every step boundary. The count is
    // taken in the `auto-recall` body's catch, which runs once and is then
    // replayed from the step cache, so the turn contributes one failure however
    // many passes the body makes.
    const add = vi.spyOn(memoryRecallFailures, "add");
    const recall = vi.fn().mockRejectedValue(new Error("recall 500: reranker unreachable"));
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

    await new InngestTestEngine({ function: fn, events: [event] }).execute();

    expect(recall).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(1, { bank_id: "user-1" });
    // Non-vacuity: the bare body reached the recall site on more than one
    // pass. `buildTurnService` reads the profile-class registry just above it.
    expect(vi.mocked(deps.agentStore.listProfileClasses).mock.calls.length).toBeGreaterThan(1);
  });

  it("sends the cached turn context and does not store another when render-turn-context is cached", async () => {
    const cached =
      "<turn_context>\nCurrent time: cached\n\nReply modality: text\n</turn_context>\n\n";
    const deps = mockDeps();
    const fn = createHandleMessage(deps);

    await new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [{ id: "render-turn-context", handler: () => cached }],
    }).execute();

    expect(deps.agentStore.insertOrRecoverTurnContext).not.toHaveBeenCalled();
    expect(turnContextSent(deps)).toBe(cached);

    // Non-vacuity: uncached, the same run stores the context it sends.
    await new InngestTestEngine({ function: fn, events: [event] }).execute();
    expect(deps.agentStore.insertOrRecoverTurnContext).toHaveBeenCalledTimes(1);
    const [, stored] = expectDefined(
      vi.mocked(deps.agentStore.insertOrRecoverTurnContext).mock.calls[0],
      "insertOrRecoverTurnContext call",
    );
    expect(stored.messageId).toBe("msg-1");
    expect(turnContextSent(deps, -1)).toBe(stored.rendered);
  });

  it("sends the text a retried render step recovers, not the text it rendered", async () => {
    // A crash after the insert commits re-runs the step body; the conflict arm
    // hands back the row the first attempt stored, and that is what goes out.
    const stored = "<turn_context>\nstored by the first attempt\n</turn_context>\n\n";
    const deps = mockDeps({
      agentStore: mockAgentStore({
        insertOrRecoverTurnContext: vi.fn().mockImplementation(async (_tx, params) => ({
          ...params,
          rendered: stored,
        })),
      }),
    });

    await new InngestTestEngine({ function: createHandleMessage(deps), events: [event] }).execute();

    expect(turnContextSent(deps)).toBe(stored);
  });
  it("does not open another epoch when open-system-prompt-epoch is cached", async () => {
    const cached = { ...EPOCH, rendered: "CACHED EPOCH PROMPT" };
    const deps = mockDeps();
    const fn = createHandleMessage(deps);

    await new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [{ id: "open-system-prompt-epoch", handler: () => cached }],
    }).execute();

    expect(deps.agentStore.insertOrRecoverSystemPromptSnapshot).not.toHaveBeenCalled();
    expect(loopSystemPrompt(deps)).toBe("CACHED EPOCH PROMPT");

    // Non-vacuity: uncached, the conversation's first turn opens its epoch.
    await new InngestTestEngine({ function: fn, events: [event] }).execute();
    expect(deps.agentStore.insertOrRecoverSystemPromptSnapshot).toHaveBeenCalledTimes(1);
  });

  it("decides the epoch from a cached load-system-prompt, not this invocation's reads", async () => {
    // Live, the conversation has no epoch yet; the cached step found one this
    // turn continues.
    const deps = mockDeps();

    await new InngestTestEngine({
      function: createHandleMessage(deps),
      events: [event],
      steps: [
        {
          id: "load-system-prompt",
          handler: () => ({
            ...LOADED_SYSTEM_PROMPT,
            rendered: "RENDERED NOW",
            snapshot: { ...EPOCH, rendered: "CACHED EPOCH PROMPT" },
          }),
        },
      ],
    }).execute();

    expect(deps.promptSource.assemble).not.toHaveBeenCalled();
    expect(deps.agentStore.getLatestSystemPromptSnapshot).not.toHaveBeenCalled();
    expect(deps.agentStore.insertOrRecoverSystemPromptSnapshot).not.toHaveBeenCalled();
    expect(loopSystemPrompt(deps)).toBe("CACHED EPOCH PROMPT");
  });
});

describe("handle-message — replay equality", () => {
  const EPOCH_OPENED_AT = new Date("2026-09-25T08:00:00.000Z");

  type SseBlock = { text: string } | { toolUse: { id: string; name: string; input: string } };

  /**
   * Anthropic's streaming response for one iteration, as the SDK parses it. A
   * tool input is the JSON text the model streams, so its key order is the
   * model's.
   */
  function anthropicStream(id: string, blocks: ReadonlyArray<SseBlock>, stopReason: string) {
    const events = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      ...blocks.flatMap((block, index) => [
        "text" in block
          ? { type: "content_block_start", index, content_block: { type: "text", text: "" } }
          : {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: block.toolUse.id,
                name: block.toolUse.name,
                input: {},
              },
            },
        "text" in block
          ? { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }
          : {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: block.toolUse.input },
            },
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  /**
   * A turn with an earlier turn context in its history, recalled memories one
   * of which that context already shows, and a tool call whose input the model
   * emits in non-canonical key order — on a real `AnthropicProvider` behind the
   * wire recorder, so requests compare as the bytes sent.
   */
  function replayDeps(epoch: { configDigest: string } | null) {
    const recorder = createWireRecorder(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.endsWith("/v1/messages/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 100 }), {
          headers: { "content-type": "application/json" },
        });
      }
      const body = z.object({ messages: z.array(z.unknown()) }).parse(await req.json());
      // The follow-up carries the tool result: two more messages than the first request.
      return body.messages.length === 3
        ? anthropicStream(
            "msg_iter1",
            [{ toolUse: { id: "toolu_1", name: "echo", input: '{"zeta": 1, "alpha": "x"}' } }],
            "tool_use",
          )
        : anthropicStream("msg_iter2", [{ text: "done" }], "end_turn");
    });
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "Echo the input",
        schema: z.object({ zeta: z.number(), alpha: z.string() }),
        durable: true,
        handler: async ({ alpha }) => `echoed ${alpha}`,
      }),
    );
    const earlierContext =
      "<turn_context>\nCurrent time: earlier\n\n<recalled_memories>\n- old fact\n</recalled_memories>\n\nReply modality: text\n</turn_context>\n\n";
    const deps = mockDeps({
      tools,
      resolveProvider: mockResolver(
        new AnthropicProvider("test-key", "http://anthropic.test", { fetch: recorder.fetch }),
      ),
      memory: mockMemoryProvider({
        recall: vi.fn().mockResolvedValue({
          memories: [
            { type: "world", content: "old fact" },
            { type: "world", content: "new fact" },
          ],
        }),
      }),
      transportStore: mockTransportStore({
        getUnbatchedInbound: vi
          .fn()
          .mockResolvedValue([
            { id: "inbound-1", content: "tell me about my homelab setup", source: "user" },
          ]),
      }),
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue({
          id: "profile-1",
          userId: null,
          name: "assistant",
          basePrompt: "test",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "always",
          voiceMode: "auto",
          toolSet: ["*"],
          memoryScope: null,
          profileClass: null,
          streamChunkChars: 4000,
          streamEdits: true,
          codingAutoapproveMode: "off",
        }),
        listMessages: vi.fn().mockResolvedValue([
          { id: "m1", role: "user", content: "earlier question" },
          {
            id: "m2",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "earlier-signature" },
              { type: "text", text: "earlier answer" },
            ],
          },
          { id: "msg-1", role: "user", content: "tell me about my homelab setup" },
        ]),
        // A continuing epoch opened by m1, and a core-memory block changed since.
        ...(epoch !== null && {
          getLatestSystemPromptSnapshot: vi.fn().mockResolvedValue({
            id: "snapshot-0",
            conversationId: "conv-1",
            openedBy: "m1",
            historyStart: "m1",
            rendered: "EPOCH PROMPT",
            configDigest: epoch.configDigest,
            createdAt: EPOCH_OPENED_AT,
          }),
          getCoreMemoryBlocks: vi
            .fn()
            .mockResolvedValue([{ profileClass: null, key: "identity", content: "Home: Lisbon" }]),
          getCoreMemoryUpdateTimes: vi.fn().mockResolvedValue([
            {
              profileClass: null,
              key: "identity",
              updatedAt: new Date(EPOCH_OPENED_AT.getTime() + 60_000),
            },
          ]),
        }),
        listTurnContexts: vi.fn().mockResolvedValue([
          {
            messageId: "m1",
            rendered: earlierContext,
            context: {
              recalledMemories: ["old fact"],
              voiceMode: false,
              channelTypes: [],
              announcedCoreMemoryBlocks: [],
            },
          },
        ]),
      }),
      runStreamingAgentLoop,
    });
    const messageRequests = () =>
      recorder.exchanges.filter((e) => e.request.url.endsWith("/v1/messages"));
    return { deps, messageRequests };
  }

  /** Every step the turn plans before its second model call, in plan order. */
  const STEPS_BEFORE_ITER2 = [
    "load-conversation",
    "last-assistant",
    "load-turn-snapshot",
    "load-inbound",
    "create-user-message",
    "load-turn-transcript",
    "freeze-core-memory-scope",
    "freeze-turn-inputs",
    "load-system-prompt",
    "auto-recall",
    "freeze-model-limits",
    "load-last-tokens",
    "count-tokens-1",
    "open-system-prompt-epoch",
    "render-turn-context",
    "llm-iter1",
    "tool-iter1-0",
    "emit-tool-results-iter1",
  ];

  /**
   * `llm-iter2`'s request body from a fresh run, after asserting a run that
   * replays `stepIds` as the server returns them sends the same bytes.
   */
  async function replayedIter2(
    epoch: { configDigest: string } | null,
    stepIds: ReadonlyArray<string>,
  ): Promise<string> {
    const fresh = replayDeps(epoch);
    await new InngestTestEngine({
      function: createHandleMessage(fresh.deps),
      events: [event],
    }).execute();
    const freshRequests = fresh.messageRequests();
    expect(freshRequests).toHaveLength(2);

    // Each earlier step's output as the server hands it back: keys sorted at
    // every depth, strings untouched.
    const source = replayDeps(epoch);
    const steps = [];
    for (const id of stepIds) {
      const { result } = await new InngestTestEngine({
        function: createHandleMessage(source.deps),
        events: [event],
      }).executeStep(id);
      steps.push({ id, handler: () => canonicalKeyOrder(result) });
    }

    const replayed = replayDeps(epoch);
    await new InngestTestEngine({
      function: createHandleMessage(replayed.deps),
      events: [event],
      steps,
    }).execute();
    const replayedRequests = replayed.messageRequests();

    // Only llm-iter2 ran: nothing before it re-executed.
    expect(replayedRequests).toHaveLength(1);
    expect(replayed.deps.memory.recall).not.toHaveBeenCalled();
    expect(replayed.deps.agentStore.insertOrRecoverTurnContext).not.toHaveBeenCalled();
    const sent = JSON.stringify(
      expectDefined(replayedRequests[0], "replayed llm-iter2").request.body,
    );
    expect(sent).toBe(
      JSON.stringify(expectDefined(freshRequests[1], "fresh llm-iter2").request.body),
    );
    return sent;
  }

  it("sends llm-iter2 the same bytes whether the earlier steps ran or were replayed", async () => {
    const sent = await replayedIter2(null, STEPS_BEFORE_ITER2);

    // Non-vacuity: the request carries what the replay had to reproduce — the
    // earlier turn's stored context, this turn's deduplicated memories, and
    // the tool input in canonical key order — on the epoch the turn opened,
    // which strips the earlier turn's thinking.
    expect(sent).toContain("Current time: earlier");
    expect(sent).toContain("- new fact");
    expect(sent.match(/- old fact/g)).toHaveLength(1);
    expect(sent).toContain('"input":{"alpha":"x","zeta":1}');
    expect(sent).not.toContain("earlier-signature");
  });

  it("sends llm-iter2 the same bytes on a continuing epoch, announcing a core-memory change", async () => {
    // The digest this turn renders, so the stored epoch continues.
    const opening = replayDeps(null);
    await new InngestTestEngine({
      function: createHandleMessage(opening.deps),
      events: [event],
    }).execute();
    const [, opened] = expectDefined(
      vi.mocked(opening.deps.agentStore.insertOrRecoverSystemPromptSnapshot).mock.calls[0],
      "snapshot insert",
    );

    const sent = await replayedIter2(
      { configDigest: opened.configDigest },
      STEPS_BEFORE_ITER2.filter((id) => id !== "open-system-prompt-epoch"),
    );

    expect(sent).toContain('"text":"EPOCH PROMPT"');
    expect(sent).toContain("<core_memory_updates>");
    expect(sent).toContain("earlier-signature");
  });
});

describe("handle-message — turn inputs frozen across re-invocations", () => {
  function profile(overrides: Record<string, unknown> = {}) {
    return {
      id: "profile-1",
      userId: null,
      name: "assistant",
      basePrompt: "test",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: ["*"],
      memoryScope: null,
      profileClass: null,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
      ...overrides,
    };
  }

  function stream(events: StreamEvent[], stopReason: "tool_use" | "end_turn"): ChatStreamResult {
    return {
      events: (async function* () {
        yield* events;
      })(),
      response: Promise.resolve({
        stopReason,
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };
  }

  it("sends the same tools on every iteration when a skill stops loading mid-turn", async () => {
    // The skill's source becomes unreadable once it has run, so every later
    // invocation's live catalog drops it — as `listToolDefs` does for a skill
    // it can't read.
    let skillLoads = true;
    const skillRunner = mock<SkillRunner>();
    skillRunner.listToolDefs.mockImplementation(async () =>
      skillLoads
        ? [
            {
              name: "echo",
              description: "echo a number",
              inputs: { type: "object", properties: { n: { type: "number" } } },
              tier: "wasm",
              riskTier: "notify",
              gitSha: "abc1234",
            },
          ]
        : [],
    );
    skillRunner.invoke.mockImplementation(async () => {
      skillLoads = false;
      return { runId: "skill-run-1", status: "success", output: 42 };
    });
    // Snapshot each request as sent: the loop keeps appending to `messages`.
    const requests: ChatParams[] = [];
    const chatStream = vi.fn((params: ChatParams) => {
      requests.push(structuredClone(params));
      return requests.length === 1
        ? stream([{ type: "tool_start", id: "t1", name: "echo", input: { n: 42 } }], "tool_use")
        : stream([{ type: "text_delta", text: "done" }], "end_turn");
    });
    const deps = mockDeps({
      resolveProvider: mockResolver(mockProvider({ chatStream })),
      agentStore: mockAgentStore({ getProfile: vi.fn().mockResolvedValue(profile()) }),
      skillRunner,
      runStreamingAgentLoop,
    });

    await new InngestTestEngine({ function: createHandleMessage(deps), events: [event] }).execute();

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first?.tools?.map((t) => t.name)).toEqual(["echo"]);
    // Byte-identical, key order included: the cached prefix starts here.
    expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(first?.tools));
    // The skill ran once, and the follow-up carries its result rather than
    // an error for a tool the model was just offered.
    expect(skillRunner.invoke).toHaveBeenCalledTimes(1);
    expect(second?.messages.at(-1)?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "t1",
        content: JSON.stringify({ ok: true, runId: "skill-run-1", output: 42 }),
      },
    ]);
  });

  it("sends byte-identical tools when replayed from the server's copy of freeze-turn-inputs", async () => {
    // The server returns memoized step output with object keys sorted at every
    // depth (as `canonicalKeyOrder` does) and strings unchanged. A table
    // returned as an object fails this; one returned as JSON text passes.
    const builtIns = new ToolRegistry();
    builtIns.register(
      defineTool({
        name: "draw",
        description: "Draw a picture",
        schema: z.object({
          prompt: z.string().describe("What to draw"),
          model: z.string().optional(),
        }),
        handler: async () => "ok",
      }),
    );
    const sentTools: ToolDefinition[][] = [];
    const chatStream = vi.fn((params: ChatParams) => {
      sentTools.push(structuredClone(params.tools ?? []));
      return stream([{ type: "text_delta", text: "done" }], "end_turn");
    });
    const deps = mockDeps({
      tools: builtIns,
      resolveProvider: mockResolver(mockProvider({ chatStream })),
      agentStore: mockAgentStore({ getProfile: vi.fn().mockResolvedValue(profile()) }),
      runStreamingAgentLoop,
    });
    const fn = createHandleMessage(deps);

    await new InngestTestEngine({ function: fn, events: [event] }).execute();
    const { result: frozen } = await new InngestTestEngine({
      function: fn,
      events: [event],
    }).executeStep("freeze-turn-inputs");
    await new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [{ id: "freeze-turn-inputs", handler: () => canonicalKeyOrder(frozen) }],
    }).execute();

    expect(sentTools).toHaveLength(2);
    const [first, second] = sentTools;
    // Non-vacuous: the schemas are not already in the server's key order.
    const schemas = expectDefined(first, "first run's tools").map((d) => d.parameters);
    expect(JSON.stringify(canonicalKeyOrder(schemas))).not.toBe(JSON.stringify(schemas));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("turns on the cached freeze-turn-inputs, not on this invocation's reads", async () => {
    // Live, this turn has no tools and a profile that never voices; the cached
    // step offers `echo` and voices the reply. The prompt, the turn context,
    // the loop and the voice delivery all follow the cached step.
    const tts = {
      name: "openai",
      tts: vi.fn().mockResolvedValue({ audio: Buffer.from([1]), mediaType: "audio/ogg" }),
    };
    const handle = mockDeliveryHandle({
      canDeliverVoice: vi.fn().mockReturnValue(true),
      hasBatchTargets: vi.fn().mockReturnValue(false),
    });
    const echo = {
      name: "echo",
      description: "echo a number",
      inputSchema: { type: "object", properties: {} },
      durable: true,
    };
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue(profile({ voiceMode: "never" })),
      }),
      voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts })),
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
    });

    await new InngestTestEngine({
      function: createHandleMessage(deps),
      events: [event],
      steps: [
        {
          id: "freeze-turn-inputs",
          handler: () => ({ voiceMode: true, batchDelivery: false, tools: JSON.stringify([echo]) }),
        },
      ],
    }).execute();

    const definitions = [
      { name: "echo", description: "echo a number", parameters: echo.inputSchema },
    ];
    expect(deps.promptSource.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ toolDefinitions: definitions }),
    );
    expect(turnContextSent(deps)).toContain("Reply modality: voice");
    const [loopParams] = expectDefined(
      vi.mocked(deps.runStreamingAgentLoop).mock.calls[0],
      "runStreamingAgentLoop call",
    );
    expect(loopParams.tools.definitions()).toEqual(definitions);
    expect(tts.tts).toHaveBeenCalledTimes(1);
    expect(handle.deliverVoice).toHaveBeenCalledTimes(1);
  });

  it("delivers the voice reply its turn context announced when the profile changes mid-turn", async () => {
    // A `/settings` change turns voice off right after the prompt is
    // assembled; the turn keeps the decision it made.
    let voiceMode = "always";
    const tts = {
      name: "openai",
      tts: vi.fn().mockResolvedValue({ audio: Buffer.from([1]), mediaType: "audio/ogg" }),
    };
    const handle = mockDeliveryHandle({
      canDeliverVoice: vi.fn().mockReturnValue(true),
      hasBatchTargets: vi.fn().mockReturnValue(false),
    });
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockImplementation(async () => profile({ voiceMode })),
      }),
      promptSource: {
        assemble: vi.fn().mockImplementation(async () => {
          voiceMode = "never";
          return "system prompt";
        }),
        configuration: vi.fn().mockResolvedValue("configuration"),
      },
      voiceResolver: mockVoiceResolver(mockVoiceBundle({ tts })),
      deliveryRouter: mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(handle) }),
      transportStore: mockTransportStore({
        getVoiceMaxReplyChars: vi.fn().mockResolvedValue(700),
      }),
    });

    await new InngestTestEngine({ function: createHandleMessage(deps), events: [event] }).execute();

    expect(deps.promptSource.assemble).toHaveBeenCalled();
    expect(turnContextSent(deps)).toContain("Reply modality: voice");
    expect(tts.tts).toHaveBeenCalledTimes(1);
    expect(handle.deliverVoice).toHaveBeenCalledTimes(1);
  });
});

describe("handle-message — core-memory scope frozen across re-invocations", () => {
  function gameProfile(profileClass: string | null) {
    return {
      id: "profile-1",
      userId: "user-1",
      name: "game",
      basePrompt: "test",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "off",
      voiceMode: "auto",
      toolSet: ["*"],
      memoryScope: null,
      profileClass,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
    };
  }

  /** A turn whose loop saves `identity`, for a profile of `profileClass`; the user's `game` class is restricted. */
  function scopeDeps(profileClass: string | null) {
    return mockDeps({
      agentStore: mockAgentStore({
        getProfile: vi.fn().mockResolvedValue(gameProfile(profileClass)),
        listProfileClasses: vi.fn().mockResolvedValue([{ name: "game", restricted: true }]),
      }),
      runStreamingAgentLoop: vi.fn().mockImplementation(async ({ service }) => {
        await service.coreMemory.update("identity", "Name: Thorin");
        return {
          text: "Saved.",
          messages: [],
          newMessages: [{ role: "assistant", content: [{ type: "text", text: "Saved." }] }],
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock-model",
          iterations: 1,
          streamed: { text: "", toolUseIds: [] },
        };
      }),
    });
  }

  /** The steps a turn of `scopeDeps` plans before its agent loop, in plan order. */
  const STEPS_BEFORE_LOOP = [
    "load-conversation",
    "last-assistant",
    "load-turn-snapshot",
    "load-inbound",
    "create-user-message",
    "load-turn-transcript",
    "freeze-core-memory-scope",
    "freeze-turn-inputs",
    "load-system-prompt",
    "freeze-model-limits",
    "load-last-tokens",
    "open-system-prompt-epoch",
    "render-turn-context",
  ];

  it("completes a run whose earlier memos predate freeze-core-memory-scope", async () => {
    // An older build ran every step before the loop; its memos, as the server
    // returns them, carry no scope step.
    const source = scopeDeps("game");
    const steps = [];
    for (const id of STEPS_BEFORE_LOOP.filter((id) => id !== "freeze-core-memory-scope")) {
      const { result } = await new InngestTestEngine({
        function: createHandleMessage(source),
        events: [event],
      }).executeStep(id);
      steps.push({ id, handler: () => canonicalKeyOrder(result) });
    }

    const resumed = scopeDeps("game");
    const { error } = await new InngestTestEngine({
      function: createHandleMessage(resumed),
      events: [event],
      steps,
    }).execute();

    expect(error).toBeUndefined();
    // The memoized steps stood: nothing before the loop re-ran.
    expect(resumed.promptSource.assemble).not.toHaveBeenCalled();
    expect(resumed.agentStore.insertOrRecoverTurnContext).not.toHaveBeenCalled();
    // The new step ran, and the turn's write followed it.
    expect(resumed.agentStore.upsertCoreMemoryBlock).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileClass: "game",
      key: "identity",
      content: "Name: Thorin",
    });
    expect(resumed.agentStore.insertMessages).toHaveBeenCalledTimes(1);
  });

  it("completes a run whose earlier memos predate the system prompt snapshot", async () => {
    // An older build assembled the prompt in `assemble-prompt` and ran the rest
    // of the steps before the loop; neither snapshot step ran.
    const source = scopeDeps("game");
    const steps: Array<{ id: string; handler: () => unknown }> = [
      { id: "assemble-prompt", handler: () => "prompt from the older build" },
    ];
    const snapshotSteps = ["load-system-prompt", "open-system-prompt-epoch"];
    for (const id of STEPS_BEFORE_LOOP.filter((id) => !snapshotSteps.includes(id))) {
      const { result } = await new InngestTestEngine({
        function: createHandleMessage(source),
        events: [event],
      }).executeStep(id);
      steps.push({ id, handler: () => canonicalKeyOrder(result) });
    }

    const resumed = scopeDeps("game");
    const { error } = await new InngestTestEngine({
      function: createHandleMessage(resumed),
      events: [event],
      steps,
    }).execute();

    expect(error).toBeUndefined();
    // The memoized steps stood, and the new ones ran once: the turn opens the
    // conversation's first epoch and sends it.
    expect(resumed.agentStore.insertOrRecoverTurnContext).not.toHaveBeenCalled();
    expect(resumed.agentStore.insertOrRecoverSystemPromptSnapshot).toHaveBeenCalledTimes(1);
    expect(loopSystemPrompt(resumed)).toBe("system prompt");
    expect(resumed.agentStore.insertMessages).toHaveBeenCalledTimes(1);
  });

  it("reads and writes the cached scope, not this invocation's profile", async () => {
    // The profile lost its class after the scope was frozen.
    const deps = scopeDeps(null);

    await new InngestTestEngine({
      function: createHandleMessage(deps),
      events: [event],
      steps: [
        {
          id: "freeze-core-memory-scope",
          handler: () => ({ kind: "classed", profileClass: "game", restricted: true }),
        },
      ],
    }).execute();

    expect(deps.agentStore.getCoreMemoryBlocks).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "game",
    );
    expect(deps.agentStore.upsertCoreMemoryBlock).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileClass: "game",
      key: "identity",
      content: "Name: Thorin",
    });
    // Non-vacuity: live, the same profile writes the shared block.
    const live = scopeDeps(null);
    await new InngestTestEngine({ function: createHandleMessage(live), events: [event] }).execute();
    expect(live.agentStore.upsertCoreMemoryBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profileClass: null, key: "identity" }),
    );
  });
});
