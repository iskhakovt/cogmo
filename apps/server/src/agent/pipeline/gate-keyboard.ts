import { createHash } from "node:crypto";
import { UUID_PATTERN } from "../../util/uuid.js";

/**
 * Inline-keyboard helper for a pipeline gate checkpoint. Pure: produces the
 * JSON shape Telegram expects on `reply_markup`, with no grammY dependency.
 *
 * Approve / Cancel only. "Revise" means re-running the prior stage with the
 * user's feedback, which is a back-edge — it arrives with loop execution.
 *
 * The callback carries the run id plus a short token of the gate key
 * (`${runId}:${stageId}:${iteration}`). A stage id doesn't fit Telegram's
 * 64-byte `callback_data`; the token does, and it lets the tap handler refuse
 * buttons left over from an earlier gate of the same run instead of applying
 * them to whichever gate the run is parked on now.
 */

export type PipelineGateAction = "approve" | "cancel";

export interface PipelineGateInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** First 8 hex chars of SHA-256 over the gate key — identifies one checkpoint within a run. */
export function gateToken(gateKey: string): string {
  return createHash("sha256").update(gateKey).digest("hex").slice(0, 8);
}

export function buildPipelineGateKeyboard(
  runId: string,
  gateKey: string,
): PipelineGateInlineKeyboardMarkup {
  const token = gateToken(gateKey);
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: encodePipelineGateCallback(runId, "approve", token) },
        {
          text: "❌ Cancel run",
          callback_data: encodePipelineGateCallback(runId, "cancel", token),
        },
      ],
    ],
  };
}

export function encodePipelineGateCallback(
  runId: string,
  action: PipelineGateAction,
  token: string,
): string {
  // `pipe:` (5) + UUID (36) + `:` (1) + `approve` (7) + `:` (1) + token (8) = 58 bytes.
  return `pipe:${runId}:${action}:${token}`;
}

/** Regex for grammY's `bot.callbackQuery(REGEX, ...)` registration. */
export const PIPELINE_GATE_CALLBACK_REGEX = new RegExp(
  `^pipe:${UUID_PATTERN}:(approve|cancel):[0-9a-f]{8}$`,
);

const PARSE_REGEX = new RegExp(`^pipe:(${UUID_PATTERN}):(approve|cancel):([0-9a-f]{8})$`);

export interface ParsedPipelineGateCallback {
  runId: string;
  action: PipelineGateAction;
  token: string;
}

/** Returns null on malformed input — the caller decides how to surface it. */
export function parsePipelineGateCallback(data: string): ParsedPipelineGateCallback | null {
  const m = PARSE_REGEX.exec(data);
  const runId = m?.[1];
  const action = m?.[2];
  const token = m?.[3];
  if (runId === undefined || token === undefined) return null;
  if (action !== "approve" && action !== "cancel") return null;
  return { runId, action, token };
}
