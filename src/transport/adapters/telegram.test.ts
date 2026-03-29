import { ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "../../test/factories.js";
import { setup } from "./telegram.js";

// Mock grammy
const handlers = new Map<string, any>();
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue({}),
  sendChatAction: vi.fn().mockResolvedValue(true),
};

vi.mock("grammy", () => {
  class MockBot {
    api = mockBotApi;
    command = vi.fn((cmd: string, handler: any) => handlers.set(`command:${cmd}`, handler));
    on = vi.fn((filter: string, handler: any) => handlers.set(`on:${filter}`, handler));
    catch = vi.fn();
    start = vi.fn(({ onStart }: any = {}) => onStart?.());
    stop = vi.fn();
  }
  return { Bot: MockBot };
});

function makeCtx(fromId: number, text = "hello", chatId = 42) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: { text, date: 1700000000 },
    reply: vi.fn().mockResolvedValue({}),
    api: { sendChatAction: vi.fn().mockResolvedValue(true) },
  };
}

describe("telegram adapter", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  async function createAdapter(transportOverrides?: Partial<ReturnType<typeof mockTransport>>) {
    const transport = mockTransport({
      resolveSession: vi.fn().mockResolvedValue({
        id: "session-1",
        channelId: "tg-ch",
        platformAddress: "42",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
      }),
      createConversation: vi.fn().mockResolvedValue(
        ok({
          id: "session-2",
          channelId: "tg-ch",
          platformAddress: "42",
          conversationId: "conv-2",
          status: "active",
          receive: "routed",
        }),
      ),
      emit: vi.fn().mockResolvedValue(ok(undefined)),
      ...transportOverrides,
    });

    const result = await setup({
      channelId: "tg-ch",
      credentials: { token: "fake" },
      transport,
    });

    return { adapter: result.adapter, transport };
  }

  it("emits via transport on text message", async () => {
    const { transport } = await createAdapter();
    await handlers.get("on:message:text")!(makeCtx(111, "test message", 42));

    expect(transport.emit).toHaveBeenCalledWith("session-1", "test message", expect.any(Date));
  });

  it("creates conversation when no session exists", async () => {
    const { transport } = await createAdapter({
      resolveSession: vi.fn().mockResolvedValue(null),
    });
    await handlers.get("on:message:text")!(makeCtx(111, "first message", 42));

    expect(transport.createConversation).toHaveBeenCalledWith("42", "111", { isPrivate: true });
  });

  it("sends typing indicator", async () => {
    await createAdapter();
    const ctx = makeCtx(111);
    await handlers.get("on:message:text")!(ctx);

    expect(ctx.api.sendChatAction).toHaveBeenCalledWith(42, "typing");
  });

  it("/start sends welcome", async () => {
    await createAdapter();
    const ctx = makeCtx(111);
    await handlers.get("command:start")!(ctx);

    expect(ctx.reply).toHaveBeenCalled();
  });

  it("/new closes session", async () => {
    const { transport } = await createAdapter();
    const ctx = makeCtx(111, "/new", 42);
    await handlers.get("command:new")!(ctx);

    expect(transport.closeSession).toHaveBeenCalledWith("session-1");
    expect(ctx.reply).toHaveBeenCalledWith("New conversation started.");
  });

  it("deliver sends via bot API", async () => {
    const { adapter } = await createAdapter();
    await adapter.deliver("12345", "response");

    expect(mockBotApi.sendMessage).toHaveBeenCalledWith(12345, "response");
  });
});
