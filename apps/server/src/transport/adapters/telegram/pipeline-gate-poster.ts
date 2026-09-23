/**
 * Per-channel handler for `pipeline/gate.requested`: attach the Approve /
 * Revise / Cancel buttons to a parked gate.
 *
 * The gate's prompt itself is already in the conversation — the stage runner
 * delivered it through the ordinary notification path, so every channel sees
 * the question whether or not it can render buttons. This adds the one-tap
 * route on top for Telegram, and a channel without one still resolves the
 * gate through `/gate`.
 *
 * Extracted from the adapter setup so the glue (session lookup → send guard)
 * is unit-testable without an Inngest runtime, same shape as the skills
 * approval poster.
 */

import { buildGateKeyboard } from "../../../agent/pipeline/gate-keyboard.js";
import type { Transactor } from "../../../db/index.js";
import { logger } from "../../../logger.js";
import type { TransportStore } from "../../store/index.js";

export interface PostPipelineGateKeyboardEvent {
  runId: string;
  stageId: string;
  conversationId: string;
  pipelineName: string;
}

export type PipelineGateSendMessage = (
  chatId: number,
  text: string,
  opts: { reply_markup: ReturnType<typeof buildGateKeyboard> },
) => Promise<unknown>;

export type PostPipelineGateKeyboardResult =
  | { posted: true }
  | { posted: false; reason: "no_telegram_session" | "send_failed" };

export async function postPipelineGateKeyboard(args: {
  event: PostPipelineGateKeyboardEvent;
  channelId: string;
  runInTx: Transactor;
  transportStore: Pick<TransportStore, "getActiveSessionsForConversation">;
  sendMessage: PipelineGateSendMessage;
}): Promise<PostPipelineGateKeyboardResult> {
  const { event, channelId, runInTx, transportStore, sendMessage } = args;

  const sessions = await runInTx((tx) =>
    transportStore.getActiveSessionsForConversation(tx, event.conversationId),
  );
  const tgSession = sessions.find((s) => s.channelId === channelId);
  if (!tgSession) return { posted: false, reason: "no_telegram_session" };

  // Deliberately terse: the stage's own prompt is the message above this
  // one, and repeating it would make the gate read twice.
  const text = `⏸️ "${event.pipelineName}" — your decision on "${event.stageId}":`;

  try {
    await sendMessage(Number(tgSession.platformAddress), text, {
      reply_markup: buildGateKeyboard(event.runId),
    });
    return { posted: true };
  } catch (err) {
    // `retries: 0` on the registering function, so this is the end of the
    // line — log it, because "the buttons never appeared" is otherwise
    // indistinguishable from a gate that was never reached. The `/gate`
    // command still resolves it.
    logger.warn(
      { err, runId: event.runId, conversationId: event.conversationId },
      "telegram: failed to post pipeline gate keyboard — resolve with /gate",
    );
    return { posted: false, reason: "send_failed" };
  }
}
