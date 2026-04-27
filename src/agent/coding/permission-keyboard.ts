import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_PATTERN } from "../../util/uuid.js";

/**
 * Inline-keyboard helper for the tool-gate permission prompt. Pure: no
 * grammY runtime dependency — produces the JSON shape Telegram expects on
 * `reply_markup` so the adapter can pass it straight through.
 *
 * Three buttons:
 *
 * - **Allow once** — apply this decision to the current request only.
 *   Logged with scope=`once` for audit; future requests fall back through
 *   the policy.
 * - **Allow for task** — apply this decision and remember the canonical
 *   pattern (e.g. `Bash(git push origin *)`) so future matching requests
 *   in the same task auto-allow without re-prompting.
 * - **Deny** — reject this request. Logged with scope=`once`. The CLI
 *   surfaces the deny back to the model.
 *
 * No "Allow forever" / cross-task scope — that's `policy.ts` territory,
 * edited out-of-band by the user. (See slice3-plan decision 3.)
 */

export type PermissionAction = "allow_once" | "allow_task" | "deny";

const PREFIX = "perm";
const SEP = ":";
/**
 * Cap on requestId length encoded in `callback_data`. Telegram's
 * `callback_data` is bounded at 64 bytes; with a full UUID taskId (36
 * chars) and the `perm:`/`:`/action overhead, 16 chars is the largest
 * requestId-prefix that fits. Claude Code's `request_id`s are short
 * tokens (~10 chars) in practice, so this rarely truncates.
 */
const MAX_REQUEST_ID_LEN = 16;

const REQUEST_ID_PATTERN = "[A-Za-z0-9_-]{1,16}";
/**
 * Single-char wire codes — Telegram's 64-byte `callback_data` limit
 * doesn't fit the full action names with a max-length requestId. The
 * codes never reach the user; they're translated to the public
 * `PermissionAction` strings on parse.
 */
const ACTION_CODES = { o: "allow_once", t: "allow_task", d: "deny" } as const;
const ACTION_TO_CODE = { allow_once: "o", allow_task: "t", deny: "d" } as const;
const ACTION_PATTERN = "[otd]";
const PARSE_REGEX = new RegExp(
  `^${PREFIX}:(${UUID_PATTERN}):(${REQUEST_ID_PATTERN}):(${ACTION_PATTERN})$`,
);

export interface PermissionInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/**
 * Build the prompt keyboard. `requestIdShort` MUST be the same value the
 * orchestrator stamps into the `coding/task/permission-decision` waitForEvent
 * filter — round-tripped through Telegram unchanged.
 */
export function buildPermissionKeyboard(
  taskId: string,
  requestIdShort: string,
): PermissionInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Once", callback_data: encode(taskId, requestIdShort, "allow_once") },
        { text: "✅ Task", callback_data: encode(taskId, requestIdShort, "allow_task") },
        { text: "❌ Deny", callback_data: encode(taskId, requestIdShort, "deny") },
      ],
    ],
  };
}

export function encodePermissionCallback(
  taskId: string,
  requestIdShort: string,
  action: PermissionAction,
): string {
  return encode(taskId, requestIdShort, action);
}

function encode(taskId: string, requestIdShort: string, action: PermissionAction): string {
  return `${PREFIX}${SEP}${taskId}${SEP}${requestIdShort}${SEP}${ACTION_TO_CODE[action]}`;
}

/**
 * Truncate the full Claude Code `request_id` to the form used in
 * `callback_data`. Stable: same input always produces same output, so the
 * waitForEvent filter and the keyboard agree. Strips characters outside
 * `[A-Za-z0-9_-]` so the parse regex stays simple.
 *
 * For inputs that strip to empty (only emoji, only colons, etc.), derive
 * a deterministic hash-based id so two distinct malformed request ids
 * still produce distinct shortened forms. A constant placeholder would
 * alias them — a wait filtered on one's id could be unblocked by the
 * other's tap. Hash form starts with `un` (so it's visibly a fallback)
 * + 14 hex chars of SHA-256(input), totalling 16 chars — fits the
 * `[A-Za-z0-9_-]{1,16}` parse-regex bound.
 */
export function shortenRequestId(requestId: string): string {
  const safe = requestId.replace(/[^A-Za-z0-9_-]/g, "");
  if (safe.length === 0) {
    const h = createHash("sha256").update(requestId).digest("hex");
    return `un${h.slice(0, 14)}`;
  }
  return safe.slice(0, MAX_REQUEST_ID_LEN);
}

export interface ParsedPermissionCallback {
  taskId: string;
  requestIdShort: string;
  action: PermissionAction;
}

/** Returns null on malformed input — caller surfaces the error to the user. */
export function parsePermissionCallback(data: string): ParsedPermissionCallback | null {
  const m = PARSE_REGEX.exec(data);
  if (!m) return null;
  const code = m[3] as keyof typeof ACTION_CODES;
  return {
    taskId: m[1] as string,
    requestIdShort: m[2] as string,
    action: ACTION_CODES[code],
  };
}

/** Regex for grammY's `bot.callbackQuery(REGEX, ...)` registration. */
export const PERMISSION_CALLBACK_REGEX = new RegExp(
  `^${PREFIX}:${UUID_PATTERN}:${REQUEST_ID_PATTERN}:(${ACTION_PATTERN})$`,
);

export const ParsedPermissionCallbackSchema = z.object({
  taskId: z.string().regex(new RegExp(`^${UUID_PATTERN}$`)),
  requestIdShort: z.string().regex(new RegExp(`^${REQUEST_ID_PATTERN}$`)),
  action: z.enum(["allow_once", "allow_task", "deny"]),
});

/**
 * Translate a button action into the `(decision, scope)` pair the
 * decision log + CLI response use. Pure mapping — keeps the orchestrator
 * from re-deriving it.
 */
export function actionToDecision(action: PermissionAction): {
  decision: "allow" | "deny";
  scope: "once" | "task";
} {
  switch (action) {
    case "allow_once":
      return { decision: "allow", scope: "once" };
    case "allow_task":
      return { decision: "allow", scope: "task" };
    case "deny":
      return { decision: "deny", scope: "once" };
  }
}
