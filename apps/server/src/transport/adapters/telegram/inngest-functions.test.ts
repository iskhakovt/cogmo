import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BoundaryResolvedData,
  boundaryResolvedEvent,
  pipelineGatePending,
} from "../../../inngest/events.js";
import { expectDefined } from "../../../test/assertions.js";
import {
  fakeRunInTx,
  mockAttachmentStore,
  mockInngest,
  mockTransport,
  mockTransportStore,
} from "../../../test/factories.js";
import { mockBotApi, resetGrammyMock } from "../../../test/telegram/grammy-mock.js";
import { setup } from "./index.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

describe("telegramFunctions", () => {
  beforeEach(() => {
    resetGrammyMock();
  });

  describe("pipeline gate", () => {
    it("registers the pipeline gate poster on pipeline/gate.pending when gate deps are supplied", async () => {
      const inngest = mockInngest();
      await setup({
        channelId: "tg-ch",
        credentials: { token: "fake" },
        transport: mockTransport(),
        attachments: mockAttachmentStore(),
        inngest,
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
        pipelineGate: { runInTx: fakeRunInTx, transportStore: mockTransportStore() },
      });

      const opts = vi.mocked(inngest.createFunction).mock.calls.map((call) => call[0]);
      expect(opts).toContainEqual({
        id: "telegram-pipeline-gate-tg-ch",
        triggers: [pipelineGatePending],
        retries: 0,
      });
    });
  });

  describe("boundary prompt cleanup", () => {
    it("registers a boundary/resolved listener whose handler edits the prompt to its outcome", async () => {
      // The handler itself is covered in boundary-prompt-editor.test.ts; this
      // pins the thin setup() glue the unit test can't reach — that the
      // listener is triggered by boundary/resolved and that its closure binds
      // this channel's id and forwards (chatId, messageId, text) to
      // bot.api.editMessageText in the right order.
      const inngest = mockInngest();
      await setup({
        channelId: "tg-ch",
        credentials: { token: "fake" },
        transport: mockTransport(),
        inngest,
        attachments: mockAttachmentStore(),
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
      });

      const registration = vi
        .mocked(inngest.createFunction)
        .mock.calls.find(
          (call) => (call[0] as { id?: string }).id === "telegram-boundary-resolved-tg-ch",
        );
      const [opts, handler] = expectDefined(registration) as [
        { triggers: unknown[] },
        (ctx: { event: { data: BoundaryResolvedData } }) => Promise<unknown>,
      ];

      expect(opts.triggers).toContain(boundaryResolvedEvent);

      await handler({
        event: {
          data: {
            boundaryId: "b-1",
            channelId: "tg-ch",
            platformAddress: "42",
            promptMessageId: "9001",
            resolvedConversationId: "conv-1",
            reason: "user_fresh",
            drainedInboundCount: 0,
          },
        },
      });

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(
        "42",
        9001,
        "✦ Started a fresh chat.",
        {
          reply_markup: { inline_keyboard: [] },
        },
      );
    });
  });
});
