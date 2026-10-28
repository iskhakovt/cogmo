import { ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_INBOUND_FILE_BYTES } from "../../../agent/conversation/inbound-content.js";
import { logger } from "../../../logger.js";
import { expectDefined } from "../../../test/assertions.js";
import { mockAttachmentStore, mockInngest, mockTransport } from "../../../test/factories.js";
import { handlers, resetGrammyMock } from "../../../test/telegram/grammy-mock.js";
import {
  createAdapter,
  makeCtx,
  makeDocumentCtx,
  makePhotoCtx,
  makeVoiceCtx,
} from "../../../test/telegram/harness.js";
import { setup } from "./index.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

const { GrammyError } = await vi.importActual<typeof import("grammy")>("grammy");

/** The Bot API's answer to a `getFile` call, as grammY throws it. */
function getFileRefusal(description: string): InstanceType<typeof GrammyError> {
  return new GrammyError(
    `Call to 'getFile' failed! (400: ${description})`,
    { ok: false, error_code: 400, description },
    "getFile",
    {},
  );
}

describe("registerMessageHandlers", () => {
  beforeEach(() => {
    resetGrammyMock();
  });

  it("emits via transport on text message", async () => {
    const { transport } = await createAdapter();
    await handlers.get("on:message:text")!(makeCtx(111, "test message", 42));

    expect(transport.emit).toHaveBeenCalledWith("session-1", "test message", expect.any(Date));
  });

  it("sends typing indicator", async () => {
    await createAdapter();
    const ctx = makeCtx(111);
    await handlers.get("on:message:text")!(ctx);

    expect(ctx.api.sendChatAction).toHaveBeenCalledWith(42, "typing");
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
      inngest: mockInngest(),
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

    it("downloads from Telegram's file endpoint by default", async () => {
      await createAdapter();
      await handlers.get("on:message:photo")!(makePhotoCtx(111));

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/file/botfake/photos/file_1.jpg",
      );
    });

    it("downloads from the self-hosted Bot API server when the channel names one", async () => {
      await setup({
        channelId: "tg-ch",
        credentials: { token: "fake", apiRoot: "http://bot-api.local:8081" },
        transport: mockTransport(),
        attachments: mockAttachmentStore(),
        inngest: mockInngest(),
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
      });
      await handlers.get("on:message:photo")!(makePhotoCtx(111));

      expect(mockFetch).toHaveBeenCalledWith(
        "http://bot-api.local:8081/file/botfake/photos/file_1.jpg",
      );
    });

    it("downloads from Telegram's file endpoint when the channel's apiRoot is empty", async () => {
      await setup({
        channelId: "tg-ch",
        credentials: { token: "fake", apiRoot: "" },
        transport: mockTransport(),
        attachments: mockAttachmentStore(),
        inngest: mockInngest(),
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
      });
      await handlers.get("on:message:photo")!(makePhotoCtx(111));

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/file/botfake/photos/file_1.jpg",
      );
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

    it("logs a missing file_path as no_file_path", async () => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      try {
        await createAdapter();
        const ctx = makePhotoCtx(111);
        ctx.api.getFile = vi.fn().mockResolvedValue({ file_path: undefined });

        await handlers.get("on:message:photo")!(ctx);

        expect(error).toHaveBeenCalledWith(
          { error: { kind: "no_file_path", fileId: "large_id" } },
          "failed to process photo",
        );
      } finally {
        error.mockRestore();
      }
    });

    it("logs an error status from the file endpoint as http_error", async () => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      try {
        await createAdapter();
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          arrayBuffer: async () => new Uint8Array().buffer,
        });

        await handlers.get("on:message:photo")!(makePhotoCtx(111));

        expect(error).toHaveBeenCalledWith(
          {
            error: {
              kind: "http_error",
              fileId: "large_id",
              status: 500,
              statusText: "Internal Server Error",
            },
          },
          "failed to process photo",
        );
      } finally {
        error.mockRestore();
      }
    });

    it("refuses a local-mode server's absolute file_path, naming the cause", async () => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      try {
        const { transport } = await createAdapter();
        const ctx = makePhotoCtx(111);
        ctx.api.getFile = vi
          .fn()
          .mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/photos/file_1.jpg" });

        await handlers.get("on:message:photo")!(ctx);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(transport.uploadAttachment).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(
          {
            error: {
              kind: "local_path",
              fileId: "large_id",
              path: "/var/lib/telegram-bot-api/photos/file_1.jpg",
            },
          },
          "failed to process photo",
        );
      } finally {
        error.mockRestore();
      }
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

    it("does not upload or emit on missing file_path", async () => {
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
      // The audio handler is deliberately absent — see the comment after
      // bot.on("message:voice") in message-handlers.ts. Voice notes only.
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

    function documentHandler() {
      return expectDefined(handlers.get("on:message:document"), "document handler");
    }

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

    function serveBytes(bytes: Uint8Array) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      });
    }

    const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it("names UTF-8 text by its extension when Telegram sends application/octet-stream", async () => {
      const { transport } = await createAdapter();
      serveBytes(Buffer.from("<!doctype html><p>hi</p>", "utf-8"));
      const ctx = makeDocumentCtx(111, {
        file_name: "page.html",
        mime_type: "application/octet-stream",
      });
      await documentHandler()(ctx);

      expect(transport.uploadAttachment).toHaveBeenCalledWith(expect.any(Buffer), "text/html");
      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "document", path: "inbound/test.jpg", mediaType: "text/html", name: "page.html" }],
        expect.any(Date),
      );
    });

    it("names UTF-8 text by its extension when mime_type is missing", async () => {
      const { transport } = await createAdapter();
      serveBytes(Buffer.from("# Notes\n", "utf-8"));
      const ctx = makeDocumentCtx(111, { file_name: "NOTES.MD" });
      await documentHandler()(ctx);

      expect(transport.uploadAttachment).toHaveBeenCalledWith(expect.any(Buffer), "text/markdown");
    });

    // mime-db maps these extensions to a non-text type (video/mp2t,
    // application/x-sh, image/svg+xml) or to none.
    it.each([
      ["index.ts", "export const x: number = 1;\n"],
      ["build.sh", "#!/bin/sh\necho hi\n"],
      ["logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["script.py", "def greet():\n    print('héllo')\n"],
    ])("sniffs UTF-8 text in %s as text/plain", async (fileName, text) => {
      const { transport } = await createAdapter();
      serveBytes(Buffer.from(text, "utf-8"));
      const ctx = makeDocumentCtx(111, {
        file_name: fileName,
        mime_type: "application/octet-stream",
      });
      await documentHandler()(ctx);

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "document", path: "inbound/test.jpg", mediaType: "text/plain", name: fileName }],
        expect.any(Date),
      );
    });

    it("keeps application/pdf for a PDF whose bytes are all ASCII", async () => {
      const { transport } = await createAdapter();
      serveBytes(Buffer.from("%PDF-1.1\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n", "utf-8"));
      const ctx = makeDocumentCtx(111, {
        file_name: "minimal.pdf",
        mime_type: "application/octet-stream",
      });
      await documentHandler()(ctx);

      expect(transport.uploadAttachment).toHaveBeenCalledWith(
        expect.any(Buffer),
        "application/pdf",
      );
    });

    it("routes an octet-stream file with an image extension to an image inbound block", async () => {
      const { transport } = await createAdapter();
      serveBytes(PNG_HEADER);
      const ctx = makeDocumentCtx(111, {
        file_name: "photo.png",
        mime_type: "application/octet-stream",
      });
      await documentHandler()(ctx);

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "image", path: "inbound/test.jpg", mediaType: "image/png", name: "photo.png" }],
        expect.any(Date),
      );
    });

    // No vision route accepts these, so they stay documents and keep their name.
    it.each([
      [{ file_name: "scan.heic", mime_type: "application/octet-stream" }, "image/heic"],
      [{ file_name: "photo.heic", mime_type: "image/heic" }, "image/heic"],
      [{ file_name: "scan.bmp" }, "image/bmp"],
    ])("emits %o as a document of type %s", async (doc, mediaType) => {
      const { transport } = await createAdapter();
      serveBytes(PNG_HEADER);
      await documentHandler()(makeDocumentCtx(111, doc));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "document", path: "inbound/test.jpg", mediaType, name: doc.file_name }],
        expect.any(Date),
      );
    });

    it.each([
      ["control bytes", new Uint8Array([1, 2, 3])],
      ["a NUL byte", Buffer.from("text\0more", "latin1")],
      ["invalid UTF-8", Buffer.from("caf\xe9", "latin1")],
      [
        "invalid UTF-8 past the binary-byte window",
        Buffer.concat([Buffer.alloc(9000, "a"), Buffer.from([0xe9])]),
      ],
    ])(
      "keeps application/octet-stream for content with %s and no known extension",
      async (_, bytes) => {
        const { transport } = await createAdapter();
        serveBytes(bytes);
        const ctx = makeDocumentCtx(111, {
          file_name: "Makefile",
          mime_type: "application/octet-stream",
        });
        await documentHandler()(ctx);

        expect(transport.uploadAttachment).toHaveBeenCalledWith(
          expect.any(Buffer),
          "application/octet-stream",
        );
      },
    );

    it("keeps a specific mime_type over the one the extension implies", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, { file_name: "data.json", mime_type: "text/plain" });
      await documentHandler()(ctx);

      expect(transport.uploadAttachment).toHaveBeenCalledWith(expect.any(Buffer), "text/plain");
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
    // adapter must route JPEG, PNG, GIF and WebP to the image inbound block
    // so the LLM's vision pipeline picks them up — Anthropic's `document`
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
        [{ type: "image", path: "inbound/test.jpg", mediaType: "image/png", name: "photo.png" }],
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
        [{ type: "image", path: "inbound/test.jpg", mediaType: "image/jpeg", name: "photo.jpg" }],
        expect.any(Date),
      );
    });

    it("emits an image document with no file name as an unnamed image block", async () => {
      const { transport } = await createAdapter();
      await documentHandler()(makeDocumentCtx(111, { mime_type: "image/gif" }));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "image", path: "inbound/test.jpg", mediaType: "image/gif" }],
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
          { type: "image", path: "inbound/test.jpg", mediaType: "image/webp", name: "x.webp" },
        ],
        expect.any(Date),
      );
    });

    it("does not upload or emit when getFile returns no file_path", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, { mime_type: "application/pdf", file_name: "huge.pdf" });
      ctx.api.getFile = vi.fn().mockResolvedValue({ file_path: undefined });

      await handlers.get("on:message:document")!(ctx);

      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });

    describe("over the 20 MB download limit", () => {
      const OVER_LIMIT = 20 * 1024 * 1024 + 1;

      it("emits a size-only block with its caption and downloads nothing", async () => {
        const { transport } = await createAdapter();
        const ctx = makeDocumentCtx(
          111,
          { file_name: "talk.mp4", mime_type: "video/mp4", file_size: OVER_LIMIT },
          "watch this",
        );
        await documentHandler()(ctx);

        expect(ctx.api.getFile).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(transport.uploadAttachment).not.toHaveBeenCalled();
        expect(transport.emit).toHaveBeenCalledWith(
          "session-1",
          [
            { type: "text", text: "watch this" },
            { type: "document", mediaType: "video/mp4", name: "talk.mp4", bytes: OVER_LIMIT },
          ],
          expect.any(Date),
        );
      });

      it.each([
        [{ file_name: "scan.png", mime_type: "application/octet-stream" }, "image/png"],
        [{ file_name: "archive" }, "application/octet-stream"],
      ])("types %o by its extension as %s", async (doc, mediaType) => {
        const { transport } = await createAdapter();
        await documentHandler()(makeDocumentCtx(111, { ...doc, file_size: OVER_LIMIT }));

        expect(transport.emit).toHaveBeenCalledWith(
          "session-1",
          [{ type: "document", mediaType, name: doc.file_name, bytes: OVER_LIMIT }],
          expect.any(Date),
        );
      });

      it("downloads a file of exactly 20 MB", async () => {
        const { transport } = await createAdapter();
        const ctx = makeDocumentCtx(111, {
          file_name: "x.pdf",
          mime_type: "application/pdf",
          file_size: 20 * 1024 * 1024,
        });
        await documentHandler()(ctx);

        expect(ctx.api.getFile).toHaveBeenCalled();
        expect(transport.uploadAttachment).toHaveBeenCalled();
      });
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

  describe("a file Telegram won't serve as over its 20 MB download limit", () => {
    const TOO_LARGE_REPLY =
      "That file is too large to open. Telegram bots can download files up to 20 MB.";
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

    it.each([
      ["photo", () => makePhotoCtx(111)],
      ["voice", () => makeVoiceCtx(111)],
      // No declared size: a document with one over the limit takes the size-only block.
      ["document", () => makeDocumentCtx(111, { file_name: "big.pdf" })],
    ])("replies with the limit when getFile refuses a %s as too big", async (kind, makeCtx) => {
      const { transport } = await createAdapter();
      const ctx = makeCtx();
      ctx.api.getFile = vi.fn().mockRejectedValue(getFileRefusal("Bad Request: file is too big"));

      await expectDefined(handlers.get(`on:message:${kind}`), kind)(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(TOO_LARGE_REPLY);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(transport.uploadAttachment).not.toHaveBeenCalled();
      expect(transport.emit).not.toHaveBeenCalled();
    });

    it("replies to a voice note declared over the limit without asking for the file", async () => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});
      try {
        const { transport } = await createAdapter();
        const ctx = makeVoiceCtx(111, {
          file_id: "big_voice",
          file_size: MAX_INBOUND_FILE_BYTES + 1,
        });

        await expectDefined(handlers.get("on:message:voice"), "voice handler")(ctx);

        expect(ctx.reply).toHaveBeenCalledWith(TOO_LARGE_REPLY);
        expect(ctx.api.getFile).not.toHaveBeenCalled();
        expect(transport.emit).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(
          { error: { kind: "too_large", fileId: "big_voice" } },
          "failed to process voice message",
        );
      } finally {
        info.mockRestore();
      }
    });

    it("downloads a voice note of exactly 20 MB", async () => {
      const { transport } = await createAdapter();
      const ctx = makeVoiceCtx(111, { file_size: MAX_INBOUND_FILE_BYTES });

      await expectDefined(handlers.get("on:message:voice"), "voice handler")(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(transport.emit).toHaveBeenCalled();
    });

    it("logs any other getFile refusal without replying", async () => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      try {
        await createAdapter();
        const ctx = makeVoiceCtx(111);
        const refusal = getFileRefusal("Bad Request: invalid file_id");
        ctx.api.getFile = vi.fn().mockRejectedValue(refusal);

        await expectDefined(handlers.get("on:message:voice"), "voice handler")(ctx);

        expect(ctx.reply).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith({ err: refusal }, "failed to process voice message");
      } finally {
        error.mockRestore();
      }
    });
  });

  describe("forwarded messages", () => {
    const forwardOrigin = {
      type: "user",
      date: 1600000000,
      sender_user: { id: 7, is_bot: false, first_name: "Alice" },
    };
    const forwarded = { origin: "user", from: "Alice", sentAt: "2020-09-13T12:26:40.000Z" };

    function asForwarded<C extends { message: object }>(ctx: C): C {
      return { ...ctx, message: { ...ctx.message, forward_origin: forwardOrigin } };
    }

    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      );
    });

    it("gives a forwarded message to an open dialog as its input", async () => {
      const { transport } = await createAdapter({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok({} as never)),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
          setClass: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      await handlers.get("command:profile")!({ ...makeCtx(111, "", 42), match: "new coder" });

      const ctx = asForwarded(makeCtx(111, "You are a coder", 42));
      await handlers.get("on:message:text")!(ctx);

      expect(transport.emit).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Step 2/3"), undefined);
    });

    it("packs forwarded text as a marked text block", async () => {
      const { transport } = await createAdapter();
      await handlers.get("on:message:text")!(asForwarded(makeCtx(111, "meet at 8", 42)));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [{ type: "text", text: "meet at 8", forwarded }],
        expect.any(Date),
      );
    });

    it("marks a forwarded photo's caption", async () => {
      const { transport } = await createAdapter();
      await handlers.get("on:message:photo")!(asForwarded(makePhotoCtx(111, "Look at this!")));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "Look at this!", forwarded },
          { type: "image", path: "inbound/test.jpg", mediaType: "image/jpeg" },
        ],
        expect.any(Date),
      );
    });

    it("puts an empty forwarded text block ahead of a captionless forwarded photo", async () => {
      const { transport } = await createAdapter();
      await handlers.get("on:message:photo")!(asForwarded(makePhotoCtx(111)));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "", forwarded },
          { type: "image", path: "inbound/test.jpg", mediaType: "image/jpeg" },
        ],
        expect.any(Date),
      );
    });

    it("puts an empty forwarded text block ahead of a captionless forwarded document", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, { file_name: "x.pdf", mime_type: "application/pdf" });
      await handlers.get("on:message:document")!(asForwarded(ctx));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "", forwarded },
          {
            type: "document",
            path: "inbound/test.jpg",
            mediaType: "application/pdf",
            name: "x.pdf",
          },
        ],
        expect.any(Date),
      );
    });

    it("marks a forwarded document's caption", async () => {
      const { transport } = await createAdapter();
      const ctx = makeDocumentCtx(111, { file_name: "x.txt", mime_type: "text/plain" }, "notes");
      await handlers.get("on:message:document")!(asForwarded(ctx));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "notes", forwarded },
          { type: "document", path: "inbound/test.jpg", mediaType: "text/plain", name: "x.txt" },
        ],
        expect.any(Date),
      );
    });

    it("marks a forwarded voice note and its caption", async () => {
      const { transport } = await createAdapter();
      const ctx = makeVoiceCtx(111, { duration: 3 }, "listen up");
      await handlers.get("on:message:voice")!(asForwarded(ctx));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          { type: "text", text: "listen up", forwarded },
          {
            type: "voice",
            path: "inbound/test.jpg",
            mediaType: "audio/ogg",
            durationMs: 3000,
            forwarded,
          },
        ],
        expect.any(Date),
      );
    });

    it("marks a captionless forwarded voice note on the voice block alone", async () => {
      const { transport } = await createAdapter();
      await handlers.get("on:message:voice")!(asForwarded(makeVoiceCtx(111, { duration: 3 })));

      expect(transport.emit).toHaveBeenCalledWith(
        "session-1",
        [
          {
            type: "voice",
            path: "inbound/test.jpg",
            mediaType: "audio/ogg",
            durationMs: 3000,
            forwarded,
          },
        ],
        expect.any(Date),
      );
    });

    describe("from the user themselves", () => {
      // The sender (makeCtx's fromId, 111) forwarding their own earlier message.
      function asSelfForwarded<C extends { message: object }>(ctx: C): C {
        const origin = {
          type: "user",
          date: 1600000000,
          sender_user: { id: 111, is_bot: false, first_name: "Timur" },
        };
        return { ...ctx, message: { ...ctx.message, forward_origin: origin } };
      }

      it("keeps text the bare string of the user's own words", async () => {
        const { transport } = await createAdapter();
        await handlers.get("on:message:text")!(asSelfForwarded(makeCtx(111, "note to self", 42)));

        expect(transport.emit).toHaveBeenCalledWith("session-1", "note to self", expect.any(Date));
      });

      it("leaves a photo's caption unmarked, and adds no empty block without one", async () => {
        const { transport } = await createAdapter();
        await handlers.get("on:message:photo")!(asSelfForwarded(makePhotoCtx(111, "mine")));
        await handlers.get("on:message:photo")!(asSelfForwarded(makePhotoCtx(111)));

        const image = { type: "image", path: "inbound/test.jpg", mediaType: "image/jpeg" };
        expect(vi.mocked(transport.emit).mock.calls.map(([, content]) => content)).toEqual([
          [{ type: "text", text: "mine" }, image],
          [image],
        ]);
      });

      it("leaves a document unmarked", async () => {
        const { transport } = await createAdapter();
        const ctx = makeDocumentCtx(111, { file_name: "x.pdf", mime_type: "application/pdf" });
        await handlers.get("on:message:document")!(asSelfForwarded(ctx));

        expect(transport.emit).toHaveBeenCalledWith(
          "session-1",
          [
            {
              type: "document",
              path: "inbound/test.jpg",
              mediaType: "application/pdf",
              name: "x.pdf",
            },
          ],
          expect.any(Date),
        );
      });

      it("leaves a voice note unmarked", async () => {
        const { transport } = await createAdapter();
        await handlers.get("on:message:voice")!(
          asSelfForwarded(makeVoiceCtx(111, { duration: 3 })),
        );

        expect(transport.emit).toHaveBeenCalledWith(
          "session-1",
          [{ type: "voice", path: "inbound/test.jpg", mediaType: "audio/ogg", durationMs: 3000 }],
          expect.any(Date),
        );
      });
    });
  });
});
