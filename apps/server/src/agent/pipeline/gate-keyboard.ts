/**
 * Inline-keyboard helper for a pipeline gate. Pure: no grammY runtime
 * dependency, just the JSON shape Telegram expects on `reply_markup` —
 * same contract as the coding-delegation plan keyboard, which the Telegram
 * adapter passes straight to the Bot API.
 *
 * The keyboard is one of two routes into `Transport.pipelines.resolveGate`;
 * the other is the `/gate` command, which every channel has. Both are
 * identity-checked in the same place, and no model sits between the user's
 * decision and the transition.
 */

import { z } from "zod";
import { UUID_PATTERN } from "../../util/uuid.js";

export type GateCallbackAction = "approve" | "revise" | "cancel";

const PREFIX = "pgate";
const SEP = ":";

/**
 * Mutable arrays — grammY's Bot API types require `InlineKeyboardButton[][]`
 * (not readonly) at the wire boundary.
 */
export interface GateInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export function buildGateKeyboard(runId: string): GateInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: encodeGateCallback(runId, "approve") },
        { text: "✏️ Revise", callback_data: encodeGateCallback(runId, "revise") },
        { text: "❌ Cancel", callback_data: encodeGateCallback(runId, "cancel") },
      ],
    ],
  };
}

export function encodeGateCallback(runId: string, action: GateCallbackAction): string {
  // Telegram limit: callback_data ≤ 64 bytes. `pgate:` (6) + UUID (36) +
  // `:` (1) + longest action `approve` (7) = 50 bytes.
  return `${PREFIX}${SEP}${runId}${SEP}${action}`;
}

const PARSE_REGEX = new RegExp(`^pgate:(${UUID_PATTERN}):(approve|revise|cancel)$`);

export interface ParsedGateCallback {
  runId: string;
  action: GateCallbackAction;
}

/** Returns null on malformed input — caller decides how to surface. */
export function parseGateCallback(data: string): ParsedGateCallback | null {
  const m = PARSE_REGEX.exec(data);
  if (!m) return null;
  return { runId: m[1] as string, action: m[2] as GateCallbackAction };
}

/** Regex for grammY's `bot.callbackQuery(REGEX, ...)` registration. */
export const GATE_CALLBACK_REGEX = new RegExp(`^pgate:${UUID_PATTERN}:(approve|revise|cancel)$`);

/** Zod schema for the parsed shape — runtime guard at the transport edge. */
export const ParsedGateCallbackSchema = z.object({
  runId: z.string().regex(new RegExp(`^${UUID_PATTERN}$`)),
  action: z.enum(["approve", "revise", "cancel"]),
});

/**
 * Parse a `/gate <action> [feedback]` command body. Channel-agnostic: the
 * Telegram command handler and the Direct adapter both route through this,
 * so the accepted grammar cannot drift between channels.
 */
export function parseGateCommand(
  body: string,
): { action: GateCallbackAction; feedback?: string } | null {
  const trimmed = body.trim();
  const match = /^(approve|revise|cancel)\b\s*([\s\S]*)$/i.exec(trimmed);
  if (!match) return null;
  const action = match[1]?.toLowerCase() as GateCallbackAction;
  const feedback = match[2]?.trim() ?? "";
  return feedback.length > 0 ? { action, feedback } : { action };
}
