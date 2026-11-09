/** `/skills`, `/disable`, `/enable`: the skill library. */

import { match } from "ts-pattern";
import type { SkillsMirrorView } from "../../../../skills/runner.js";
import type { Transport } from "../../../transport.js";
import { packTelegramMessages } from "../message-limit.js";
import { errorMessage, type TelegramCommandContext } from "./reply.js";

const DISABLE_USAGE = "Usage: /disable <name>";
const ENABLE_USAGE = "Usage: /enable <name>";

/**
 * `/skills` — list all skills (enabled + disabled), sorted by name. The
 * disabled marker is the whole point: an operator who deregistered a
 * skill needs to see it here to remember the name before `/enable`. A
 * deploy awaiting approval shows on its skill's line with its full id,
 * which the owner pastes into `cogmo skills approve <id>`.
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
  const mirror = await transport.skills.mirrorStatus(handle);
  const remote = mirror.isOk() && mirror.value !== null ? mirrorLine(mirror.value) : null;
  if (res.value.length === 0) {
    const none =
      "No skills registered. Use `cogmo skills register <branch>` from the CLI or the agent's `register_skill` tool.";
    await ctx.reply(remote === null ? none : `${none}\n${remote}`);
    return;
  }
  // Compact one-line-per-skill rendering. `gitSha` shortened to 7 chars
  // for readability; the full sha is rarely useful at the chat surface.
  const lines = res.value.map((s) => {
    const marker = s.disabled ? " (disabled)" : "";
    // A first deploy replaces no live version, so there is no sha to show beside the pending one.
    const pending =
      s.pendingDeploy === null
        ? ""
        : s.pendingDeploy.priorGitSha === null
          ? ` — pending approval ${s.pendingDeploy.gitSha.slice(0, 7)} (first deploy), id ${s.pendingDeploy.id}`
          : ` — pending approval ${s.pendingDeploy.priorGitSha.slice(0, 7)} → ${s.pendingDeploy.gitSha.slice(0, 7)}, id ${s.pendingDeploy.id}`;
    return `${s.name} [${s.tier}/${s.riskTier}] @ ${s.gitSha.slice(0, 7)}${marker}${pending}`;
  });
  // One message when it fits; otherwise split between skills, so a pending
  // deploy id is never cut.
  for (const part of packTelegramMessages([
    "Skills:",
    ...lines,
    ...(remote === null ? [] : [remote]),
  ])) {
    await ctx.reply(part);
  }
}

/**
 * The skills remote's lag, for the listing; null while it is synced. A
 * diverged remote turns a plain push away as a non-fast-forward, and the bare
 * repo keeps no remote-tracking ref, so the lease names the sha the owner
 * checked.
 */
function mirrorLine(mirror: SkillsMirrorView): string | null {
  return match(mirror.status)
    .with("synced", () => null)
    .with(
      "behind",
      () =>
        `Skills remote: behind local main${mirror.lastFailure === null ? "" : ` (last push: ${mirror.lastFailure})`}; it is pushed every 10 minutes.`,
    )
    .with(
      "diverged",
      () =>
        "Skills remote: diverged from local main. Check what its main holds (`git -C $COGMO_SKILLS_PATH ls-remote origin main`), then push local main over it, as an identity allowed to force-push it: `git -C $COGMO_SKILLS_PATH push --force-with-lease=main:<that sha> origin main`.",
    )
    .exhaustive();
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
