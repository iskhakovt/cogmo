import type { Transactor } from "../../../db/index.js";
import { logger } from "../../../logger.js";
import { buildSkillsApprovalKeyboard } from "../../../skills/skills-keyboard.js";
import type { SkillStore } from "../../../skills/store/index.js";
import type { TransportStore } from "../../store/index.js";

/**
 * Approval-keyboard prompt body — surfaces what the user is approving without
 * requiring the manifest to be on the wire. Plain text on purpose: skill
 * names + effect labels are manifest-author-controlled (which is the agent
 * itself, but still untrusted); a Markdown parse failure would 400 the whole
 * send. Same reasoning as the permission-requested message.
 */
function buildApprovalText(args: { skillName: string; effects: string; gitSha: string }): string {
  return (
    `🛡️ Skill deploy awaiting approval: ${args.skillName}\n\n` +
    `Declared effects: ${args.effects}\n` +
    `Commit: ${args.gitSha.slice(0, 7)}\n\n` +
    `Approve to advance main; deny to leave the deploy pending. ` +
    `You can also re-register a different version.`
  );
}

export interface PostSkillsApprovalKeyboardEvent {
  pendingId: string;
  skillName: string;
  gitSha: string;
  conversationId: string;
}

export type SkillsApprovalSendMessage = (
  chatId: number,
  text: string,
  opts: { reply_markup: ReturnType<typeof buildSkillsApprovalKeyboard> },
) => Promise<unknown>;

export type PostSkillsApprovalKeyboardResult =
  | { posted: true }
  | { posted: false; reason: "no_telegram_session" | "send_failed" };

/**
 * Per-channel handler for `skills/deploy/approval-requested`. Extracted from
 * the Telegram adapter setup so the glue (session lookup → deploy/skill
 * fetch → message construction → send guard) is unit-testable without an
 * Inngest runtime.
 *
 * Returns a discriminated result so the caller (the Inngest function body)
 * can surface the outcome on the function return for observability.
 */
export async function postSkillsApprovalKeyboard(args: {
  event: PostSkillsApprovalKeyboardEvent;
  channelId: string;
  runInTx: Transactor;
  skillStore: SkillStore;
  transportStore: TransportStore;
  sendMessage: SkillsApprovalSendMessage;
}): Promise<PostSkillsApprovalKeyboardResult> {
  const { event, channelId, runInTx, skillStore, transportStore, sendMessage } = args;

  const sessions = await runInTx((tx) =>
    transportStore.getActiveSessionsForConversation(tx, event.conversationId),
  );
  const tgSession = sessions.find((s) => s.channelId === channelId);
  if (!tgSession) {
    return { posted: false, reason: "no_telegram_session" };
  }

  // Fetch the deploy + skill row to surface declared effects on the prompt.
  // Either lookup returning null falls back to "(none declared)" rather than
  // failing the post — the user can still approve / deny based on the
  // pendingId + commit shown.
  const deploy = await skillStore.getDeployById(event.pendingId);
  const skill = deploy ? await skillStore.getSkillById(deploy.skillId) : null;
  const effects = skill && skill.effects.length > 0 ? skill.effects.join(", ") : "(none declared)";

  const keyboard = buildSkillsApprovalKeyboard(event.pendingId);
  const text = buildApprovalText({ skillName: event.skillName, effects, gitSha: event.gitSha });

  // Guard the send: a closed chat / blocked bot / network blip shouldn't
  // take the function down silently. retries=0 on the Inngest function
  // means there's no automatic retry — the CLI fallback
  // (`cogmo skills approve <pendingId>`) is the documented graceful
  // degradation. Log so debugging "the keyboard never appeared" doesn't
  // require correlating with the Telegram side.
  try {
    await sendMessage(Number(tgSession.platformAddress), text, { reply_markup: keyboard });
    return { posted: true };
  } catch (err) {
    logger.warn(
      {
        err,
        pendingId: event.pendingId,
        skillName: event.skillName,
        conversationId: event.conversationId,
      },
      "telegram: failed to post skill approval keyboard — approve via CLI",
    );
    return { posted: false, reason: "send_failed" };
  }
}
