import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockAttachmentStore, mockInngest, mockTransport } from "../../../test/factories.js";
import { handlers, mockBotApi, resetGrammyMock } from "../../../test/telegram/grammy-mock.js";
import { createAdapter, makeCtx } from "../../../test/telegram/harness.js";
import { setup } from "./index.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

describe("createInboundDispatch", () => {
  beforeEach(() => {
    resetGrammyMock();
  });

  it("creates conversation when no session exists", async () => {
    const { transport } = await createAdapter({
      resolveSession: vi.fn().mockResolvedValue(null),
    });
    await handlers.get("on:message:text")!(makeCtx(111, "first message", 42));

    expect(transport.createConversation).toHaveBeenCalledWith("42", "111", { isPrivate: true });
  });

  // The text-message path's branches around session resolution: identity
  // rejection on createConversation and emit-failure on transport.emit. Both
  // are silent error paths (info or error log, no user-visible reply);
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
        inngest: mockInngest(),
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
  });
});
