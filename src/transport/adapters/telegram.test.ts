import { ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "../../test/factories.js";
import type { StreamingAdapter } from "../types.js";
import { setup } from "./telegram.js";

// Mock grammy
const handlers = new Map<string, any>();
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
  editMessageText: vi.fn().mockResolvedValue({}),
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

  describe("streaming", () => {
    async function createStreamingAdapter() {
      const { adapter } = await createAdapter();
      return adapter as unknown as StreamingAdapter;
    }

    it("openStream sends initial message on first push", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Hello" });

      expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "Hello");
    });

    it("subsequent pushes edit the message", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Hello" });
      // Advance time past throttle interval
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await handle.push({ type: "text_delta", text: " world" });

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "Hello world");
    });

    it("finish sends final edit", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "done" });
      mockBotApi.editMessageText.mockClear();
      await handle.finish();

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "done");
    });

    it("abort appends error to message", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "partial" });
      mockBotApi.editMessageText.mockClear();
      await handle.abort("LLM failed");

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "partial\n\n⚠️ LLM failed");
    });

    it("retry dedup returns same handle for same runId", async () => {
      const adapter = await createStreamingAdapter();
      const handle1 = await adapter.openStream("42", "run-1");
      const handle2 = await adapter.openStream("42", "run-1");

      expect(handle1).toBe(handle2);
    });

    it("different runId creates different handle", async () => {
      const adapter = await createStreamingAdapter();
      const handle1 = await adapter.openStream("42", "run-1");
      const handle2 = await adapter.openStream("42", "run-2");

      expect(handle1).not.toBe(handle2);
    });

    it("tool_start appends tool indicator", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Let me search." });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await handle.push({
        type: "tool_start",
        id: "t1",
        name: "web_search",
        input: {},
      });

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(
        42,
        100,
        "Let me search.\n🔍 web_search...\n",
      );
    });
  });
});
