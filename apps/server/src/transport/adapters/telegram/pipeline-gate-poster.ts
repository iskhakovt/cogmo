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

/**
 * The timeout in the definition's own grammar: the largest unit it divides
 * evenly, otherwise the largest unit it reaches with one decimal place
 * (minutes for anything shorter), so "4.1m" and "0.5m" read back as written.
 */
export function formatGateTimeout(ms: number): string {
  const whole = UNITS.find(([size]) => ms >= size && ms % size === 0);
  if (whole) return `${ms / whole[0]}${whole[1]}`;
  const [size, suffix] = UNITS.find(([unit]) => ms >= unit) ?? [60_000, "m"];
  return `${Number((ms / size).toFixed(1))}${suffix}`;
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
      reply_markup: buildPipelineGateKeyboard(event.runId, event.gateKey),
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
