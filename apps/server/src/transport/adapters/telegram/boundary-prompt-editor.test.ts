import { describe, expect, it, vi } from "vitest";
import type { BoundaryResolvedData, BoundaryResolvedReason } from "../../../inngest/events.js";
import { boundaryOutcomeText, editResolvedBoundaryPrompt } from "./boundary-prompt-editor.js";

const CHANNEL_ID = "tg-ch";

function makeEvent(overrides: Partial<BoundaryResolvedData> = {}): BoundaryResolvedData {
  return {
    boundaryId: "b-1",
    channelId: CHANNEL_ID,
    platformAddress: "42",
    promptMessageId: "9001",
    resolvedConversationId: "conv-1",
    reason: "user_resume",
    drainedInboundCount: 1,
    ...overrides,
  };
}

describe("boundaryOutcomeText", () => {
  it.each<[BoundaryResolvedReason, string]>([
    ["user_resume", "↶ Picking up where we left off."],
    ["user_resume_target", "↶ Picking up where we left off."],
    ["user_fresh", "✦ Started a fresh chat."],
    ["user_command", "✦ Started a fresh chat."],
    ["waiter_timeout", "✦ No reply — started a fresh chat."],
  ])("maps %s to its settled outcome text", (reason, expected) => {
    expect(boundaryOutcomeText(reason)).toBe(expected);
  });
});

describe("editResolvedBoundaryPrompt", () => {
  it("rewrites the prompt to the outcome and clears the keyboard", async () => {
    const editMessageText = vi.fn().mockResolvedValue({});

    const result = await editResolvedBoundaryPrompt({
      event: makeEvent({ reason: "user_fresh" }),
      channelId: CHANNEL_ID,
      editMessageText,
    });

    expect(result).toEqual({ edited: true });
    expect(editMessageText).toHaveBeenCalledWith("42", 9001, "✦ Started a fresh chat.", {
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("edits on the timeout path — the resolution no callback covers", async () => {
    const editMessageText = vi.fn().mockResolvedValue({});

    const result = await editResolvedBoundaryPrompt({
      event: makeEvent({ reason: "waiter_timeout" }),
      channelId: CHANNEL_ID,
      editMessageText,
    });

    expect(result).toEqual({ edited: true });
    expect(editMessageText).toHaveBeenCalledWith("42", 9001, "✦ No reply — started a fresh chat.", {
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("ignores resolutions for a different channel without touching the bot", async () => {
    const editMessageText = vi.fn().mockResolvedValue({});

    const result = await editResolvedBoundaryPrompt({
      event: makeEvent({ channelId: "some-other-channel" }),
      channelId: CHANNEL_ID,
      editMessageText,
    });

    expect(result).toEqual({ edited: false, reason: "other_channel" });
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("swallows a failed edit (deleted prompt / blocked bot) and reports edit_failed", async () => {
    const editMessageText = vi
      .fn()
      .mockRejectedValue(new Error("Bad Request: message to edit not found"));

    const result = await editResolvedBoundaryPrompt({
      event: makeEvent(),
      channelId: CHANNEL_ID,
      editMessageText,
    });

    // Best-effort: the hold already resolved; a stale prompt is cosmetic, so
    // the handler must not throw out of the Inngest function body.
    expect(result).toEqual({ edited: false, reason: "edit_failed" });
    expect(editMessageText).toHaveBeenCalledOnce();
  });
});
