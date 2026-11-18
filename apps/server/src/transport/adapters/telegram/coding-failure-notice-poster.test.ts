import { describe, expect, it, vi } from "vitest";
import { fitFindings } from "../../../agent/coding/presubmit-findings.js";
import type { CodingTaskFailureNoticeData } from "../../../inngest/events.js";
import { expectDefined } from "../../../test/assertions.js";
import { fakeRunInTx, mockTransportStore } from "../../../test/factories.js";
import { postCodingFailureNotice } from "./coding-failure-notice-poster.js";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "./message-limit.js";

const CONV_ID = "019d0000-0000-7000-8000-000000000777";

function notice(overrides: Partial<CodingTaskFailureNoticeData> = {}): CodingTaskFailureNoticeData {
  return {
    conversationId: CONV_ID,
    taskId: "019d0000-0000-7000-8000-0000000000aa",
    reason: "presubmit_refused",
    detail: "ruff: skills/echo/skill.py:1:1: E501 Line too long",
    branch: "cogmo/abc12345",
    ...overrides,
  };
}

function sessionStore() {
  return mockTransportStore({
    getActiveSessionsForConversation: vi.fn().mockResolvedValue([
      { id: "s-web", channelId: "ch-web", platformAddress: "web", conversationId: CONV_ID },
      { id: "s-tg", channelId: "ch-tg", platformAddress: "42", conversationId: CONV_ID },
    ]),
  });
}

/** Posts `event` to `ch-tg` and returns the one text sent. */
async function postedText(event: CodingTaskFailureNoticeData): Promise<string> {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const result = await postCodingFailureNotice({
    event,
    channelId: "ch-tg",
    runInTx: fakeRunInTx,
    transportStore: sessionStore(),
    sendMessage,
  });
  expect(result).toEqual({ posted: true });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const [chatId, text] = expectDefined(sendMessage.mock.calls[0], "the send");
  expect(chatId).toBe(42);
  return text;
}

describe("postCodingFailureNotice", () => {
  it("renders a refusal as the task's failure, with its branch", async () => {
    expect(await postedText(notice())).toBe(
      "❌ The pre-submit refused the skill: ruff: skills/echo/skill.py:1:1: E501 Line too long\nBranch: cogmo/abc12345",
    );
  });

  it("names the branch a stale base's owner merges main into", async () => {
    const detail = `main is at ${"e".repeat(40)}, and the pushed tip ${"a".repeat(40)} does not contain it. Merge main into the branch and register it by hand.`;
    expect(await postedText(notice({ reason: "presubmit_stale_base", detail }))).toBe(
      `❌ The pre-submit refused a stale base: ${detail}\nBranch: cogmo/abc12345`,
    );
  });

  it("fits Telegram's limit at a finding boundary, counting the findings it leaves out", async () => {
    const findings = Array.from(
      { length: 40 },
      (_, i) => `ruff: skills/echo/skill.py:${i + 1}:1: E501 ${"x".repeat(180)}`,
    );
    // The detail an 8 KiB cut already left 7 findings out of.
    const text = await postedText(
      notice({ detail: [...findings, "[7 more findings]"].join("\n") }),
    );

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("Branch: cogmo/abc12345");
    const kept = lines.slice(0, -2);
    expect(kept[0]).toBe(`❌ The pre-submit refused the skill: ${findings[0]}`);
    expect(kept.slice(1)).toEqual(findings.slice(1, kept.length));
    expect(lines.at(-2)).toBe(`[${findings.length - kept.length + 7} more findings]`);
  });

  it("keeps a finding with line breaks whole, or leaves all of it out", async () => {
    const short = "ruff: skills/echo/skill.py:1:1: E501 Line too long";
    const traceback = [
      "schema_import: Traceback (most recent call last):",
      ...Array.from({ length: 3 }, (_, i) => `  frame ${i} ${"y".repeat(1500)}`),
    ].join("\n");
    // The detail as the verify run stores it.
    const detail = fitFindings([short, traceback], () => true);

    expect(await postedText(notice({ detail }))).toBe(
      `❌ The pre-submit refused the skill: ${short}\n[1 more findings]\nBranch: cogmo/abc12345`,
    );
  });

  it("posts nothing without a session on this channel", async () => {
    const sendMessage = vi.fn();
    const result = await postCodingFailureNotice({
      event: notice(),
      channelId: "ch-other",
      runInTx: fakeRunInTx,
      transportStore: sessionStore(),
      sendMessage,
    });

    expect(result).toEqual({ posted: false, reason: "no_telegram_session" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports a failed send instead of throwing", async () => {
    const result = await postCodingFailureNotice({
      event: notice(),
      channelId: "ch-tg",
      runInTx: fakeRunInTx,
      transportStore: sessionStore(),
      sendMessage: vi.fn().mockRejectedValue(new Error("Forbidden: bot was blocked")),
    });

    expect(result).toEqual({ posted: false, reason: "send_failed" });
  });
});
