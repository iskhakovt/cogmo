import { ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockAttachmentStore, mockTransport } from "../../../test/factories.js";
import type { StreamingAdapter } from "../../types.js";
import { setup } from "./index.js";

// Mock grammy
const handlers = new Map<string, any>();
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
  editMessageText: vi.fn().mockResolvedValue({}),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: 101 }),
  getFile: vi.fn().mockResolvedValue({ file_path: "photos/file_1.jpg" }),
  setMyCommands: vi.fn().mockResolvedValue(true),
};

vi.mock("grammy", () => {
  // Grammy's InputFile wraps a Buffer — the test captures it so assertions can
  // inspect the payload without needing the real grammy implementation.
  // Defined inside the factory to satisfy vi.mock's hoisting constraint.
  class InputFile {
    constructor(
      public data: Buffer | Uint8Array,
      public filename?: string,
    ) {}
  }
  class MockBot {
    api = mockBotApi;
    command = vi.fn((cmd: string, handler: any) => handlers.set(`command:${cmd}`, handler));
    on = vi.fn((filter: string, handler: any) => handlers.set(`on:${filter}`, handler));
    callbackQuery = vi.fn((pattern: RegExp, handler: any) =>
      handlers.set(`callbackQuery:${pattern.source}`, handler),
    );
    catch = vi.fn();
    start = vi.fn(({ onStart }: any = {}) => onStart?.());
    stop = vi.fn();
  }
  return { Bot: MockBot, InputFile };
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

function makePhotoCtx(fromId: number, caption?: string, chatId = 42) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: {
      date: 1700000000,
      caption,
      photo: [
        { file_id: "small_id", width: 90, height: 90 },
        { file_id: "large_id", width: 800, height: 600 },
      ],
    },
    api: {
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/file_1.jpg" }),
    },
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

    const attachments = mockAttachmentStore();

    const result = await setup({
      channelId: "tg-ch",
      credentials: { token: "fake" },
      transport,
      attachments,
    });

    return { adapter: result.adapter, transport, attachments };
  }

  it("registers the bot command menu on setup", async () => {
    await createAdapter();

    expect(mockBotApi.setMyCommands).toHaveBeenCalledOnce();
    const [commands] = mockBotApi.setMyCommands.mock.calls[0];
    const names = (commands as Array<{ command: string; description: string }>).map(
      (c) => c.command,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "new",
        "sessions",
        "resume",
        "name",
        "end",
        "profile",
        "model",
        "repo",
        "mcp",
        "repair",
        "cancel",
        "start",
      ]),
    );
    for (const c of commands as Array<{ command: string; description: string }>) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

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
    expect(ctx.reply.mock.calls[0]?.[0]).toBe("New conversation started.");
  });

  it("mid-dialog text (/profile new flow) does NOT emit to agent", async () => {
    // Start a /profile new dialog, then send a plain text message. The text should be
    // consumed by the FSM and never reach transport.emit. Regression guard: placement of
    // the dialog-intercept check at the top of bot.on("message:text") matters.
    const transport = mockTransport({
      resolveSession: vi.fn().mockResolvedValue({
        id: "session-1",
        channelId: "tg-ch",
        platformAddress: "42",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
      }),
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    await setup({
      channelId: "tg-ch",
      credentials: { token: "fake" },
      transport,
      attachments: mockAttachmentStore(),
    });

    // Enter /profile new flow
    await handlers.get("command:profile")!({
      ...makeCtx(111, "", 42),
      match: "new coder",
    });

    // Now send plain text — FSM should eat it
    await handlers.get("on:message:text")!(makeCtx(111, "You are a coder", 42));

    expect(transport.emit).not.toHaveBeenCalled();
  });

  it("deliver sends via bot API", async () => {
    const { adapter } = await createAdapter();
    await adapter.deliver("12345", "response");

    expect(mockBotApi.sendMessage).toHaveBeenCalledWith(12345, "response");
  });

  describe("photos", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
      vi.stubGlobal("fetch", mockFetch);
    });

    it("uploads photo to S3 and emits structured content", async () => {
      const { transport } = await createAdapter();
      const ctx = makePhotoCtx(111);
      await handlers.get("on:message:photo")!(ctx);

      // Gets the largest photo (last in array)
      expect(ctx.api.getFile).toHaveBeenCalledWith("large_id");

      // Uploads to S3 via transport
      expect(transport.uploadAttachment).toHaveBeenCalledWith(expect.any(Buffer), "image/jpeg");

      // Emits structured content with image reference
      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "image", path: "inbound/test.jpg", mediaType: "image/jpeg" }],
        expect.any(Date),
      );
    });

    it("includes caption as text block when present", async () => {
      const { transport } = await createAdapter();
      const ctx = makePhotoCtx(111, "Look at this!");
      await handlers.get("on:message:photo")!(ctx);

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "Look at this!" },
          { type: "image", path: "inbound/test.jpg", mediaType: "image/jpeg" },
        ],
        expect.any(Date),
      );
    });
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

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "done", {
        parse_mode: "HTML",
      });
    });

    it("finish falls back to plain text when HTML parse fails", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "done" });
      mockBotApi.editMessageText
        .mockReset()
        .mockRejectedValueOnce(new Error("can't parse entities"))
        .mockResolvedValue(true);

      await handle.finish();

      // First call: HTML attempt, second call would be absent (keeps plain text from stream)
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);
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

  describe("generated images (mid-stream)", () => {
    async function createAdapterWithAttachments() {
      const transport = mockTransport({
        resolveSession: vi.fn().mockResolvedValue({
          id: "session-1",
          channelId: "tg-ch",
          platformAddress: "42",
          conversationId: "conv-1",
          status: "active",
          receive: "routed",
        }),
      });
      const attachments = mockAttachmentStore({
        download: vi.fn().mockResolvedValue(Buffer.from([7, 8, 9])),
      });
      const result = await setup({
        channelId: "tg-ch",
        credentials: { token: "fake" },
        transport,
        attachments,
      });
      return { adapter: result.adapter as unknown as StreamingAdapter, attachments };
    }

    it("sends generated image via sendPhoto on generate_image tool_result", async () => {
      const { adapter, attachments } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: JSON.stringify({
          path: "generated/abc.jpg",
          mediaType: "image/jpeg",
        }),
      });

      expect(attachments.download).toHaveBeenCalledWith("generated/abc.jpg");
      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(1);
      const [chatId, inputFile] = mockBotApi.sendPhoto.mock.calls[0] ?? [];
      expect(chatId).toBe(42);
      const file = inputFile as { data: Buffer; filename: string };
      expect(file.data).toEqual(Buffer.from([7, 8, 9]));
      expect(file.filename).toBe("image.jpg");
    });

    it("dedups generate_image tool_result within the same run", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      const event = {
        type: "tool_result" as const,
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      };
      await handle.push(event);
      await handle.push(event);

      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(1);
    });

    it("retries the image after a failed sendPhoto (dedup only marks success)", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      const event = {
        type: "tool_result" as const,
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      };

      // First attempt: sendPhoto throws — dedup must not block the retry
      mockBotApi.sendPhoto.mockRejectedValueOnce(new Error("network blip"));
      await handle.push(event);
      // Second attempt (e.g., Inngest retry): should succeed
      await handle.push(event);

      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(2);
    });

    it("different runId delivers independently", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle1 = await adapter.openStream("42", "run-1");
      const handle2 = await adapter.openStream("42", "run-2");

      const event = {
        type: "tool_result" as const,
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      };
      await handle1.push(event);
      await handle2.push(event);

      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(2);
    });

    it("skips tool_result with isError=true", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: JSON.stringify({ path: "generated/x.jpg", mediaType: "image/jpeg" }),
        isError: true,
      });

      expect(mockBotApi.sendPhoto).not.toHaveBeenCalled();
    });

    it("ignores tool_result from other tools", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "web_search",
        output: JSON.stringify({ path: "something", mediaType: "image/jpeg" }),
      });

      expect(mockBotApi.sendPhoto).not.toHaveBeenCalled();
    });

    it("handles non-JSON output gracefully", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: "not json",
      });

      expect(mockBotApi.sendPhoto).not.toHaveBeenCalled();
    });

    it("strips the tool_start placeholder from accumulated text after photo delivery", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      // Emit the same sequence the agent loop produces: intro text,
      // tool_start (adds placeholder), tool_result (sends photo),
      // closing text, finish (final edit with HTML render).
      await handle.push({ type: "text_delta", text: "Here's the image." });
      await handle.push({ type: "tool_start", id: "t1", name: "generate_image", input: {} });
      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      });
      await handle.push({ type: "text_delta", text: " Enjoy!" });
      await handle.finish();

      // The final edit must not contain the "🔍 generate_image..." placeholder.
      // (renderTelegramHtml may escape some characters; we only assert the
      // placeholder is gone and the surrounding text is preserved.)
      const lastEdit = mockBotApi.editMessageText.mock.calls.at(-1);
      const editedText = lastEdit?.[2] as string;
      expect(editedText).not.toContain("🔍 generate_image");
      expect(editedText).toContain("the image");
      expect(editedText).toContain("Enjoy");
    });

    it("deliver (batch path) sends images alongside text", async () => {
      const { adapter } = await createAdapter();
      await adapter.deliver("42", {
        text: "here it is",
        parseMode: "HTML",
        images: [
          { data: Buffer.from([1, 2, 3]), mediaType: "image/png" },
          { data: Buffer.from([4, 5, 6]), mediaType: "image/jpeg" },
        ],
      });

      expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "here it is", {
        parse_mode: "HTML",
      });
      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(2);
      const call0 = mockBotApi.sendPhoto.mock.calls[0];
      const call1 = mockBotApi.sendPhoto.mock.calls[1];
      expect((call0?.[1] as { filename: string }).filename).toBe("image.png");
      expect((call1?.[1] as { filename: string }).filename).toBe("image.jpg");
    });
  });
});
