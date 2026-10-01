/** `/repo`: repositories registered for coding delegation. */

import type { Transport } from "../../../transport.js";
import type { RepoDialogs } from "../repo-dialog.js";
import { errorMessage, type TelegramCommandContext } from "./reply.js";

const USAGE =
  "Usage: /repo [list|add [<name> <local_path> <remote_url>]|remove <name>]\n" +
  "  /repo add (no args)            → guided dialog: clones via the bot PAT\n" +
  "  /repo add <name> <path> <url>  → register an already-cloned repo (scripting)";

export async function handleRepo(
  transport: Transport,
  ctx: TelegramCommandContext,
  repoDialogs?: RepoDialogs,
): Promise<void> {
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const subcommand = args[0]?.toLowerCase() ?? "list";

  if (subcommand === "list") {
    const res = await transport.repos.list();
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    if (res.value.length === 0) {
      await ctx.reply(
        "No repos registered. Add one with:\n  /repo add — guided clone\n  /repo add <name> <path> <url> — register existing clone",
      );
      return;
    }
    const lines = res.value.map((r) => `${r.name} — ${r.localPath} (branch: ${r.defaultBranch})`);
    await ctx.reply(`Repos:\n${lines.join("\n")}`);
    return;
  }

  if (subcommand === "add") {
    const [, name, localPath, remoteUrl] = args;
    // No positional args → guided dialog. When the FSM isn't
    // wired (e.g. unit tests for the positional path), fall through to the
    // usage hint so the operator gets a clear nudge instead of silence.
    if (!name && !localPath && !remoteUrl) {
      if (repoDialogs) {
        await repoDialogs.start(ctx);
        return;
      }
      await ctx.reply(USAGE);
      return;
    }
    if (!name || !localPath || !remoteUrl) {
      await ctx.reply(USAGE);
      return;
    }
    const res = await transport.repos.add({ name, localPath, remoteUrl });
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    await ctx.reply(
      `Repo "${res.value.name}" added.\n` +
        `Path: ${res.value.localPath}\n` +
        `Remote: ${res.value.remoteUrl}\n` +
        `Verify: ${res.value.verifyCommand} (default — update via SQL until /repo edit ships)`,
    );
    return;
  }

  if (subcommand === "remove" || subcommand === "rm") {
    const name = args[1];
    if (!name) {
      await ctx.reply(USAGE);
      return;
    }
    const res = await transport.repos.remove(name);
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    await ctx.reply(`Repo "${name}" removed.`);
    return;
  }

  await ctx.reply(USAGE);
}
