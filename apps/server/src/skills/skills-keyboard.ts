import { z } from "zod";
import { UUID_PATTERN } from "../util/uuid.js";

/**
 * Inline-keyboard helper for the skills-deploy approval message. Mirrors
 * `src/agent/coding/plan-keyboard.ts` — pure, no grammY runtime dep, produces
 * the JSON shape Telegram expects on `reply_markup`. Posted by the per-channel
 * Telegram Inngest function on `skills/deploy/approval-requested`.
 */

export type SkillsApprovalAction = "approve" | "deny";

const PREFIX = "skill";
const SEP = ":";

/**
 * Mutable arrays match grammY's Bot API types — see plan-keyboard.ts for the
 * defensive-clone reasoning. Same constraint here.
 */
export interface SkillsApprovalInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export function buildSkillsApprovalKeyboard(pendingId: string): SkillsApprovalInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: encodeSkillsApprovalCallback(pendingId, "approve") },
        { text: "❌ Deny", callback_data: encodeSkillsApprovalCallback(pendingId, "deny") },
      ],
    ],
  };
}

export function encodeSkillsApprovalCallback(
  pendingId: string,
  action: SkillsApprovalAction,
): string {
  // Telegram limit: callback_data ≤ 64 bytes. `skill:` (6) + UUID (36) + `:` (1)
  // + longest action `approve` (7) = 50 bytes. Comfortable headroom.
  return `${PREFIX}${SEP}${pendingId}${SEP}${action}`;
}

const PARSE_REGEX = new RegExp(`^skill:(${UUID_PATTERN}):(approve|deny)$`);

export interface ParsedSkillsApprovalCallback {
  pendingId: string;
  action: SkillsApprovalAction;
}

/** Returns null on malformed input — caller decides how to surface. */
export function parseSkillsApprovalCallback(data: string): ParsedSkillsApprovalCallback | null {
  const m = PARSE_REGEX.exec(data);
  if (!m) return null;
  return { pendingId: m[1] as string, action: m[2] as SkillsApprovalAction };
}

/** Regex for grammY's `bot.callbackQuery(REGEX, ...)` registration. */
export const SKILLS_APPROVAL_CALLBACK_REGEX = new RegExp(`^skill:${UUID_PATTERN}:(approve|deny)$`);

/** Zod schema for the parsed shape. */
export const ParsedSkillsApprovalCallbackSchema = z.object({
  pendingId: z.string().regex(new RegExp(`^${UUID_PATTERN}$`)),
  action: z.enum(["approve", "deny"]),
});
