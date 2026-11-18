import { fitFindings } from "../../../agent/coding/presubmit-findings.js";
import { describeTaskFailure } from "../../../agent/coding/task-failure.js";
import type { Transactor } from "../../../db/index.js";
import type { CodingTaskFailureNoticeData } from "../../../inngest/events.js";
import { logger } from "../../../logger.js";
import type { TransportStore } from "../../store/index.js";
import { fitTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "./message-limit.js";

/**
 * The notice as one message: the failure as `describeTaskFailure` words it,
 * its findings cut at a finding boundary with a count of the rest to fit
 * Telegram's limit, then the pushed branch, which a stale base's detail tells
 * the owner what to do with. Plain text: findings quote author-controlled
 * code, and a Markdown parse failure would 400 the whole send.
 */
function failureNoticeText(notice: CodingTaskFailureNoticeData): string {
  const text = (detail: string) =>
    [
      `❌ ${describeTaskFailure({ reason: notice.reason, detail })}`,
      `Branch: ${notice.branch}`,
    ].join("\n");
  const detail = fitFindings(
    notice.detail.split("\n"),
    (fitted) => text(fitted).length <= TELEGRAM_MAX_MESSAGE_LENGTH,
  );
  return fitTelegramMessage(text(detail));
}

export type CodingFailureNoticeSendMessage = (chatId: number, text: string) => Promise<unknown>;

export type PostCodingFailureNoticeResult =
  | { posted: true }
  | { posted: false; reason: "no_telegram_session" | "send_failed" };

/**
 * Per-channel handler for `coding/task/failure-notice`: posts the notice into
 * this channel's session on the event's conversation. A failed send is
 * logged, not retried; the task row keeps the reason and detail.
 */
export async function postCodingFailureNotice(args: {
  event: CodingTaskFailureNoticeData;
  channelId: string;
  runInTx: Transactor;
  transportStore: TransportStore;
  sendMessage: CodingFailureNoticeSendMessage;
}): Promise<PostCodingFailureNoticeResult> {
  const { event, channelId, runInTx, transportStore, sendMessage } = args;
  const sessions = await runInTx((tx) =>
    transportStore.getActiveSessionsForConversation(tx, event.conversationId),
  );
  const tgSession = sessions.find((s) => s.channelId === channelId);
  if (!tgSession) return { posted: false, reason: "no_telegram_session" };
  try {
    await sendMessage(Number(tgSession.platformAddress), failureNoticeText(event));
    return { posted: true };
  } catch (err) {
    logger.warn(
      { err, taskId: event.taskId, reason: event.reason, conversationId: event.conversationId },
      "telegram: failed to post a coding task's failure notice",
    );
    return { posted: false, reason: "send_failed" };
  }
}
