import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_CALLBACK_REGEX } from "../../../agent/coding/plan-keyboard.js";
import { PIPELINE_GATE_CALLBACK_REGEX } from "../../../agent/pipeline/gate-keyboard.js";
import { SKILLS_APPROVAL_CALLBACK_REGEX } from "../../../skills/skills-keyboard.js";
import { mockAttachmentStore, mockInngest, mockTransport } from "../../../test/factories.js";
import { handlers, resetGrammyMock } from "../../../test/telegram/grammy-mock.js";
import { createAdapter } from "../../../test/telegram/harness.js";
import { setup } from "./index.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

describe("registerCallbackQueries", () => {
  beforeEach(() => {
    resetGrammyMock();
  });

  // Inline-keyboard callbackQuery handlers are wired with one regex per
  // keyboard (plan / pipeline gate / skills approval). The pure handler logic
  // lives in commands/keyboard-callbacks.ts and is tested there; this block exercises the
  // adapter-side wiring — does the registered handler dispatch to the right
  // transport call, edit the original message, send the toast, and (where
  // applicable) reply with the follow-up? A regex shape or parse* signature
  // drift would silently brick the buttons without this coverage.
  describe("callback query dispatch", () => {
    // Pinned UUIDs for callback data — must match the regex shape.
    const TASK_ID = "00000000-0000-0000-0000-000000000001";
    const PENDING_ID = "00000000-0000-0000-0000-000000000002";

    function makeCallbackCtx(data: string, fromId = 111) {
      return {
        from: { id: fromId },
        chat: { id: 555 },
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

    it("skill approval: approve → skills.approveDeploy, edit shows skill name + git sha", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`skill:${PENDING_ID}:approve`);

      const handler = handlers.get(`callbackQuery:${SKILLS_APPROVAL_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.skills.approveDeploy).toHaveBeenCalledWith(PENDING_ID, "111", "555");
      const editArgs = ctx.editMessageText.mock.calls[0];
      expect(editArgs?.[0]).toContain("echo"); // skillName from mock
      expect(editArgs?.[0]).toContain("abc1234"); // gitSha from mock
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved" });
    });

    it("skill approval: a tap with no chat is answered, not dispatched", async () => {
      const { transport } = await createAdapter();
      const { chat: _chat, ...ctx } = makeCallbackCtx(`skill:${PENDING_ID}:approve`);

      const handler = handlers.get(`callbackQuery:${SKILLS_APPROVAL_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.skills.approveDeploy).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it("skill approval: deny → skills.denyDeploy", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`skill:${PENDING_ID}:deny`);

      const handler = handlers.get(`callbackQuery:${SKILLS_APPROVAL_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.skills.denyDeploy).toHaveBeenCalledWith(PENDING_ID, "111");
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Denied" });
    });

    it("pipeline gate: approve → pipelines.resolveGate with the token, edit clears keyboard, answers toast", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`pipe:${TASK_ID}:approve:0a1b2c3d`);

      const handler = handlers.get(`callbackQuery:${PIPELINE_GATE_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.pipelines.resolveGate).toHaveBeenCalledWith(
        TASK_ID,
        "0a1b2c3d",
        "approve",
        "111",
      );
      expect(ctx.editMessageText).toHaveBeenCalledWith(
        '✅ Approval sent for checkpoint "approve" of pipeline "issue-to-pr".',
        { reply_markup: { inline_keyboard: [] } },
      );
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved" });
    });

    it("pipeline gate: a rejected tap answers with a toast and leaves the keyboard", async () => {
      const { transport } = await createAdapter({
        pipelines: {
          resolveGate: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
        },
      });
      const ctx = makeCallbackCtx(`pipe:${TASK_ID}:approve:0a1b2c3d`);

      const handler = handlers.get(`callbackQuery:${PIPELINE_GATE_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.pipelines.resolveGate).toHaveBeenCalled();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: "You're not authorized on this bot.",
      });
    });

    it("pipeline gate: cancel → pipelines.resolveGate with cancel", async () => {
      const { transport } = await createAdapter();
      const ctx = makeCallbackCtx(`pipe:${TASK_ID}:cancel:0a1b2c3d`);

      const handler = handlers.get(`callbackQuery:${PIPELINE_GATE_CALLBACK_REGEX.source}`);
      await handler(ctx);

      expect(transport.pipelines.resolveGate).toHaveBeenCalledWith(
        TASK_ID,
        "0a1b2c3d",
        "cancel",
        "111",
      );
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Cancelling" });
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
