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
import { beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.spyOn(inngest as unknown as { _send: () => Promise<unknown> }, "_send").mockResolvedValue({
    ids: [],
  });
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

  it("does not re-run the summarization LLM call when compact-context is cached", async () => {
    // Force compaction to want to run on first execution: large lastInputTokens
    // would normally trigger countTokens + maybe summarize. We provide a
    // cached compact-context step → the body is bypassed entirely, so chat()
    // for summarization is never called.
    const deps = mockDeps({
      agentStore: mockAgentStore({
        getLastInputTokens: vi.fn().mockResolvedValue(150_000), // would force compaction
      }),
    });
    const fn = createHandleMessage(deps);

    const engine = new InngestTestEngine({
      function: fn,
      events: [event],
      steps: [
        {
          id: "compact-context",
          // Cached value: the compacted message history. Empty array is fine
          // for the assertion (we're not checking what the agent loop receives).
          handler: () => [],
        },
      ],
    });

    await engine.execute();

    // The summarization path inside compactMessages calls provider.chat().
    // With compact-context cached, the body never runs, so chat is not called.
    expect(deps.provider.chat).not.toHaveBeenCalled();
    // Token counting (which compactMessages uses repeatedly) also never runs.
    expect(deps.provider.countTokens).not.toHaveBeenCalled();
    // And the DB read for last input tokens stays inside the step, so it's
    // skipped on cached replay too.
    expect(deps.agentStore.getLastInputTokens).not.toHaveBeenCalled();
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
        { id: "compact-context", handler: () => [] },
        { id: "persist-assistant-message", handler: () => ({ id: "asst-1" }) },
      ],
    });

    await engine.execute();

    // Streaming agent loop is outside any step → runs at least once even on
    // full-cache replay. (This is the canary: if a developer wraps the agent
    // loop in a step.run, this assertion stays true but the surrounding
    // streaming behavior breaks.)
    expect(
      (deps.runStreamingAgentLoop as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
    // No DB writes happened — every persist step was cached.
    expect(deps.agentStore.insertMessage).not.toHaveBeenCalled();
  });
});
