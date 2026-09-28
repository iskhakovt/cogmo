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
function buildApprovalText(args: {
  skillName: string;
  effects: string;
  gitSha: string;
  schedule: string | null | undefined;
}): string {
  // `undefined`: an event older than the field, so whether it is scheduled
  // is unknown; the rule is still stated.
  const runAs =
    args.schedule === null
      ? ""
      : args.schedule === undefined
        ? "If it runs on a schedule, its runs will run as whoever approves.\n"
        : `Schedule: ${args.schedule} — its runs will run as whoever approves.\n`;
  return (
    `🛡️ Skill deploy awaiting approval: ${args.skillName}\n\n` +
    `Declared effects: ${args.effects}\n` +
    runAs +
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
  /** The pending manifest's cron schedule, or null; absent on older events. */
  schedule?: string | null | undefined;
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
  const { event, channelId, skillStore, runInTx, transportStore, sendMessage } = args;

  const sessions = await runInTx((tx) =>
    transportStore.getActiveSessionsForConversation(tx, event.conversationId),
  );
  const tgSession = sessions.find((s) => s.channelId === channelId);
  if (!tgSession) {
    return { posted: false, reason: "no_telegram_session" };
  }

  // The pending deploy's own declared effects — for an upgrade the skills row
  // is still the live version. A missing deploy falls back to "(none
  // declared)" rather than failing the post; the user can still approve or
  // deny from the pendingId + commit shown.
  const deploy = await runInTx((tx) => skillStore.getDeployById(tx, event.pendingId));
  const declared = deploy?.classifierLog.declared_effects ?? [];
  const effects = declared.length > 0 ? declared.join(", ") : "(none declared)";

  const keyboard = buildSkillsApprovalKeyboard(event.pendingId);
  const text = buildApprovalText({
    skillName: event.skillName,
    effects,
    gitSha: event.gitSha,
    schedule: event.schedule,
  });

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
