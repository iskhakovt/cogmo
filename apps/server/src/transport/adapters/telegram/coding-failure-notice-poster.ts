import { fitFindings, splitFindings } from "../../../agent/coding/presubmit-findings.js";
import { describeTaskFailure } from "../../../agent/coding/task-failure.js";
import type { CodingTaskFailureReason } from "../../../agent/coding/types.js";
import type { Transactor } from "../../../db/index.js";
import type { CodingTaskFailureNoticeData } from "../../../inngest/events.js";
import { logger } from "../../../logger.js";
import type { TransportStore } from "../../store/index.js";
import { fitTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "./message-limit.js";

/** Whether a reason's detail is register's findings, cut at a finding boundary; any other is text. */
const FINDINGS_DETAIL: Readonly<Record<CodingTaskFailureReason, boolean>> = {
  cli_exit_error: false,
  no_plan_produced: false,
  claude_auth_failed: false,
  push_failed: false,
  branch_conflict: false,
  auth_failed: false,
  verify_failed: false,
  verify_timed_out: false,
  presubmit_refused: true,
  presubmit_stale_base: false,
  pr_auth_failed: false,
  pr_validation_failed: false,
  pr_open_failed: false,
  credentials_unavailable: false,
  run_terminated: false,
  start_emit_failed: false,
  unexpected_error: false,
  user_cancelled: false,
  user_requested_revisions: false,
  unknown: false,
};

/** `detail`'s end within `room` characters: output and errors end where they failed. */
function fitTail(detail: string, room: number): string {
  if (detail.length <= room) return detail;
  const points = Array.from(detail);
  let kept = "";
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i] ?? "";
    if (kept.length + point.length > room - 1) break;
    kept = point + kept;
  }
  return `…${kept}`;
}

/**
 * The notice as one message: the failure as `describeTaskFailure` words it,
 * its detail fitted to Telegram's limit (a refusal's findings cut at a
 * finding boundary with a count of the rest, any other detail kept from its
 * end), then the pushed branch, which a stale base's detail tells the owner
 * what to do with. Plain text: details quote author-controlled code, and a
 * Markdown parse failure would 400 the whole send.
 */
function failureNoticeText(notice: CodingTaskFailureNoticeData): string {
  const text = (detail: string) =>
    [
      `❌ ${describeTaskFailure({ reason: notice.reason, detail })}`,
      `Branch: ${notice.branch}`,
    ].join("\n");
  const detail = FINDINGS_DETAIL[notice.reason]
    ? fitFindings(
        splitFindings(notice.detail),
        (fitted) => text(fitted).length <= TELEGRAM_MAX_MESSAGE_LENGTH,
      )
    : // A one-character detail: an empty one drops the label's separator too.
      fitTail(notice.detail, TELEGRAM_MAX_MESSAGE_LENGTH - (text("x").length - 1));
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
