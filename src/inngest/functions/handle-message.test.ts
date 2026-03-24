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
  const proxy: any = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        return (..._args: any[]) => proxy;
      },
    },
  );
  return proxy;
}

function mockDeps(overrides?: Partial<HandleMessageDeps>): HandleMessageDeps {
  // Global select counter across all transactions
  let globalSelectCall = 0;
  const allSelectResults: Record<string, unknown>[][] = [
    // persist-inbound tx:
    [{ id: "chat-1" }], // 0: find existing chat
    // resolve-session tx:
    [{ conversationId: "conv-1" }], // 1: chat's linked conversation
    [{ profileId: "profile-1" }], // 2: conversation's profile
  ];

  function makeTx() {
    return {
      select: vi.fn().mockImplementation(() => {
        const result = allSelectResults[globalSelectCall++] ?? [];
        const terminal = vi.fn().mockResolvedValue(result);
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: terminal }),
          }),
        };
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "generated-id" }]),
        }),
      }),
      update: vi.fn().mockReturnValue(chainMock()),
    };
  }

  const db = {
    select: vi.fn().mockReturnValue(chainMock()),
    insert: vi.fn().mockReturnValue(chainMock()),
    update: vi.fn().mockReturnValue(chainMock()),
    transaction: vi.fn((fn: (tx: any) => any) => fn(makeTx())),
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
    defaultProfileId: "default-profile",
    ...overrides,
  };
}

const testEvent = {
  data: {
    channel: "cli",
    chatId: "chat-1",
    userId: "user-1",
    text: "hello",
  },
};

describe("createHandleMessage", () => {
  it("calls assembleSystemPrompt with db and profileId", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({ event: testEvent, step: mockStep() });

    expect(deps.assembleSystemPrompt).toHaveBeenCalledWith(deps.db, expect.any(String));
  });

  it("calls runAgentLoop with provider and tools", async () => {
    const deps = mockDeps();
    await (createHandleMessage(deps) as any).fn({ event: testEvent, step: mockStep() });

    expect(deps.runAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: deps.provider,
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
          channel: "cli",
          chatId: "chat-1",
          text: "Hello from assistant",
        }),
      }),
    );
  });
});
