import { describe, expect, it, vi } from "vitest";
import type { HandleMessageDeps } from "./handle-message.js";
import { createHandleMessage } from "./handle-message.js";

function mockStep() {
  return {
    run: vi.fn((_id: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn(),
  };
}

function chainMock() {
  const terminal = vi.fn().mockResolvedValue([]);
  const proxy: any = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        return (..._args: any[]) => {
          terminal(..._args);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

function mockDeps(overrides?: Partial<HandleMessageDeps>): HandleMessageDeps {
  const db = {
    select: vi.fn().mockReturnValue(chainMock()),
    insert: vi.fn().mockReturnValue(chainMock()),
    update: vi.fn().mockReturnValue(chainMock()),
  } as any;

  return {
    db,
    provider: { name: "mock", chat: vi.fn() },
    tools: { definitions: () => [], get: () => undefined } as any,
    assembleSystemPrompt: vi.fn().mockResolvedValue("system prompt"),
    runAgentLoop: vi.fn().mockResolvedValue({
      text: "Hello from assistant",
      messages: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "mock-model",
      iterations: 1,
    }),
    ...overrides,
  };
}

const testEvent = {
  data: {
    conversationId: "conv-1",
    channel: "cli",
    chatId: "chat-1",
    userId: "user-1",
    text: "hello",
  },
};

describe("createHandleMessage", () => {
  it("calls assembleSystemPrompt with db", async () => {
    const deps = mockDeps();
    const fn = createHandleMessage(deps);
    await (fn as any).fn({ event: testEvent, step: mockStep() });

    expect(deps.assembleSystemPrompt).toHaveBeenCalledWith(deps.db);
  });

  it("calls runAgentLoop with assembled prompt and provider", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({ event: testEvent, step: mockStep() });

    expect(deps.runAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: deps.provider,
        systemPrompt: "system prompt",
        tools: deps.tools,
      }),
    );
  });

  it("emits message/response event with result text", async () => {
    const deps = mockDeps();
    const step = mockStep();
    await (createHandleMessage(deps) as any).fn({ event: testEvent, step });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "send-response",
      expect.objectContaining({
        name: "message/response",
        data: expect.objectContaining({
          conversationId: "conv-1",
          channel: "cli",
          chatId: "chat-1",
          text: "Hello from assistant",
        }),
      }),
    );
  });

  it("persists user and assistant messages via db.insert", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({ event: testEvent, step: mockStep() });

    // Should insert at least twice: user message + assistant message
    expect(vi.mocked(deps.db.insert).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
