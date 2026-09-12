import { describe, expect, it, vi } from "vitest";
import type { PipelineGatePendingData } from "../../../inngest/events.js";
import { fakeRunInTx, mockTransportStore } from "../../../test/factories.js";
import {
  buildPipelineGateText,
  formatGateTimeout,
  postPipelineGateKeyboard,
} from "./pipeline-gate-poster.js";

const RUN_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const EVENT: PipelineGatePendingData = {
  runId: RUN_ID,
  gateKey: `${RUN_ID}:approve:0`,
  conversationId: "conv-1",
  pipelineName: "issue-to-pr",
  stageId: "approve",
  prompt: "Approve the plan?",
  timeoutMs: 3 * 86_400_000,
  onTimeout: { kind: "abort" },
};

function sessionsFor(...channelIds: string[]) {
  return mockTransportStore({
    getActiveSessionsForConversation: vi
      .fn()
      .mockResolvedValue(channelIds.map((channelId) => ({ channelId, platformAddress: "4242" }))),
  });
}

describe("formatGateTimeout", () => {
  it.each([
    [2 * 604_800_000, "2w"],
    [3 * 86_400_000, "3d"],
    [36 * 3_600_000, "36h"],
    [90 * 60_000, "90m"],
  ])("%i ms → %s", (ms, expected) => {
    expect(formatGateTimeout(ms)).toBe(expected);
  });
});

describe("postPipelineGateKeyboard", () => {
  it("posts the checkpoint text with the run's keyboard to this channel's session", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

    const result = await postPipelineGateKeyboard({
      event: EVENT,
      channelId: "tg",
      runInTx: fakeRunInTx,
      transportStore: sessionsFor("web", "tg"),
      sendMessage,
    });

    expect(result).toEqual({ posted: true });
    expect(sendMessage).toHaveBeenCalledWith(4242, buildPipelineGateText(EVENT), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `pipe:${RUN_ID}:approve` },
            { text: "❌ Cancel run", callback_data: `pipe:${RUN_ID}:cancel` },
          ],
        ],
      },
    });
    expect(buildPipelineGateText(EVENT)).toContain('checkpoint "approve"');
    expect(buildPipelineGateText(EVENT)).toContain("Waiting up to 3d");
  });

  it("skips when the conversation has no session on this channel", async () => {
    const sendMessage = vi.fn();

    const result = await postPipelineGateKeyboard({
      event: EVENT,
      channelId: "tg",
      runInTx: fakeRunInTx,
      transportStore: sessionsFor("web"),
      sendMessage,
    });

    expect(result).toEqual({ posted: false, reason: "no_telegram_session" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("swallows a failed send so the gate falls back to its timeout", async () => {
    const result = await postPipelineGateKeyboard({
      event: EVENT,
      channelId: "tg",
      runInTx: fakeRunInTx,
      transportStore: sessionsFor("tg"),
      sendMessage: vi.fn().mockRejectedValue(new Error("403: bot was blocked by the user")),
    });

    expect(result).toEqual({ posted: false, reason: "send_failed" });
  });
});
