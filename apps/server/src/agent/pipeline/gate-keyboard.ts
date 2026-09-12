import { UUID_PATTERN } from "../../util/uuid.js";

/**
 * Inline-keyboard helper for a pipeline gate checkpoint. Pure: produces the
 * JSON shape Telegram expects on `reply_markup`, with no grammY dependency.
 *
 * Approve / Cancel only. "Revise" means re-running the prior stage with the
 * user's feedback, which is a back-edge — it arrives with loop execution.
 *
 * The callback carries only the run id. The stage and iteration the gate
 * belongs to are read from the run row at tap time, which keeps the payload
 * inside Telegram's 64-byte `callback_data` limit and means a tap on a
 * stale keyboard resolves against wherever the run actually is.
 */

export type PipelineGateAction = "approve" | "cancel";

export interface PipelineGateInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export function buildPipelineGateKeyboard(runId: string): PipelineGateInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: encodePipelineGateCallback(runId, "approve") },
        { text: "❌ Cancel run", callback_data: encodePipelineGateCallback(runId, "cancel") },
      ],
    ],
  };
}

export function encodePipelineGateCallback(runId: string, action: PipelineGateAction): string {
  // `pipe:` (5) + UUID (36) + `:` (1) + `approve` (7) = 49 bytes.
  return `pipe:${runId}:${action}`;
}

/** Regex for grammY's `bot.callbackQuery(REGEX, ...)` registration. */
export const PIPELINE_GATE_CALLBACK_REGEX = new RegExp(`^pipe:${UUID_PATTERN}:(approve|cancel)$`);

const PARSE_REGEX = new RegExp(`^pipe:(${UUID_PATTERN}):(approve|cancel)$`);

export interface ParsedPipelineGateCallback {
  runId: string;
  action: PipelineGateAction;
}

/** Returns null on malformed input — the caller decides how to surface it. */
export function parsePipelineGateCallback(data: string): ParsedPipelineGateCallback | null {
  const m = PARSE_REGEX.exec(data);
  const runId = m?.[1];
  const action = m?.[2];
  if (runId === undefined || (action !== "approve" && action !== "cancel")) return null;
  return { runId, action };
}
