import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_CALLBACK_REGEX } from "../../../agent/coding/permission-keyboard.js";
import { PLAN_CALLBACK_REGEX } from "../../../agent/coding/plan-keyboard.js";
import { SKILLS_APPROVAL_CALLBACK_REGEX } from "../../../skills/skills-keyboard.js";
import { mockAttachmentStore, mockTransport } from "../../../test/factories.js";
import type { StreamingAdapter } from "../../types.js";
import { findTelegramSplitBoundary, rebalanceCodeFence, setup } from "./index.js";

// Mock grammy
const handlers = new Map<string, any>();
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
  editMessageText: vi.fn().mockResolvedValue({}),
  editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
  deleteMessage: vi.fn().mockResolvedValue(true),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: 101 }),
  sendVoice: vi.fn().mockResolvedValue({ message_id: 102 }),
  sendAudio: vi.fn().mockResolvedValue({ message_id: 103 }),
  sendDocument: vi.fn().mockResolvedValue({ message_id: 104 }),
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
    // Real grammY returns a Promise<void> that resolves when bot.stop() is
    // called. The adapter awaits it on stop() to drain — without the
    // Promise return type, `attachPolling` errors with "Cannot read
    // properties of undefined (reading 'catch')".
    start = vi.fn(({ onStart }: any = {}) => {
      onStart?.();
      return Promise.resolve();
    });
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
      boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
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
      boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
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
        // chunk target after the third push. Pre-compute the base time so
        // each iteration sets an absolute, predictable Date.now value
        // (re-reading Date.now inside the loop would compound with the spy
        // installed on the previous iteration).
        const chunk = "x".repeat(1100);
        const t0 = Date.now();
        for (let i = 0; i < 4; i++) {
          vi.spyOn(Date, "now").mockReturnValue(t0 + (i + 1) * 1000);
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

      it("findTelegramSplitBoundary prefers high-quality breaks", () => {
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

      it("rebalanceCodeFence closes an open fence on head and reopens on tail", () => {
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

        // Only HTML-rendered calls represent the finalized state of a chunk.
        // Plain-text edits during streaming carry no `parse_mode` and don't
        // assert anything about formatting — they get replaced by an HTML
        // render at finalize.
        const isHtml = (opts: unknown): boolean =>
          typeof opts === "object" &&
          opts !== null &&
          (opts as { parse_mode?: string }).parse_mode === "HTML";
        const renderedBodies = [
          ...mockBotApi.sendMessage.mock.calls
            .filter((c) => isHtml(c[2]))
            .map((c) => c[1] as string),
          ...mockBotApi.editMessageText.mock.calls
            .filter((c) => isHtml(c[3]))
            .map((c) => c[2] as string),
        ];
        // More than one rendered chunk (we split mid-fence) — proves the
        // rotation actually happened, not just a single oversized message.
        expect(renderedBodies.length).toBeGreaterThan(1);

        for (const b of renderedBodies) {
          if (b.includes("marker_token")) {
            // Body must be inside a <pre> block, not a <p> (which is what
            // marked emits when the continuation lacks an opening fence).
            const preBlock = b.match(/<pre[\s\S]*?<\/pre>/);
            expect(preBlock).not.toBeNull();
            expect(preBlock?.[0]).toContain("marker_token");
          }
          // No literal triple-backticks left over from an unclosed fence.
          expect(b).not.toMatch(/```/);
        }
      });
    });

    describe("append-only mode (allowEdits=false)", () => {
      it("never edits a message mid-stream — sub-chunk pushes accumulate silently", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1", {
          chunkChars: 4000,
          allowEdits: false,
        });

        await handle.push({ type: "text_delta", text: "hello" });
        await handle.push({ type: "text_delta", text: " world" });

        // No send and no edit until either chunk boundary or finish.
        expect(mockBotApi.sendMessage).not.toHaveBeenCalled();
        expect(mockBotApi.editMessageText).not.toHaveBeenCalled();

        await handle.finish();
        expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "hello world", {
          parse_mode: "HTML",
        });
        expect(mockBotApi.editMessageText).not.toHaveBeenCalled();
      });

      it("drops tool_start and status banners (no in-message hint to leak)", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1", {
          chunkChars: 4000,
          allowEdits: false,
        });

        await handle.push({ type: "text_delta", text: "thinking" });
        await handle.push({
          type: "tool_start",
          id: "t1",
          name: "web_search",
          input: {},
        });
        await handle.push({ type: "status", message: "still here" });
        await handle.push({ type: "text_delta", text: " done" });
        await handle.finish();

        // The banner text must not have made it into the final send body.
        expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "thinking done", {
          parse_mode: "HTML",
        });
      });

      it("kicks the typing heartbeat on first push and clears it on finish", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          const adapter = await createStreamingAdapter();
          const handle = await adapter.openStream("42", "run-1", {
            chunkChars: 4000,
            allowEdits: false,
          });

          await handle.push({ type: "text_delta", text: "x" });
          // Immediate kick on first push.
          expect(mockBotApi.sendChatAction).toHaveBeenCalledWith(42, "typing");
          const initial = mockBotApi.sendChatAction.mock.calls.length;

          // Advance past one refresh interval (3500ms).
          await vi.advanceTimersByTimeAsync(4000);
          expect(mockBotApi.sendChatAction.mock.calls.length).toBeGreaterThan(initial);

          const beforeFinish = mockBotApi.sendChatAction.mock.calls.length;
          await handle.finish();
          // Another interval after finish — no more typing kicks once cleared.
          await vi.advanceTimersByTimeAsync(8000);
          expect(mockBotApi.sendChatAction.mock.calls.length).toBe(beforeFinish);
        } finally {
          vi.useRealTimers();
        }
      });

      it("rotates messages at the per-profile chunk target, not the default 4000", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1", {
          chunkChars: 150,
          allowEdits: false,
        });

        // Two paragraphs, each ~120 chars — together they exceed the 150-char
        // target so the first must rotate before the second lands.
        const para = "a".repeat(120);
        await handle.push({ type: "text_delta", text: `${para}\n\n${para}` });
        await handle.finish();

        // First chunk shipped on overflow, second on finish — two sends, no edits.
        expect(mockBotApi.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(mockBotApi.editMessageText).not.toHaveBeenCalled();
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
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
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

  // Inline-keyboard callbackQuery handlers are wired in setup() with three
  // regexes (plan / permission / skills approval). The pure handler logic
  // lives in commands.ts and is tested there; this block exercises the
  // adapter-side wiring — does the registered handler dispatch to the right
  // transport call, edit the original message, send the toast, and (where
  // applicable) reply with the follow-up? A regex shape or parse* signature
  // drift would silently brick the buttons without this coverage.
  describe("callback query dispatch", () => {
    // Pinned UUIDs for callback data — must match the regex shape.
    const TASK_ID = "00000000-0000-0000-0000-000000000001";
    const PENDING_ID = "00000000-0000-0000-0000-000000000002";
    const REQUEST_ID_SHORT = "abc123";

    function makeCallbackCtx(data: string, fromId = 111) {
      return {
        from: { id: fromId },
        callbackQuery: { data },
        editMessageText: vi.fn().mockResolvedValue({}),
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        reply: vi.fn().mockResolvedValue({}),
      };
    }

    it("plan: approve → coding.approvePlan, editMessageText clears keyboard, answers toast", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`plan:${TASK_ID}:approve`);

      const handler = handlers.get(`callbackQuery:${PLAN_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.coding.approvePlan).toHaveBeenCalledWith(TASK_ID, "111");
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("Plan approved"), {
        reply_markup: { inline_keyboard: [] },
      });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved" });
    });

    it("plan: revise → cancelTask + ctx.reply with the follow-up prompt", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`plan:${TASK_ID}:revise`);

      const handler = handlers.get(`callbackQuery:${PLAN_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.coding.cancelTask).toHaveBeenCalledWith(
        TASK_ID,
        "111",
        "user requested revisions",
      );
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("what you'd like changed"));
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Revising" });
    });

    it("plan: editMessageText 'message is not modified' is swallowed (idempotent re-tap)", async () => {
      // A user double-tapping or Inngest replaying the callback hits the
      // same message with the same body — Telegram returns 400 "message is
      // not modified". The handler must not rethrow.
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`plan:${TASK_ID}:approve`);
      ctx.editMessageText = vi.fn().mockRejectedValueOnce(new Error("message is not modified"));

      const handler = handlers.get(`callbackQuery:${PLAN_CALLBACK_REGEX.source}`);
      await expect(handler(ctx)).resolves.not.toThrow();

      expect(transport.coding.approvePlan).toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved" });
    });

    it("permission: deny → respondPermission with decision=deny, scope=once", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`perm:${TASK_ID}:${REQUEST_ID_SHORT}:d`);

      const handler = handlers.get(`callbackQuery:${PERMISSION_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.coding.respondPermission).toHaveBeenCalledWith(
        {
          taskId: TASK_ID,
          requestIdShort: REQUEST_ID_SHORT,
          decision: "deny",
          scope: "once",
        },
        "111",
      );
      expect(ctx.editMessageText).toHaveBeenCalledWith("❌ Denied.", {
        reply_markup: { inline_keyboard: [] },
      });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Denied" });
    });

    it("permission: allow_task → respondPermission with decision=allow, scope=task", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`perm:${TASK_ID}:${REQUEST_ID_SHORT}:t`);

      const handler = handlers.get(`callbackQuery:${PERMISSION_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.coding.respondPermission).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "allow", scope: "task" }),
        "111",
      );
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Allowed for task" });
    });

    it("skill approval: approve → skills.approveDeploy, edit shows skill name + git sha", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`skill:${PENDING_ID}:approve`);

      const handler = handlers.get(`callbackQuery:${SKILLS_APPROVAL_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.skills.approveDeploy).toHaveBeenCalledWith(PENDING_ID, "111");
      const editArgs = ctx.editMessageText.mock.calls[0];
      expect(editArgs?.[0]).toContain("echo"); // skillName from mock
      expect(editArgs?.[0]).toContain("abc1234"); // gitSha from mock
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved" });
    });

    it("skill approval: deny → skills.denyDeploy", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`skill:${PENDING_ID}:deny`);

      const handler = handlers.get(`callbackQuery:${SKILLS_APPROVAL_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.skills.denyDeploy).toHaveBeenCalledWith(PENDING_ID, "111");
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Denied" });
    });

    it("missing callbackQuery.data exits early without dispatching", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`plan:${TASK_ID}:approve`);
      // Force the early-exit path by clearing data after the regex match.
      ctx.callbackQuery = { data: "" };

      const handler = handlers.get(`callbackQuery:${PLAN_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.coding.approvePlan).not.toHaveBeenCalled();
    });
  });

  // The text-message path's branches around session resolution: identity
  // rejection on createConversation and emit-failure on transport.emit. Both
  // are silent error paths today (info or error log, no user-visible reply);
  // a regression that turns either into an exception would crash the bot's
  // event loop.
  describe("identity rejection + emit failure (text path)", () => {
    it("createConversation → identity_rejected: emit not called, no throw", async () => {
      const { transport } = await createAdapter({
        resolveSession: vi.fn().mockResolvedValue(null),
        createConversation: vi
          .fn()
          .mockResolvedValue(err({ code: "identity_rejected" as const, handle: "111" })),
      });

      await expect(
        handlers.get("on:message:text")(makeCtx(111, "hi from stranger", 42)),
      ).resolves.not.toThrow();

      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("createConversation → non-identity error: emit not called, no throw", async () => {
      const { transport } = await createAdapter({
        resolveSession: vi.fn().mockResolvedValue(null),
        createConversation: vi.fn().mockResolvedValue(err({ code: "channel_not_found" as const })),
      });

      await expect(handlers.get("on:message:text")(makeCtx(111, "hi", 42))).resolves.not.toThrow();

      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("transport.emit → error: handler logs and returns without throwing", async () => {
      // emit returning err is the "couldn't enqueue the inbound event" case.
      // The bot must not crash — the next message gets its own chance.
      const { transport } = await createAdapter({
        emit: vi.fn().mockResolvedValue(err({ code: "session_not_found" as const })),
      });

      await expect(
        handlers.get("on:message:text")(makeCtx(111, "test", 42)),
      ).resolves.not.toThrow();

      expect(transport.emit).toHaveBeenCalledOnce();
    });
  });

  // deliver() (the non-streaming batch send path) has its own try/catch that
  // mirrors finish()'s HTML-parse fallback. Streaming already has a test
  // ("finish falls back to plain text when HTML parse fails"); this covers
  // the non-stream code path used by tool-result documents, voice fallbacks,
  // and any direct deliver() caller.
  describe("deliver HTML parse fallback", () => {
    it("retries with stripped tags when sendMessage throws 'can't parse entities'", async () => {
      const { adapter } = await createAdapter();
      mockBotApi.sendMessage
        .mockRejectedValueOnce(new Error("can't parse entities at byte offset 17"))
        .mockResolvedValueOnce({ message_id: 200 });

      await adapter.deliver("42", {
        text: "<b>bold</b> and <broken",
        parseMode: "HTML",
      });

      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(2);
      const first = mockBotApi.sendMessage.mock.calls[0];
      const second = mockBotApi.sendMessage.mock.calls[1];
      // First call: HTML attempt with parse_mode
      expect(first?.[2]).toEqual({ parse_mode: "HTML" });
      // Second call: stripped, no parse_mode option
      expect(second?.[1]).not.toContain("<b>");
      expect(second?.[1]).toContain("bold");
      expect(second?.[2]).toBeUndefined();
    });

    it("rethrows unrelated sendMessage errors (no silent swallow)", async () => {
      const { adapter } = await createAdapter();
      mockBotApi.sendMessage.mockRejectedValueOnce(new Error("403 Forbidden: bot was blocked"));

      await expect(adapter.deliver("42", { text: "anything", parseMode: "HTML" })).rejects.toThrow(
        "403 Forbidden",
      );
      // Did NOT fall through to a second attempt — the fallback is HTML-specific.
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // Generated-document delivery via the streaming handle's `send_document`
  // tool_result path — mirrors the generated-image tests but exercises the
  // sendDocument code path that was uncovered.
  describe("generated documents (mid-stream)", () => {
    async function createAdapterWithAttachments(downloadImpl?: typeof Buffer.from) {
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
        download: vi
          .fn()
          .mockResolvedValue(downloadImpl ? downloadImpl([1, 2, 3]) : Buffer.from([1, 2, 3])),
      });
      const result = await setup({
        channelId: "tg-ch",
        credentials: { token: "fake" },
        transport,
        attachments,
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
      });
      return { adapter: result.adapter as unknown as StreamingAdapter, attachments };
    }

    it("sends generated document via sendDocument with the provided filename", async () => {
      const { adapter, attachments } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({
          path: "generated/report.pdf",
          mediaType: "application/pdf",
          name: "report.pdf",
        }),
      });

      expect(attachments.download).toHaveBeenCalledWith("generated/report.pdf");
      expect(mockBotApi.sendDocument).toHaveBeenCalledTimes(1);
      const [chatId, inputFile] = mockBotApi.sendDocument.mock.calls[0] ?? [];
      expect(chatId).toBe(42);
      const file = inputFile as { data: Buffer; filename: string };
      expect(file.data).toEqual(Buffer.from([1, 2, 3]));
      // The filename surfaces in Telegram's UI — must match what the LLM picked.
      expect(file.filename).toBe("report.pdf");
    });

    it("dedups send_document tool_result within the same run", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");
      const event = {
        type: "tool_result" as const,
        name: "send_document",
        output: JSON.stringify({
          path: "generated/x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
      };
      await handle.push(event);
      await handle.push(event);

      expect(mockBotApi.sendDocument).toHaveBeenCalledTimes(1);
    });

    it("retries the document after a failed sendDocument (dedup only marks success)", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");
      const event = {
        type: "tool_result" as const,
        name: "send_document",
        output: JSON.stringify({
          path: "generated/x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
      };

      mockBotApi.sendDocument.mockRejectedValueOnce(new Error("network blip"));
      await handle.push(event);
      await handle.push(event);

      expect(mockBotApi.sendDocument).toHaveBeenCalledTimes(2);
    });

    it("skips when payload is malformed (missing fields → parser returns null)", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      // Missing `name` — parser rejects.
      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({ path: "p", mediaType: "application/pdf" }),
      });
      // Not JSON at all.
      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: "not json",
      });

      expect(mockBotApi.sendDocument).not.toHaveBeenCalled();
    });

    it("skips tool_result with isError=true", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({
          path: "x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
        isError: true,
      });

      expect(mockBotApi.sendDocument).not.toHaveBeenCalled();
    });

    it("strips the send_document placeholder from accumulated text after delivery", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Here's your file." });
      await handle.push({ type: "tool_start", id: "t1", name: "send_document", input: {} });
      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({
          path: "generated/x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
      });
      await handle.push({ type: "text_delta", text: " Done." });
      await handle.finish();

      const lastEdit = mockBotApi.editMessageText.mock.calls.at(-1);
      const editedText = lastEdit?.[2] as string;
      expect(editedText).not.toContain("🔍 send_document");
      expect(editedText).toContain("your file");
      expect(editedText).toContain("Done");
    });
  });

  describe("boundary hold", () => {
    async function createAdapterWithBoundary(
      boundaryOverrides: Partial<ReturnType<typeof mockTransport>["boundary"]>,
    ) {
      const boundary = {
        peek: vi.fn().mockResolvedValue(null),
        findActive: vi.fn().mockResolvedValue(null),
        start: vi.fn().mockResolvedValue({ boundaryId: "boundary-77" }),
        append: vi.fn().mockResolvedValue(undefined),
        resolve: vi.fn().mockResolvedValue(
          ok({
            sessionId: "session-resolved",
            conversationId: "conv-resolved",
            drainedInboundCount: 1,
            platformAddress: "42",
          }),
        ),
        ...boundaryOverrides,
      };
      // resolveSession returns null so the adapter takes the rotation path.
      const transport = mockTransport({
        resolveSession: vi.fn().mockResolvedValue(null),
        boundary,
        createConversation: vi.fn().mockResolvedValue(
          ok({
            id: "session-fresh",
            channelId: "tg-ch",
            platformAddress: "42",
            conversationId: "conv-fresh",
            status: "active",
            receive: "routed",
            profileName: "assistant",
          }),
        ),
        emit: vi.fn().mockResolvedValue(ok(undefined)),
      });
      await setup({
        channelId: "tg-ch",
        credentials: { token: "fake" },
        transport,
        attachments: mockAttachmentStore(),
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
      });
      return { transport };
    }

    it("fires the boundary prompt when peek finds a substantial prior", async () => {
      const { transport } = await createAdapterWithBoundary({
        peek: vi.fn().mockResolvedValue({
          conversationId: "conv-prior",
          userTurnCount: 5,
          lastMessageAt: new Date("2026-05-19T12:00:00Z"),
          alias: "research notes",
          firstUserSnippet: null,
        }),
      });

      const ctx = makeCtx(111, "hey, are you there?", 42);
      // ctx.reply returns a message_id so the adapter can attach an inline keyboard to it.
      ctx.reply = vi.fn().mockResolvedValue({ message_id: 9001 });

      await handlers.get("on:message:text")!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Pick up where we left off"));
      expect(transport.boundary.start).toHaveBeenCalledWith(
        expect.objectContaining({
          platformAddress: "42",
          platformUserHandle: "111",
          priorConversationId: "conv-prior",
          promptMessageId: "9001",
          firstInbound: expect.objectContaining({ content: "hey, are you there?" }),
          timeoutMs: 30000,
        }),
      );
      expect(mockBotApi.editMessageReplyMarkup).toHaveBeenCalledWith(
        "42",
        9001,
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining("research notes"),
                  callback_data: "boundary:boundary-77:resume",
                }),
                expect.objectContaining({
                  text: "✦ Start fresh",
                  callback_data: "boundary:boundary-77:fresh",
                }),
              ]),
            ]),
          }),
        }),
      );
      // No emit — the inbound is buffered, not persisted yet.
      expect(transport.emit).not.toHaveBeenCalled();
      expect(transport.createConversation).not.toHaveBeenCalled();
    });

    it("appends to the buffer when a hold is already active for this chat", async () => {
      const { transport } = await createAdapterWithBoundary({
        findActive: vi.fn().mockResolvedValue({
          id: "boundary-77",
          channelId: "tg-ch",
          platformAddress: "42",
          platformUserHandle: "111",
          priorConversationId: "conv-prior",
          promptMessageId: "9001",
          bufferedInbounds: [{ content: "hey", platformTs: "2026-05-19T12:00:00.000Z" }],
          expiresAt: new Date(),
          createdAt: new Date(),
        }),
      });

      const ctx = makeCtx(111, "follow-up message", 42);
      await handlers.get("on:message:text")!(ctx);

      expect(transport.boundary.append).toHaveBeenCalledWith(
        "boundary-77",
        expect.objectContaining({ content: "follow-up message" }),
      );
      // No prompt sent — the existing hold takes precedence.
      expect(transport.boundary.start).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("serializes per-chat dispatches so two concurrent inbounds share one prompt", async () => {
      // Two parallel inbounds on the same chat MUST NOT both fireBoundaryPrompt:
      // the per-chat mutex makes the second observe the first's hold via
      // findActive and append instead of starting a second hold.
      let holdActive = false;
      const startMock = vi.fn().mockImplementation(async () => {
        holdActive = true;
        return { boundaryId: "boundary-77" };
      });
      const findActiveMock = vi.fn().mockImplementation(async () =>
        holdActive
          ? {
              id: "boundary-77",
              channelId: "tg-ch",
              platformAddress: "42",
              platformUserHandle: "111",
              priorConversationId: "conv-prior",
              promptMessageId: "9001",
              bufferedInbounds: [],
              expiresAt: new Date(),
              createdAt: new Date(),
            }
          : null,
      );
      const appendMock = vi.fn().mockResolvedValue(undefined);
      const { transport } = await createAdapterWithBoundary({
        peek: vi.fn().mockResolvedValue({
          conversationId: "conv-prior",
          userTurnCount: 4,
          lastMessageAt: new Date(),
          alias: null,
          firstUserSnippet: "hi",
        }),
        findActive: findActiveMock,
        start: startMock,
        append: appendMock,
      });

      const ctx1 = makeCtx(111, "first", 42);
      ctx1.reply = vi.fn().mockResolvedValue({ message_id: 9001 });
      const ctx2 = makeCtx(111, "second", 42);
      ctx2.reply = vi.fn().mockResolvedValue({ message_id: 9002 });

      const handler = handlers.get("on:message:text")!;
      await Promise.all([handler(ctx1), handler(ctx2)]);

      // Only the first dispatch fired a prompt — the second observed the
      // hold and appended.
      expect(startMock).toHaveBeenCalledTimes(1);
      expect(appendMock).toHaveBeenCalledTimes(1);
      expect(appendMock).toHaveBeenCalledWith(
        "boundary-77",
        expect.objectContaining({ content: "second" }),
      );
      // Only the first reply was sent.
      expect(ctx1.reply).toHaveBeenCalledTimes(1);
      expect(ctx2.reply).not.toHaveBeenCalled();
      // Sanity: transport.emit was never called (both buffered).
      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("deletes the dangling prompt when boundary.start throws after the reply was sent", async () => {
      // Regression: if start fails (DB blip, UNIQUE race) AFTER ctx.reply
      // succeeded, the user is left looking at a button-less "Pick up where
      // we left off?" message. The adapter must best-effort delete the
      // orphan so the createConversation fallback's reply isn't preceded by
      // dangling boundary chrome.
      const startMock = vi.fn().mockRejectedValue(new Error("simulated DB error"));
      const { transport } = await createAdapterWithBoundary({
        peek: vi.fn().mockResolvedValue({
          conversationId: "conv-prior",
          userTurnCount: 5,
          lastMessageAt: new Date(),
          alias: null,
          firstUserSnippet: "hi",
        }),
        start: startMock,
      });

      const ctx = makeCtx(111, "hey", 42);
      ctx.reply = vi.fn().mockResolvedValue({ message_id: 9001 });
      await handlers.get("on:message:text")!(ctx);

      expect(startMock).toHaveBeenCalledTimes(1);
      // Dangling prompt cleanup: deleteMessage called on the just-sent reply.
      expect(mockBotApi.deleteMessage).toHaveBeenCalledWith("42", 9001);
      // Fell through to createConversation + emit (no boundary hold).
      expect(transport.createConversation).toHaveBeenCalled();
      expect(transport.emit).toHaveBeenCalled();
    });

    it("falls through to createConversation when peek returns null (one-shot prior)", async () => {
      const { transport } = await createAdapterWithBoundary({
        peek: vi.fn().mockResolvedValue(null),
      });

      const ctx = makeCtx(111, "first contact", 42);
      await handlers.get("on:message:text")!(ctx);

      expect(transport.boundary.start).not.toHaveBeenCalled();
      expect(transport.createConversation).toHaveBeenCalled();
      expect(transport.emit).toHaveBeenCalledWith(
        "session-fresh",
        "first contact",
        expect.any(Date),
      );
    });

    it("resume callback invokes boundary.resolve with resume-prior and clears the keyboard", async () => {
      const { transport } = await createAdapterWithBoundary({});
      const callbackHandler = handlers.get(
        "callbackQuery:^boundary:([0-9a-f-]{36}):(resume|fresh)$",
      )!;
      const ctx = {
        match: [
          "boundary:abcdef01-1234-7000-8000-000000000001:resume",
          "abcdef01-1234-7000-8000-000000000001",
          "resume",
        ],
        editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandler(ctx);

      expect(transport.boundary.resolve).toHaveBeenCalledWith({
        boundaryId: "abcdef01-1234-7000-8000-000000000001",
        choice: { kind: "resume-prior" },
        reason: "user_resume",
      });
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
        reply_markup: { inline_keyboard: [] },
      });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: expect.stringContaining("Picking up"),
      });
    });

    it("fresh callback invokes boundary.resolve with fresh", async () => {
      const { transport } = await createAdapterWithBoundary({});
      const callbackHandler = handlers.get(
        "callbackQuery:^boundary:([0-9a-f-]{36}):(resume|fresh)$",
      )!;
      const ctx = {
        match: [
          "boundary:abcdef01-1234-7000-8000-000000000001:fresh",
          "abcdef01-1234-7000-8000-000000000001",
          "fresh",
        ],
        editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandler(ctx);

      expect(transport.boundary.resolve).toHaveBeenCalledWith({
        boundaryId: "abcdef01-1234-7000-8000-000000000001",
        choice: { kind: "fresh" },
        reason: "user_fresh",
      });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: expect.stringContaining("Starting fresh"),
      });
    });

    it("callback handler surfaces 'Already resolved' when the hold is gone", async () => {
      await createAdapterWithBoundary({
        resolve: vi.fn().mockResolvedValue(err({ code: "boundary_not_found" })),
      });
      const callbackHandler = handlers.get(
        "callbackQuery:^boundary:([0-9a-f-]{36}):(resume|fresh)$",
      )!;
      const ctx = {
        match: [
          "boundary:abcdef01-1234-7000-8000-000000000001:fresh",
          "abcdef01-1234-7000-8000-000000000001",
          "fresh",
        ],
        editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandler(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: "Already resolved",
      });
    });
  });
});
