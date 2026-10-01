/** Inline-keyboard taps: the boundary prompt, `/sessions`, and the plan, pipeline-gate and skills-approval keyboards. */

import type { Bot } from "grammy";
import { PLAN_CALLBACK_REGEX, parsePlanCallback } from "../../../agent/coding/plan-keyboard.js";
import {
  PIPELINE_GATE_CALLBACK_REGEX,
  parsePipelineGateCallback,
} from "../../../agent/pipeline/gate-keyboard.js";
import { logger } from "../../../logger.js";
import {
  parseSkillsApprovalCallback,
  SKILLS_APPROVAL_CALLBACK_REGEX,
} from "../../../skills/skills-keyboard.js";
import type { Transport } from "../../transport.js";
import {
  handlePipelineGateCallback,
  handlePlanCallback,
  handleSkillsApprovalCallback,
} from "./commands/keyboard-callbacks.js";
import { toCmdCtx } from "./commands/reply.js";
import { handleResumeCallback } from "./commands/sessions.js";

/**
 * Regex matched against `callback_data` for boundary prompt taps. UUIDv7
 * format (`[0-9a-f-]{36}`) keeps the pattern unambiguous against other
 * `…:…` callback shapes (`resume:`, `plan:`, `perm:`, `skill:`).
 *
 * **Budget:** Telegram caps `callback_data` at 64 bytes. The longest shape
 * here is `boundary:<36-char-uuid>:resume` = 51 bytes, leaving ~13 bytes
 * of headroom. Adding a third cofactor (e.g. a profile id) would blow the
 * cap; truncate the boundary id to its UUIDv7 timestamp prefix or move to
 * a callback-id table before extending this shape.
 */
const BOUNDARY_CALLBACK_REGEX = /^boundary:([0-9a-f-]{36}):(resume|fresh)$/;

export function registerCallbackQueries(bot: Bot, transport: Transport): void {
  // Boundary prompt taps — callback_data = "boundary:<boundaryId>:<resume|fresh>"
  bot.callbackQuery(BOUNDARY_CALLBACK_REGEX, async (ctx) => {
    const boundaryId = ctx.match?.[1];
    const action = ctx.match?.[2];
    if (!boundaryId || !action) return;

    const isResume = action === "resume";
    const result = await transport.boundary.resolve({
      boundaryId,
      choice: isResume ? { kind: "resume-prior" } : { kind: "fresh" },
      reason: isResume ? "user_resume" : "user_fresh",
    });

    try {
      // Drop the keyboard so the buttons can't be tapped twice. Same pattern
      // as plan / permission / skills-approval callback handlers.
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("message is not modified")) {
        logger.warn({ err }, "telegram: failed to clear boundary keyboard");
      }
    }

    if (result.isErr()) {
      const code = result.error.code;
      const toast = code === "boundary_not_found" ? "Already resolved" : "Resolution failed";
      await ctx.answerCallbackQuery({ text: toast });
      return;
    }

    await ctx.answerCallbackQuery({
      text: isResume ? "Picking up where we left off." : "Starting fresh.",
    });
  });

  // Inline keyboard taps from /sessions list — callback_data = "resume:<alias|conversationId>"
  bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
    const target = ctx.match?.[1];
    if (!target) return;
    await handleResumeCallback(transport, toCmdCtx(ctx, ""), target);
    await ctx.answerCallbackQuery();
  });

  // Plan keyboard: Approve / Revise / Cancel — callback_data = "plan:<taskId>:<action>"
  bot.callbackQuery(PLAN_CALLBACK_REGEX, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const fromId = ctx.from?.id;
    if (!data || fromId === undefined) return;
    const parsed = parsePlanCallback(data);
    if (!parsed) return;

    const outcome = await handlePlanCallback(transport, parsed, String(fromId));

    // Edit the original plan message: replace its body with the outcome
    // text and clear the keyboard so the buttons don't linger after the
    // tap. Telegram returns 400 "message is not modified" on no-op edits;
    // ignore. Failure to edit (e.g. message deleted by the user) shouldn't
    // block the rest of the outcome.
    try {
      // Pass an empty inline_keyboard rather than reply_markup: undefined.
      // grammY's strict-optional types reject `undefined` for reply_markup,
      // and Telegram accepts an empty keyboard array as "remove the
      // existing keyboard".
      await ctx.editMessageText(outcome.editText, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("message is not modified")) {
        logger.warn({ err }, "telegram: failed to edit plan message");
      }
    }
    if (outcome.followUp) {
      await ctx.reply(outcome.followUp);
    }
    await ctx.answerCallbackQuery({ text: outcome.toast });
  });

  // Pipeline gate keyboard: Approve / Cancel — callback_data = "pipe:<runId>:<action>:<token>"
  bot.callbackQuery(PIPELINE_GATE_CALLBACK_REGEX, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const fromId = ctx.from?.id;
    if (!data || fromId === undefined) return;
    const parsed = parsePipelineGateCallback(data);
    if (!parsed) return;

    const outcome = await handlePipelineGateCallback(transport, parsed, String(fromId));
    if (outcome.clearKeyboard) {
      try {
        await ctx.editMessageText(outcome.editText, { reply_markup: { inline_keyboard: [] } });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("message is not modified")) {
          logger.warn({ err }, "telegram: failed to edit pipeline gate message");
        }
      }
    }
    await ctx.answerCallbackQuery({ text: outcome.toast });
  });

  // Skills approval keyboard: Approve / Deny — callback_data =
  // "skill:<pendingId>:<approve|deny>"
  bot.callbackQuery(SKILLS_APPROVAL_CALLBACK_REGEX, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const fromId = ctx.from?.id;
    if (!data || fromId === undefined) return;
    const parsed = parseSkillsApprovalCallback(data);
    if (!parsed) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      // No chat, no conversation to act from; answer so the button stops spinning.
      await ctx.answerCallbackQuery({ text: "Open this approval in its chat." });
      return;
    }

    const outcome = await handleSkillsApprovalCallback(
      transport,
      parsed,
      String(fromId),
      String(chatId),
    );
    try {
      await ctx.editMessageText(outcome.editText, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("message is not modified")) {
        logger.warn({ err }, "telegram: failed to edit skills approval message");
      }
    }
    await ctx.answerCallbackQuery({ text: outcome.toast });
  });
}
