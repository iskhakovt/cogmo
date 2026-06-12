import { match } from "ts-pattern";
import type { BoundaryResolvedData, BoundaryResolvedReason } from "../../../inngest/events.js";
import { logger } from "../../../logger.js";

/**
 * Final text the idle-boundary prompt is rewritten to once its hold resolves.
 * Echoes the button glyphs (`↶` resume / `✦` fresh) so the settled message
 * reads as the outcome of the choice — by tap, by command, or by timeout —
 * rather than the open question it started as. `.exhaustive()` makes an
 * unmapped future reason a compile error.
 */
export function boundaryOutcomeText(reason: BoundaryResolvedReason): string {
  return (
    match(reason)
      .with("user_resume", () => "↶ Picking up where we left off.")
      // `/resume <alias>` during a hold can target a conversation other than the
      // one the prompt referenced, so "where we left off" wouldn't be literally
      // true here.
      .with("user_resume_target", () => "↶ Resuming that conversation.")
      .with("user_fresh", "user_command", () => "✦ Started a fresh chat.")
      .with("waiter_timeout", () => "✦ No reply — started a fresh chat.")
      .exhaustive()
  );
}

/**
 * Edits a previously-sent message in place, clearing any inline keyboard. The
 * adapter binds this to `bot.api.editMessageText`; the empty `inline_keyboard`
 * is how Telegram removes the prompt's buttons.
 */
export type EditBoundaryPromptMessage = (
  chatId: string,
  messageId: number,
  text: string,
  opts: { reply_markup: { inline_keyboard: never[] } },
) => Promise<unknown>;

export type EditResolvedBoundaryPromptResult =
  | { edited: true }
  | { edited: false; reason: "other_channel" | "edit_failed" };

/**
 * Per-channel handler for `conversation/boundary/resolved`. Rewrites the
 * idle-boundary prompt message to its outcome and strips the inline keyboard,
 * so a resolved hold never lingers as an unanswered question with stale
 * buttons — whether it resolved by button tap, `/new` / `/resume` during the
 * hold, or waiter timeout. The timeout path is the one that can't clean up
 * itself: no channel callback runs, so this listener is its only chance.
 *
 * Extracted from the Telegram adapter setup so the glyph mapping + send guard
 * is unit-testable without an Inngest runtime. Best-effort: a deleted prompt
 * or a rejected edit (message too old, bot blocked) logs at warn and returns
 * `edit_failed` rather than throwing — the resolution already happened and is
 * not undone by a failed edit.
 */
export async function editResolvedBoundaryPrompt(args: {
  event: BoundaryResolvedData;
  channelId: string;
  editMessageText: EditBoundaryPromptMessage;
}): Promise<EditResolvedBoundaryPromptResult> {
  const { event, channelId, editMessageText } = args;

  // `boundary/resolved` fans out to every channel's listener; act only on the
  // prompt this channel actually posted.
  if (event.channelId !== channelId) {
    return { edited: false, reason: "other_channel" };
  }

  try {
    await editMessageText(
      event.platformAddress,
      Number(event.promptMessageId),
      boundaryOutcomeText(event.reason),
      { reply_markup: { inline_keyboard: [] } },
    );
    return { edited: true };
  } catch (err) {
    logger.warn(
      { err, boundaryId: event.boundaryId, promptMessageId: event.promptMessageId },
      "telegram: failed to edit resolved boundary prompt",
    );
    return { edited: false, reason: "edit_failed" };
  }
}
