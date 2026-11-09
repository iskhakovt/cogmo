import { match } from "ts-pattern";
import { UUID_PATTERN } from "../util/uuid.js";

/**
 * Inline-keyboard helpers for the skills deploy-outcome messages. Mirrors
 * `src/agent/coding/plan-keyboard.ts` — pure, no grammY runtime dep, produces
 * the JSON shape Telegram expects on `reply_markup`. Posted by the
 * per-channel Telegram Inngest function on `skills/deploy/outcome`: Approve /
 * Deny on a pending deploy, keyed by its `skill_deploys.id`; Disable on a live
 * one, keyed by its `skills.id`, and, when the deploy is an edit, Roll back,
 * keyed by its `skill_deploys.id`.
 */

export type SkillsDeployAction = "approve" | "deny" | "disable" | "rollback";

const PREFIX = "skill";
const SEP = ":";

/**
 * Mutable arrays match grammY's Bot API types — see plan-keyboard.ts for the
 * defensive-clone reasoning. Same constraint here.
 */
export interface SkillsInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** Approve / Deny for the pending deploy `pendingId`. */
export function buildSkillsApprovalKeyboard(pendingId: string): SkillsInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: encodeSkillsDeployCallback(pendingId, "approve") },
        { text: "❌ Deny", callback_data: encodeSkillsDeployCallback(pendingId, "deny") },
      ],
    ],
  };
}

/**
 * Disable for the live skill `skillId`, and Roll back for the deploy
 * `rollbackDeployId`, an edit whose prior version it restores; null for a
 * first deploy, which has none.
 */
export function buildSkillsLiveKeyboard(args: {
  skillId: string;
  rollbackDeployId: string | null;
}): SkillsInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🚫 Disable", callback_data: encodeSkillsDeployCallback(args.skillId, "disable") },
        ...(args.rollbackDeployId === null
          ? []
          : [
              {
                text: "↩️ Roll back",
                callback_data: encodeSkillsDeployCallback(args.rollbackDeployId, "rollback"),
              },
            ]),
      ],
    ],
  };
}

/** `id` is the deploy's id for approve, deny and rollback, the skill's for disable. */
function encodeSkillsDeployCallback(id: string, action: SkillsDeployAction): string {
  // Telegram limit: callback_data ≤ 64 bytes. `skill:` (6) + UUID (36) + `:` (1)
  // + longest action `rollback` (8) = 51 bytes. Comfortable headroom.
  return `${PREFIX}${SEP}${id}${SEP}${action}`;
}

const PARSE_REGEX = new RegExp(`^skill:(${UUID_PATTERN}):(approve|deny|disable|rollback)$`);

export type ParsedSkillsDeployCallback =
  | { action: "approve" | "deny"; pendingId: string }
  | { action: "disable"; skillId: string }
  | { action: "rollback"; deployId: string };

/** Returns null on malformed input — caller decides how to surface. */
export function parseSkillsDeployCallback(data: string): ParsedSkillsDeployCallback | null {
  const m = PARSE_REGEX.exec(data);
  const id = m?.[1];
  if (id === undefined) return null;
  return match(m?.[2])
    .returnType<ParsedSkillsDeployCallback | null>()
    .with("approve", "deny", (action) => ({ action, pendingId: id }))
    .with("disable", () => ({ action: "disable", skillId: id }))
    .with("rollback", () => ({ action: "rollback", deployId: id }))
    .otherwise(() => null);
}

/** Regex for grammY's `bot.callbackQuery(REGEX, ...)` registration. */
export const SKILLS_DEPLOY_CALLBACK_REGEX = new RegExp(
  `^skill:${UUID_PATTERN}:(approve|deny|disable|rollback)$`,
);
