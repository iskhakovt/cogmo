/** `/schedules`: list and manage scheduled tasks. */

import type { ScheduledTaskAdminEntry, Transport } from "../../../transport.js";
import { errorMessage, shortenId, type TelegramCommandContext } from "./reply.js";

const USAGE =
  "Usage: /schedules [disable|enable|delete <id>]\n" +
  "  /schedules                   → list scheduled tasks (enabled + disabled)\n" +
  "  /schedules disable <id>      → soft-disable a task (keeps the row; won't fire)\n" +
  "  /schedules enable <id>       → re-enable a previously disabled task\n" +
  "  /schedules delete <id>       → permanently remove a task (no undo)\n" +
  "  Get task ids from `/schedules` output. Full UUID required.";

/**
 * `/schedules` — list scheduled tasks for the user.
 * `/schedules disable|enable|delete <id>` — manage a specific task.
 *
 * One command with subcommands rather than three top-level commands
 * because `/disable` and `/enable` are already taken by the skills
 * surface. The subcommand-style also keeps `setMyCommands` short.
 *
 * IDs are full UUIDs (copy-pasted from the list output) — no prefix
 * matching today. Add prefix matching when the UX bites.
 */
export async function handleSchedules(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const args = ctx.match?.trim() ?? "";
  const handle = String(ctx.from.id);

  // Bare `/schedules` → list.
  if (args === "") {
    const res = await transport.scheduling.list(handle);
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    if (res.value.length === 0) {
      await ctx.reply(
        "No scheduled tasks. The agent can create them via `schedule_task` in a conversation.",
      );
      return;
    }
    await ctx.reply(formatScheduleList(res.value));
    return;
  }

  // `<subcommand> <id>`
  const [subcommand, ...rest] = args.split(/\s+/);
  const id = rest.join(" ").trim();

  if (subcommand !== "disable" && subcommand !== "enable" && subcommand !== "delete") {
    await ctx.reply(USAGE);
    return;
  }
  if (!id) {
    await ctx.reply(USAGE);
    return;
  }

  switch (subcommand) {
    case "disable": {
      const res = await transport.scheduling.disable(handle, id);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      await ctx.reply(
        res.value.alreadyAtState
          ? `Task ${shortenId(id)} is already disabled.`
          : `Task ${shortenId(id)} disabled.`,
      );
      return;
    }
    case "enable": {
      const res = await transport.scheduling.enable(handle, id);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      await ctx.reply(
        res.value.alreadyAtState
          ? `Task ${shortenId(id)} is already enabled.`
          : `Task ${shortenId(id)} enabled.`,
      );
      return;
    }
    case "delete": {
      const res = await transport.scheduling.delete(handle, id);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      await ctx.reply(`Task ${shortenId(id)} removed.`);
      return;
    }
  }
}

/**
 * Render a scheduled-task list for Telegram. Sort by `nextRunAt` ASC
 * with disabled rows sinking to the end — same convention as
 * `formatTaskList` in `src/agent/scheduling/tools.ts`. Full id
 * included so the user can copy it into a follow-up
 * `/schedules disable|enable|delete <id>` command.
 *
 * Caps the rendered list at `MAX_SCHEDULE_DISPLAY` so the message
 * can't blow past Telegram's 4096-char per-message limit. Worst-case
 * sizing: 15 tasks × ~210 chars/task = ~3150 chars body + ~100 chars
 * header/footer chrome ≈ 3250 chars, comfortable margin under 4096.
 * When the user has more tasks than fit, we surface the count + nudge
 * them toward `list_tasks` (the agent tool) which has no length cap.
 *
 * Note: `ctx.reply` does NOT auto-rotate — the streaming-text
 * rotator from PR #239 only applies to the assistant-text path.
 */
const MAX_SCHEDULE_DISPLAY = 15;

function formatScheduleList(tasks: ReadonlyArray<ScheduledTaskAdminEntry>): string {
  // Sort: enabled-first, then nextRunAt ASC, then id ASC. Explicit
  // id tiebreak makes the output deterministic on identical
  // nextRunAt — UUIDv7 is time-ordered so an id ASC tiebreak
  // approximates insertion order, which is what a human reader
  // expects ("the older of two ties shows first").
  const sorted = [...tasks].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const dt = a.nextRunAt.getTime() - b.nextRunAt.getTime();
    if (dt !== 0) return dt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const visible = sorted.slice(0, MAX_SCHEDULE_DISPLAY);
  const header = `Scheduled tasks (${tasks.length}):`;
  const lines = visible.map((t, i) => {
    const schedule =
      t.kind === "recurring" ? `cron '${t.cron}' (${t.timezone})` : `one-off (${t.timezone})`;
    const promptPreview = t.prompt.length > 80 ? `${t.prompt.slice(0, 77)}...` : t.prompt;
    const state = t.enabled ? "" : " [disabled]";
    return `${i + 1}. ${t.id}${state}\n   ${schedule} — '${promptPreview}'\n   next: ${t.nextRunAt.toISOString()}`;
  });
  const hiddenCount = tasks.length - visible.length;
  const footer =
    hiddenCount > 0
      ? `\n\n... and ${hiddenCount} more. Ask the agent to list all (uses \`list_tasks\` with no display cap).`
      : "";
  return [header, ...lines].join("\n") + footer;
}
