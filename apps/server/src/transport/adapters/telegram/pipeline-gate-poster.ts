import {
  buildPipelineGateKeyboard,
  type PipelineGateInlineKeyboardMarkup,
} from "../../../agent/pipeline/gate-keyboard.js";
import type { Transactor } from "../../../db/index.js";
import type { PipelineGatePendingData } from "../../../inngest/events.js";
import { logger } from "../../../logger.js";
import type { TransportStore } from "../../store/index.js";

export type PipelineGateSendMessage = (
  chatId: number,
  text: string,
  opts: { reply_markup: PipelineGateInlineKeyboardMarkup },
) => Promise<unknown>;

export type PostPipelineGateKeyboardResult =
  | { posted: true }
  | { posted: false; reason: "no_telegram_session" | "send_failed" };

const UNITS: ReadonlyArray<readonly [ms: number, suffix: string]> = [
  [604_800_000, "w"],
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
];

/** Largest whole unit of the timeout, the same grammar the definition was written in. */
export function formatGateTimeout(ms: number): string {
  const unit = UNITS.find(([size]) => ms % size === 0) ?? [60_000, "m"];
  return `${Math.round(ms / unit[0])}${unit[1]}`;
}

export function buildPipelineGateText(event: PipelineGatePendingData): string {
  return (
    `🚦 Pipeline "${event.pipelineName}" — checkpoint "${event.stageId}"\n\n` +
    `${event.prompt}\n\n` +
    `Waiting up to ${formatGateTimeout(event.timeoutMs)} for your decision.`
  );
}

/**
 * Post a gate checkpoint's Approve / Cancel keyboard to this channel's
 * session on the run conversation. No session on this channel is not an
 * error — another channel's poster, or none, owns the delivery.
 *
 * A failed send is logged and swallowed: the function runs with no retries,
 * and the gate still resolves through its waiter's timeout action, so the
 * run cannot wedge on a keyboard that never appeared.
 */
export async function postPipelineGateKeyboard(args: {
  event: PipelineGatePendingData;
  channelId: string;
  runInTx: Transactor;
  transportStore: Pick<TransportStore, "getActiveSessionsForConversation">;
  sendMessage: PipelineGateSendMessage;
}): Promise<PostPipelineGateKeyboardResult> {
  const { event, channelId, runInTx, transportStore, sendMessage } = args;
  const sessions = await runInTx((tx) =>
    transportStore.getActiveSessionsForConversation(tx, event.conversationId),
  );
  const session = sessions.find((s) => s.channelId === channelId);
  if (!session) return { posted: false, reason: "no_telegram_session" };

  try {
    await sendMessage(Number(session.platformAddress), buildPipelineGateText(event), {
      reply_markup: buildPipelineGateKeyboard(event.runId),
    });
    return { posted: true };
  } catch (err) {
    logger.warn(
      { err, runId: event.runId, gateKey: event.gateKey, conversationId: event.conversationId },
      "telegram: failed to post pipeline gate keyboard; the gate will resolve on timeout",
    );
    return { posted: false, reason: "send_failed" };
  }
}
