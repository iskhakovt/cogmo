/** `/skills`, `/disable`, `/enable`: the skill library. */

import type { Transport } from "../../../transport.js";
import { errorMessage, type TelegramCommandContext } from "./reply.js";

const DISABLE_USAGE = "Usage: /disable <name>";
const ENABLE_USAGE = "Usage: /enable <name>";

/**
 * `/skills` — list all skills (enabled + disabled), sorted by name. The
 * disabled marker is the whole point: an operator who deregistered a
 * skill needs to see it here to remember the name before `/enable`.
 */
export async function handleSkills(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const res = await transport.skills.list(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.length === 0) {
    await ctx.reply(
      "No skills registered. Use `cogmo skills register <branch>` from the CLI or the agent's `register_skill` tool.",
    );
    return;
  }
  // Compact one-line-per-skill rendering. `gitSha` shortened to 7 chars
  // for readability; the full sha is rarely useful at the chat surface.
  const lines = res.value.map((s) => {
    const marker = s.disabled ? " (disabled)" : "";
    return `${s.name} [${s.tier}/${s.riskTier}] @ ${s.gitSha.slice(0, 7)}${marker}`;
  });
  await ctx.reply(`Skills:\n${lines.join("\n")}`);
}

/**
 * `/disable <name>` — soft-disable a skill. Hides it from the LLM tool
 * list and any cron-driven invocations on the next refresh. Audit trail
 * preserved; `/enable <name>` undoes it.
 */
export async function handleDisable(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const name = ctx.match?.trim();
  if (!name) {
    await ctx.reply(DISABLE_USAGE);
    return;
  }
  const handle = String(ctx.from.id);
  const res = await transport.skills.disable(handle, name);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(`Skill "${res.value.name}" disabled.`);
}

/**
 * `/enable <name>` — re-activate a previously-disabled skill. Idempotent
 * on already-enabled rows. Refused for skills whose current sha was
 * never live (denied-on-first-deploy guard); operator must re-register
 * the source through the approval flow instead.
 */
export async function handleEnable(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const name = ctx.match?.trim();
  if (!name) {
    await ctx.reply(ENABLE_USAGE);
    return;
  }
  const handle = String(ctx.from.id);
  const res = await transport.skills.enable(handle, name, String(ctx.chat.id));
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.alreadyEnabled) {
    await ctx.reply(`Skill "${res.value.name}" is already enabled.`);
  } else {
    // Enabling moves a schedule onto the enabler; say so, as the approval prompt does.
    const runAs =
      res.value.schedule === undefined
        ? ""
        : ` Its schedule ${res.value.schedule} now runs as you.`;
    await ctx.reply(`Skill "${res.value.name}" enabled.${runAs}`);
  }
}
