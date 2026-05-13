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
  sendVoice: vi.fn().mockResolvedValue({ message_id: 102 }),
  sendAudio: vi.fn().mockResolvedValue({ message_id: 103 }),
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

function makeVoiceCtx(
  fromId: number,
  voice: { file_id?: string; duration?: number; mime_type?: string } = {},
  caption?: string,
  chatId = 42,
) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: {
      date: 1700000000,
      caption,
      voice: {
        file_id: voice.file_id ?? "voice_id",
        duration: voice.duration ?? 5,
        ...(voice.mime_type !== undefined && { mime_type: voice.mime_type }),
      },
    },
    api: {
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: "voice/file_1.ogg" }),
    },
  };
}

function makeDocumentCtx(
  fromId: number,
  doc: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
  } = {},
  caption?: string,
  chatId = 42,
) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: {
      date: 1700000000,
      caption,
      document: {
        file_id: doc.file_id ?? "doc_id",
        ...(doc.file_name !== undefined && { file_name: doc.file_name }),
        ...(doc.mime_type !== undefined && { mime_type: doc.mime_type }),
      },
    },
    api: {
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/file_1" }),
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
          profileName: "assistant",
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
    const firstCall = mockBotApi.setMyCommands.mock.calls[0];
    if (!firstCall) throw new Error("expected setMyCommands to have been called");
    const [commands] = firstCall;
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
    // handleNew now surfaces the profile actually used in the reply; the
    // mocked createConversation default returns profileName "assistant".
    expect(ctx.reply.mock.calls[0]?.[0]).toBe('New conversation started with profile "assistant".');
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
        setClass: vi.fn().mockResolvedValue(ok(undefined)),
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
        ok: true,
        status: 200,
        statusText: "OK",
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

    it("does not upload or emit when getFile returns no file_path", async () => {
      const { transport } = await createAdapter();
      const ctx = makePhotoCtx(111);
      ctx.api.getFile = vi.fn().mockResolvedValue({ file_path: undefined });

      await handlers.get("on:message:photo")!(ctx);

      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("does not upload or emit on a non-OK fetch response", async () => {
      const { transport } = await createAdapter();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        arrayBuffer: async () => new Uint8Array().buffer,
      });
      const ctx = makePhotoCtx(111);

      await handlers.get("on:message:photo")!(ctx);

      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });
  });

  describe("voice messages", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer,
      });
      vi.stubGlobal("fetch", mockFetch);
    });

    it("uploads OGG and emits a voice inbound block with durationMs", async () => {
      const { transport } = await createAdapter();
      const ctx = makeVoiceCtx(111, { file_id: "v_id", duration: 5 });
      await handlers.get("on:message:voice")!(ctx);

      expect(ctx.api.getFile).toHaveBeenCalledWith("v_id");
      // Telegram voice clips are always OGG/Opus regardless of mime_type field.
      expect(transport.uploadAttachment).toHaveBeenCalledWith(expect.any(Buffer), "audio/ogg");
      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          {
            type: "voice",
            path: "inbound/test.jpg",
            mediaType: "audio/ogg",
            durationMs: 5000,
          },
        ],
        expect.any(Date),
      );
    });

    it("includes caption alongside the voice block", async () => {
      const { transport } = await createAdapter();
      const ctx = makeVoiceCtx(111, { duration: 3 }, "listen up");
      await handlers.get("on:message:voice")!(ctx);

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "listen up" },
          {
            type: "voice",
            path: "inbound/test.jpg",
            mediaType: "audio/ogg",
            durationMs: 3000,
          },
        ],
        expect.any(Date),
      );
    });

    it("does not upload or emit on missing file_path (>20MB Telegram cap)", async () => {
      const { transport } = await createAdapter();
      const ctx = makeVoiceCtx(111);
      ctx.api.getFile = vi.fn().mockResolvedValue({ file_path: undefined });

      await handlers.get("on:message:voice")!(ctx);

      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("does not upload or emit on a non-OK fetch", async () => {
      const { transport } = await createAdapter();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        arrayBuffer: async () => new Uint8Array().buffer,
      });
      const ctx = makeVoiceCtx(111);

      await handlers.get("on:message:voice")!(ctx);

      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("does NOT register a message:audio handler (music files would burn STT tokens)", async () => {
      // Slice 1 deliberately omits the audio handler — see the comment in
      // src/transport/adapters/telegram/index.ts above bot.on("message:voice").
      // Voice notes only.
      await createAdapter();
      expect(handlers.has("on:message:audio")).toBe(false);
    });
  });

  describe("documents", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
      vi.stubGlobal("fetch", mockFetch);
    });

    it("uploads a PDF document and emits a document inbound block", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, {
        file_id: "pdf_id",
        file_name: "report.pdf",
        mime_type: "application/pdf",
      });
      await handlers.get("on:message:document")!(ctx);

      expect(ctx.api.getFile).toHaveBeenCalledWith("pdf_id");
      expect(transport.uploadAttachment).toHaveBeenCalledWith(
        expect.any(Buffer),
        "application/pdf",
      );
      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          {
            type: "document",
            path: "inbound/test.jpg",
            mediaType: "application/pdf",
            name: "report.pdf",
          },
        ],
        expect.any(Date),
      );
    });

    it("includes caption as text block when present", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(
        111,
        { file_name: "x.txt", mime_type: "text/plain" },
        "see attached",
      );
      await handlers.get("on:message:document")!(ctx);

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "see attached" },
          {
            type: "document",
            path: "inbound/test.jpg",
            mediaType: "text/plain",
            name: "x.txt",
          },
        ],
        expect.any(Date),
      );
    });

    it("falls back to application/octet-stream when mime_type is missing", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, { file_name: "blob.bin" });
      await handlers.get("on:message:document")!(ctx);

      expect(transport.uploadAttachment).toHaveBeenCalledWith(
        expect.any(Buffer),
        "application/octet-stream",
      );
      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          {
            type: "document",
            path: "inbound/test.jpg",
            mediaType: "application/octet-stream",
            name: "blob.bin",
          },
        ],
        expect.any(Date),
      );
    });

    it("omits name field when document has no filename", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, { mime_type: "application/pdf" });
      await handlers.get("on:message:document")!(ctx);

      const emitArgs = (transport.emit as any).mock.calls[0][1];
      const docBlock = emitArgs.find((b: { type: string }) => b.type === "document");
      expect(docBlock).not.toHaveProperty("name");
    });

    // Telegram's "Send as file" path delivers images (PNG, full-res JPEG,
    // WEBP, etc.) through message:document instead of message:photo. The
    // adapter must route image/* MIME types to the image inbound block so
    // the LLM's vision pipeline picks them up — Anthropic's `document`
    // block doesn't accept image media types and would 400-fail.
    it("routes image/png 'send as file' uploads to an image inbound block", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, {
        file_id: "png_id",
        file_name: "photo.png",
        mime_type: "image/png",
      });
      await handlers.get("on:message:document")!(ctx);

      expect(transport.uploadAttachment).toHaveBeenCalledWith(expect.any(Buffer), "image/png");
      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "image", path: "inbound/test.jpg", mediaType: "image/png" }],
        expect.any(Date),
      );
    });

    it("routes image/jpeg 'send as file' uploads to an image inbound block", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, {
        file_id: "jpg_id",
        file_name: "photo.jpg",
        mime_type: "image/jpeg",
      });
      await handlers.get("on:message:document")!(ctx);

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "image", path: "inbound/test.jpg", mediaType: "image/jpeg" }],
        expect.any(Date),
      );
    });

    it("preserves caption alongside an image-as-file upload", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(
        111,
        { mime_type: "image/webp", file_name: "x.webp" },
        "what's this?",
      );
      await handlers.get("on:message:document")!(ctx);

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "what's this?" },
          { type: "image", path: "inbound/test.jpg", mediaType: "image/webp" },
        ],
        expect.any(Date),
      );
    });

    // The Telegram Bot API can return file_path: undefined for files >20MB
    // and for some media types. Without a guard the URL becomes
    // `.../bot<token>/undefined`, fetch returns a 404 HTML page, and we'd
    // upload that HTML as the user's "document".
    it("does not upload or emit when getFile returns no file_path", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, { mime_type: "application/pdf", file_name: "huge.pdf" });
      ctx.api.getFile = vi.fn().mockResolvedValue({ file_path: undefined });

      await handlers.get("on:message:document")!(ctx);

      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });

    // Telegram's CDN can return 4xx/5xx (rate-limit, expired file_id,
    // outage). arrayBuffer() succeeds anyway and would otherwise let us
    // upload the error body as if it were the user's file.
    it("does not upload or emit on a non-OK fetch response", async () => {
      const { transport } = await createAdapter();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        arrayBuffer: async () => new Uint8Array().buffer,
      });
      const ctx = makeDocumentCtx(111, { mime_type: "application/pdf", file_name: "x.pdf" });

      await handlers.get("on:message:document")!(ctx);

      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
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

    describe("4096-char overflow", () => {
      // Reproduces the prod MESSAGE_TOO_LONG class of failure: cumulative
      // streaming edits crossed Telegram's per-message char cap, every edit
      // after that point 400'd, and the conversation was marked errored.
      // The fix rotates to a fresh message before the cap; the assertions
      // here guard that every call to send/edit fits inside the cap.

      const TELEGRAM_CAP = 4096;

      it("a single push larger than the cap splits into multiple messages", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1");

        mockBotApi.sendMessage.mockClear();
        mockBotApi.editMessageText.mockClear();
        // Each paragraph is ~1100 chars; eight of them = ~8800 chars (>2x cap).
        // Paragraph boundaries are natural split points the boundary finder
        // should prefer.
        const para = `${"x".repeat(1100)}`;
        const big = Array(8).fill(para).join("\n\n");
        await handle.push({ type: "text_delta", text: big });
        await handle.finish();

        const sendCalls = mockBotApi.sendMessage.mock.calls;
        const editCalls = mockBotApi.editMessageText.mock.calls;
        // Multiple physical messages, not one 8800-char edit.
        expect(sendCalls.length + editCalls.length).toBeGreaterThan(1);
        for (const [, body] of sendCalls) {
          expect(typeof body).toBe("string");
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
        for (const [, , body] of editCalls) {
          expect(typeof body).toBe("string");
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
      });

      it("cumulative pushes that cross the cap rotate to a new message", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1");

        mockBotApi.sendMessage.mockClear();
        // Two messages so the test can observe the rotation: send first, then
        // a fresh sendMessage after the cap is crossed (with a different id).
        mockBotApi.sendMessage
          .mockResolvedValueOnce({ message_id: 100 })
          .mockResolvedValue({ message_id: 200 });
        mockBotApi.editMessageText.mockClear();

        // 4 chunks × 1100 chars = 4400 chars total, crosses the 4000-char
        // chunk target after the third push.
        const chunk = "x".repeat(1100);
        for (let i = 0; i < 4; i++) {
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
          await handle.push({ type: "text_delta", text: chunk });
        }
        await handle.finish();

        // At least one sendMessage after the original (a rotation happened),
        // and every payload fits the cap.
        expect(mockBotApi.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const [, body] of mockBotApi.sendMessage.mock.calls) {
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
        for (const [, , body] of mockBotApi.editMessageText.mock.calls) {
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
      });

      it("findTelegramSplitBoundary prefers high-quality breaks", async () => {
        const { findTelegramSplitBoundary } = await import("./index.js");
        // Paragraph break wins over later line breaks / spaces.
        const a = `${"a".repeat(2000)}\n\n${"b".repeat(1000)}\n${"c".repeat(1000)}`;
        expect(findTelegramSplitBoundary(a, 3500)).toBe(2002);

        // No paragraph break — falls through to single line break.
        const b = `${"a".repeat(2000)}\n${"b".repeat(2500)}`;
        expect(findTelegramSplitBoundary(b, 3500)).toBe(2001);

        // No newline — sentence boundary.
        const c = `${"a".repeat(1500)}. ${"b".repeat(2500)}`;
        expect(findTelegramSplitBoundary(c, 3500)).toBe(1502);

        // No natural break in the acceptable window → hard split at target.
        const d = "x".repeat(5000);
        expect(findTelegramSplitBoundary(d, 3500)).toBe(3500);

        // Text shorter than target — no split.
        expect(findTelegramSplitBoundary("short", 3500)).toBe(5);

        // Hard split must not land between halves of a surrogate pair —
        // 😀 (U+1F600) is two UTF-16 code units. Cutting at `target` would
        // split it; the helper backs off by one to keep the pair intact.
        const emoji = "😀"; // length 2 in UTF-16
        const e = "x".repeat(99) + emoji + "y".repeat(100);
        // No natural breaks → hard split. target=100 falls on the high
        // surrogate (index 99); helper returns 99 instead.
        expect(findTelegramSplitBoundary(e, 100)).toBe(99);
      });

      it("rebalanceCodeFence closes an open fence on head and reopens on tail", async () => {
        const { rebalanceCodeFence } = await import("./index.js");

        // Split lands inside an open fenced block: close + reopen with lang.
        const head = "Here is the code:\n\n```python\ndef foo():\n  return 1";
        const tail = "\nx = foo()\n```\nDone.";
        const out = rebalanceCodeFence(head, tail);
        expect(out.head).toBe(`${head}\n\`\`\``);
        expect(out.tail).toBe(`\`\`\`python\n${tail}`);

        // Already balanced — passthrough.
        const balancedHead = "Code:\n\n```\nx\n```\n\nMore prose.";
        const balancedTail = "Next paragraph.";
        expect(rebalanceCodeFence(balancedHead, balancedTail)).toEqual({
          head: balancedHead,
          tail: balancedTail,
        });

        // No code in head at all — passthrough.
        expect(rebalanceCodeFence("just text", " more")).toEqual({
          head: "just text",
          tail: " more",
        });

        // Fence without a language tag — reopen as bare ```.
        const noLangHead = "```\nplain code\nmore";
        expect(rebalanceCodeFence(noLangHead, "\nstill code").tail).toBe("```\n\nstill code");
      });

      it("a long code block split mid-fence renders every chunk inside <pre>", async () => {
        // The bug without rebalancing: head ends inside an open fence; tail
        // starts with raw body text (no opening fence). marked auto-closes
        // the head's fence at EOF (so head looks fine), but the tail renders
        // the continuation as paragraph text — code shows as plain prose
        // with no monospace formatting, and the trailing ``` becomes literal
        // backticks. Rebalancing restores the fence on the tail.
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1");

        mockBotApi.sendMessage.mockClear();
        mockBotApi.editMessageText.mockClear();
        mockBotApi.sendMessage
          .mockResolvedValueOnce({ message_id: 100 })
          .mockResolvedValue({ message_id: 200 });

        // Distinctive body content lets us locate the code in the rendered
        // output. 5000+ chars guarantees at least one mid-fence split.
        const body = "marker_token\n".repeat(400);
        await handle.push({
          type: "text_delta",
          text: `Output:\n\n\`\`\`python\n${body}\`\`\``,
        });
        await handle.finish();

        const allBodies = [
          ...mockBotApi.sendMessage.mock.calls.map((c) => c[1] as string),
          ...mockBotApi.editMessageText.mock.calls.map((c) => c[2] as string),
        ];
        expect(allBodies.length).toBeGreaterThan(1);

        // Every chunk that contains body content must have it inside <pre> —
        // not in a <p> (which is what marked emits when the continuation
        // lacks an opening fence). And no chunk leaks raw triple-backticks.
        for (const b of allBodies) {
          if (b.includes("marker_token")) {
            // Body must be inside a <pre> block, not a <p>.
            const preBlock = b.match(/<pre[\s\S]*?<\/pre>/);
            expect(preBlock).not.toBeNull();
            expect(preBlock?.[0]).toContain("marker_token");
          }
          // No literal triple-backticks left over from an unclosed fence.
          expect(b).not.toMatch(/```/);
        }
      });
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

  describe("sendVoice", () => {
    it("delivers OGG via Telegram's sendVoice (voice-bubble UI)", async () => {
      const { adapter } = await createAdapter();
      const adapterAny = adapter as unknown as {
        sendVoice: (addr: string, audio: { audio: Buffer; mediaType: string }) => Promise<void>;
      };
      const audio = { audio: Buffer.from([1, 2, 3]), mediaType: "audio/ogg" };

      await adapterAny.sendVoice("42", audio);

      expect(mockBotApi.sendVoice).toHaveBeenCalledTimes(1);
      const [chatId, file] = mockBotApi.sendVoice.mock.calls[0]!;
      expect(chatId).toBe(42);
      expect((file as { filename: string }).filename).toBe("voice.ogg");
      expect((file as { data: Buffer }).data).toEqual(audio.audio);
      expect(mockBotApi.sendAudio).not.toHaveBeenCalled();
    });

    it("treats audio/opus the same as audio/ogg", async () => {
      const { adapter } = await createAdapter();
      const adapterAny = adapter as unknown as {
        sendVoice: (addr: string, audio: { audio: Buffer; mediaType: string }) => Promise<void>;
      };
      await adapterAny.sendVoice("42", {
        audio: Buffer.from([]),
        mediaType: "audio/opus",
      });
      expect(mockBotApi.sendVoice).toHaveBeenCalledTimes(1);
      expect(mockBotApi.sendAudio).not.toHaveBeenCalled();
    });

    it("falls back to sendAudio for non-Opus formats (e.g. MP3)", async () => {
      const { adapter } = await createAdapter();
      const adapterAny = adapter as unknown as {
        sendVoice: (addr: string, audio: { audio: Buffer; mediaType: string }) => Promise<void>;
      };
      await adapterAny.sendVoice("42", {
        audio: Buffer.from([0xff, 0xfb]),
        mediaType: "audio/mpeg",
      });
      expect(mockBotApi.sendAudio).toHaveBeenCalledTimes(1);
      expect(mockBotApi.sendVoice).not.toHaveBeenCalled();
    });
  });
});
