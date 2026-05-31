import { z } from "zod";
import { UUID_PATTERN } from "../../util/uuid.js";

/**
 * Inline-keyboard helper for the plan-approval message. Pure: no grammY
 * runtime dependency, just produces the JSON shape Telegram expects on
 * `reply_markup`. The Telegram adapter passes this object straight to the
 * Bot API.
 */

export type PlanCallbackAction = "approve" | "revise" | "cancel";

const PREFIX = "plan";
const SEP = ":";

/**
 * `approve` / `revise` / `cancel`. Stable codes (not button text) so future
 * label tweaks don't invalidate in-flight callback_data on user phones.
 *
 * Mutable arrays — grammY's Bot API types require `InlineKeyboardButton[][]`
 * (not readonly) at the wire boundary. Keep this shape compatible so the
 * Telegram adapter doesn't need a defensive clone or `as` cast on every
 * send.
 */
export interface PlanInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export function buildPlanKeyboard(taskId: string): PlanInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: encodePlanCallback(taskId, "approve") },
        { text: "✏️ Revise", callback_data: encodePlanCallback(taskId, "revise") },
        { text: "❌ Cancel", callback_data: encodePlanCallback(taskId, "cancel") },
      ],
    ],
  };
}

export function encodePlanCallback(taskId: string, action: PlanCallbackAction): string {
  // Telegram limit: callback_data ≤ 64 bytes. `plan:` (5) + UUID (36) + `:` (1) +
  // longest action `approve` (7) = 49 bytes. Headroom for a future trailing tag.
  return `${PREFIX}${SEP}${taskId}${SEP}${action}`;
}

// Rejecting malformed callback_data via the shared UUID pattern saves a
// DB round-trip and keeps the Telegram callback layer honest about what
// it accepts.
const PARSE_REGEX = new RegExp(`^plan:(${UUID_PATTERN}):(approve|revise|cancel)$`);

export interface ParsedPlanCallback {
  taskId: string;
  action: PlanCallbackAction;
}

/** Returns null on malformed input — caller decides how to surface. */
export function parsePlanCallback(data: string): ParsedPlanCallback | null {
  const m = PARSE_REGEX.exec(data);
  if (!m) return null;
  return { taskId: m[1] as string, action: m[2] as PlanCallbackAction };
}

/** Regex for grammY's `bot.callbackQuery(REGEX, ...)` registration. */
export const PLAN_CALLBACK_REGEX = new RegExp(`^plan:${UUID_PATTERN}:(approve|revise|cancel)$`);

/** Zod schema for the parsed shape — handy for tests + future runtime guards. */
export const ParsedPlanCallbackSchema = z.object({
  taskId: z.string().regex(new RegExp(`^${UUID_PATTERN}$`)),
  action: z.enum(["approve", "revise", "cancel"]),
});
