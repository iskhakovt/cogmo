import { ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockAttachmentStore, mockInngest, mockTransport } from "../../../test/factories.js";
import { setup } from "./index.js";
import { handlers, resetGrammyMock } from "./test-grammy-mock.js";
import {
  createAdapter,
  makeCtx,
  makeDocumentCtx,
  makePhotoCtx,
  makeVoiceCtx,
} from "./test-harness.js";

vi.mock("grammy", async () => (await import("./test-grammy-mock.js")).grammyModule);

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
