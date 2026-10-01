/** Slash-command routing: each command to its handler, `/start`'s help, `/cancel`, and the client-side command menu. */

import type { Bot, Composer, Context } from "grammy";
import { logger } from "../../../logger.js";
import type { Transport } from "../../transport.js";
import { handleClasses } from "./commands/classes.js";
import { handleCompartments } from "./commands/compartments.js";
import { handleCompact, handleRepair, handleStatus, handleVoice } from "./commands/conversation.js";
import { handleLearned, handleReflect } from "./commands/evolution.js";
import { handleMcp } from "./commands/mcp.js";
import { handleModel } from "./commands/model.js";
import { handleProfile } from "./commands/profile.js";
import { toCmdCtx } from "./commands/reply.js";
import { handleRepo } from "./commands/repo.js";
import { handleSchedules } from "./commands/schedules.js";
import {
  handleEnd,
  handleName,
  handleNew,
  handleResume,
  handleSessions,
} from "./commands/sessions.js";
import { handleDisable, handleEnable, handleSkills } from "./commands/skills.js";
import type { ProfileDialogs } from "./profile-dialog.js";
import type { RepoDialogs } from "./repo-dialog.js";

export interface CommandRouteDeps {
  transport: Transport;
  profileDialogs: ProfileDialogs;
  repoDialogs: RepoDialogs;
}

/** Register every command on `commands`, the composer forwarded messages never reach. */
export function registerCommands(
  commands: Composer<Context>,
  { transport, profileDialogs, repoDialogs }: CommandRouteDeps,
): void {
  commands.command("start", async (ctx) => {
    await ctx.reply(
      [
        "Cogmo ready. Send a message to start chatting.",
        "",
        "Conversation:",
        "  /new — start a new conversation",
        "  /sessions — list conversations",
        "  /resume <alias> — switch to a named conversation",
        "  /name <alias> — name the current conversation",
        "  /end — close the current conversation",
        "  /compact — summarize the conversation now, so the next turn starts small",
        "",
        "Profile & model:",
        "  /profile [list|switch <name>|new <name>|edit <name>|delete <name>]",
        "  /model [<model>]",
        "  /cancel — abort interactive /profile new|edit flow",
        "",
        "Coding delegation:",
        "  /repo [list|add <name> <local_path> <remote_url>|remove <name>]",
        "",
        "MCP integrations:",
        "  /mcp [list|pending|add <name> <config-json>|remove <name>|approve <name> [<tool>]|reject <name> <tool>]",
        "",
        "Repair:",
        "  /repair  (or /repair <alias|uuid>)  — clear `errored` status on a conversation",
        "",
        "Voice:",
        "  /voice [auto|always|off|clear] — set per-conversation voice mode",
        "",
        "Status:",
        "  /status — show conversation, profile, and context stats",
        "",
        "Evolution:",
        "  /learned [<id>] — recent evolution events, or detail by id",
        "  /reflect — run the Observer for this conversation now",
      ].join("\n"),
    );
  });

  // Admin commands — each delegates to a pure handler under commands/.
  // grammY's ctx is ducktyped to `TelegramCommandContext` at call time; `ctx.match` holds
  // the trailing text after the command word (empty string for bare `/profile`).
  commands.command("new", (ctx) => handleNew(transport, toCmdCtx(ctx)));
  commands.command("sessions", (ctx) => handleSessions(transport, toCmdCtx(ctx)));
  commands.command("resume", (ctx) => handleResume(transport, toCmdCtx(ctx)));
  commands.command("name", (ctx) => handleName(transport, toCmdCtx(ctx)));
  commands.command("end", (ctx) => handleEnd(transport, toCmdCtx(ctx)));
  commands.command("compact", (ctx) => handleCompact(transport, toCmdCtx(ctx)));
  commands.command("profile", (ctx) => handleProfile(transport, toCmdCtx(ctx), profileDialogs));
  commands.command("classes", (ctx) => handleClasses(transport, toCmdCtx(ctx)));
  commands.command("compartments", (ctx) => handleCompartments(transport, toCmdCtx(ctx)));
  commands.command("model", (ctx) => handleModel(transport, toCmdCtx(ctx)));
  commands.command("repo", (ctx) => handleRepo(transport, toCmdCtx(ctx), repoDialogs));
  commands.command("mcp", (ctx) => handleMcp(transport, toCmdCtx(ctx)));
  commands.command("repair", (ctx) => handleRepair(transport, toCmdCtx(ctx)));
  commands.command("voice", (ctx) => handleVoice(transport, toCmdCtx(ctx)));
  commands.command("status", (ctx) => handleStatus(transport, toCmdCtx(ctx)));
  commands.command("skills", (ctx) => handleSkills(transport, toCmdCtx(ctx)));
  commands.command("disable", (ctx) => handleDisable(transport, toCmdCtx(ctx)));
  commands.command("enable", (ctx) => handleEnable(transport, toCmdCtx(ctx)));
  commands.command("schedules", (ctx) => handleSchedules(transport, toCmdCtx(ctx)));
  commands.command("learned", (ctx) => handleLearned(transport, toCmdCtx(ctx)));
  commands.command("reflect", (ctx) => handleReflect(transport, toCmdCtx(ctx)));

  // Mid-dialog abort for /profile new|edit and /repo add flows. Evaluate
  // both branches (no `||` short-circuit) so a hypothetical "both dialogs
  // simultaneously active" state — possible only if a future code path
  // forgets to clear one before opening the other — gets fully torn down
  // rather than leaving the second FSM live.
  commands.command("cancel", async (ctx) => {
    const cancelledProfile = profileDialogs.cancel(ctx.chat.id);
    const cancelledRepo = repoDialogs.cancel(ctx.chat.id);
    if (cancelledProfile || cancelledRepo) {
      await ctx.reply("Cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });
}

// Populate the client-side command menu (the "/" / Menu button in Telegram).
// Idempotent: Telegram replaces the list on each call. Failure here is
// non-fatal — log and proceed so the bot still starts.
export async function publishCommandMenu(api: Bot["api"]): Promise<void> {
  await api
    .setMyCommands([
      { command: "new", description: "Start a new conversation" },
      { command: "sessions", description: "List conversations" },
      { command: "resume", description: "Switch to a named conversation" },
      { command: "name", description: "Name the current conversation" },
      { command: "end", description: "Close the current conversation" },
      { command: "compact", description: "Summarize the conversation now to shrink context" },
      { command: "profile", description: "Manage profiles" },
      { command: "model", description: "Show or set the model" },
      { command: "repo", description: "Manage repos for coding delegation" },
      { command: "mcp", description: "Manage MCP integrations" },
      { command: "repair", description: "Clear errored status on a conversation" },
      { command: "voice", description: "Set voice mode (auto / always / off)" },
      { command: "status", description: "Show conversation, profile, and context stats" },
      { command: "skills", description: "List skills (enabled + disabled)" },
      { command: "disable", description: "Soft-disable a skill by name" },
      { command: "enable", description: "Re-enable a previously-disabled skill" },
      { command: "schedules", description: "List/disable/enable/delete scheduled tasks" },
      { command: "learned", description: "List recent evolution events" },
      { command: "reflect", description: "Run the Observer for this conversation now" },
      { command: "cancel", description: "Abort the current interactive dialog" },
      { command: "start", description: "Show help" },
    ])
    .catch((err) => logger.warn({ err }, "failed to register telegram bot commands"));
}
