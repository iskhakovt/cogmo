import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../../db/index.js";
import { expectDefined } from "../../../test/assertions.js";
import type { TransportStore } from "../../store/index.js";
import { postPipelineGateKeyboard } from "./pipeline-gate-poster.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const EVENT = {
  runId: "019e2900-0000-7000-8000-000000000001",
  stageId: "plan-gate",
  conversationId: "conv-1",
  pipelineName: "issue-to-pr",
};

function makeArgs(sessions: { channelId: string; platformAddress: string }[]) {
  const transportStore = mock<TransportStore>();
  transportStore.getActiveSessionsForConversation.mockResolvedValue(
    sessions.map((s) => ({
      id: `sess-${s.channelId}`,
      channelId: s.channelId,
      platformAddress: s.platformAddress,
      conversationId: "conv-1",
      status: "active" as const,
      receive: "routed" as const,
    })),
  );
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 7 });
  return {
    args: {
      event: EVENT,
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore,
      sendMessage,
    },
    sendMessage,
  };
}

describe("postPipelineGateKeyboard", () => {
  it("posts the buttons to this channel's session", async () => {
    const { args, sendMessage } = makeArgs([{ channelId: "ch-telegram", platformAddress: "4242" }]);

    const result = await postPipelineGateKeyboard(args);

    expect(result).toEqual({ posted: true });
    const [chatId, text, opts] = expectDefined(sendMessage.mock.calls[0], "sendMessage call");
    expect(chatId).toBe(4242);
    expect(text).toContain("plan-gate");
    expect(opts.reply_markup.inline_keyboard[0]).toHaveLength(3);
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      `pgate:${EVENT.runId}:approve`,
    );
  });

  it("ignores sessions belonging to other channels", async () => {
    const { args, sendMessage } = makeArgs([{ channelId: "ch-web", platformAddress: "web-1" }]);

    const result = await postPipelineGateKeyboard(args);

    expect(result).toEqual({ posted: false, reason: "no_telegram_session" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("degrades to /gate instead of throwing when the send fails", async () => {
    const { args, sendMessage } = makeArgs([{ channelId: "ch-telegram", platformAddress: "4242" }]);
    sendMessage.mockRejectedValue(new Error("bot was blocked by the user"));

    const result = await postPipelineGateKeyboard(args);

    expect(result).toEqual({ posted: false, reason: "send_failed" });
  });
});
