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
 *   3. The non-durable streaming section IS re-invoked on every replay (this
 *      is by design — you can't stream out of a `step.run`). The test exists
 *      to make this tradeoff explicit and to catch regressions where someone
 *      moves a side effect out of a step.
 *
 * See design/crash-recovery.md for the full contract.
 */

import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../inngest/client.js";
import {
  mockAgentStore,
  mockDeliveryHandle,
  mockDeliveryRouter,
  mockMemoryProvider,
  mockProvider,
  mockToolRegistry,
  mockTransportStore,
} from "../test/factories.js";
import type { HandleMessageDeps } from "./handle-message.js";
import { createHandleMessage } from "./handle-message.js";

// Stub the singleton Inngest client's private `_send` so step.sendEvent calls
// inside the function under test don't try to reach a real Inngest dev server.
// @inngest/test mocks step.* on the ctx, but the engine internally invokes
// `inngest._send` (not the public `send`). Without this stub each test waits
// ~2s for an ECONNREFUSED retry.
//
// Reaching into a private member of an upstream class is fragile — if `_send`
// is renamed in a future inngest release the spy silently no-ops and the tests
// slow down. Worth tracking whether @inngest/test eventually intercepts at
// this layer so the stub can be removed.
beforeEach(() => {
  vi.spyOn(inngest as unknown as { _send: () => Promise<unknown> }, "_send").mockResolvedValue({
    ids: [],
  });
});

afterEach(() => {
  // Restore the singleton spy so it doesn't leak into other test files that
  // share the worker process.
  vi.restoreAllMocks();
});

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
    deliveryRouter: mockDeliveryRouter({
      prepare: vi.fn().mockResolvedValue(mockDeliveryHandle()),
    }),
    runStreamingAgentLoop: vi.fn().mockResolvedValue({
      text: "Hello from assistant",
      messages: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "mock-model",
      iterations: 1,
    }),
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

    // Assistant message is still inserted (its step was not cached), but the
    // user message is NOT — that step's body never runs.
    const userInserts = (
      deps.agentStore.insertMessage as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([params]) => params.role === "user");
    expect(userInserts).toHaveLength(0);

    const assistantInserts = (
      deps.agentStore.insertMessage as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([params]) => params.role === "assistant");
    expect(assistantInserts).toHaveLength(1);
  });

  it("does not re-insert the assistant message when persist-assistant-message is cached", async () => {
    const deps = mockDeps();
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "persist-assistant-message",
          handler: () => ({ id: "cached-assistant-msg-id" }),
        },
      ],
    });

    await engine.execute();

    const assistantInserts = (
      deps.agentStore.insertMessage as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([params]) => params.role === "assistant");
    expect(assistantInserts).toHaveLength(0);
  });

  it("does not re-run the summarization LLM call when summarize-prefix is cached", async () => {
    // To exercise the summarize step, we need the compaction pipeline to
    // actually call its `summarize` callback. That requires:
    //   - getLastInputTokens past the fast-path threshold so countTokens runs
    //   - countTokens reporting > 80% of budget so the SUMMARIZE strategy fires
    //   - history with more than DEFAULT_KEEP_TURNS messages (6) so there's
    //     a prefix to summarize
    // Then we cache `summarize-prefix` and assert provider.chat is never
    // called for the summarization round trip.
    const countTokens = vi.fn().mockResolvedValue(150_000); // always over 80% of any sane budget
    const chat = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "fresh summary" }],
      stopReason: "end_turn",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const deps = mockDeps({
      provider: mockProvider({ countTokens, chat }),
      agentStore: mockAgentStore({
        getLastInputTokens: vi.fn().mockResolvedValue(150_000),
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
        { id: "persist-assistant-message", handler: () => ({ id: "asst-1" }) },
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
  });
});
