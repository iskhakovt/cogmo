/** What every command handler replies through, and the text it replies with for a `TransportError`. */

import { match } from "ts-pattern";
import { CORE_COMPARTMENTS } from "../../../../agent/evolution/memory-extraction-schema.js";
import type { PipelineRunStatus } from "../../../../agent/pipeline/store/index.js";
import type { TransportError } from "../../../transport.js";
import type { InlineButton } from "../sessions-ux.js";

/**
 * Minimal Telegram context shape used by the commands. Modelled after grammY's `Context` but
 * typed narrowly so tests can construct mocks trivially.
 */
export interface TelegramCommandContext {
  chat: { id: number };
  from: { id: number | string };
  /** Trailing text after the command, e.g. `/profile switch foo` → `"switch foo"`. */
  match: string | undefined;
  reply(text: string, options?: ReplyOptions): Promise<unknown>;
}

export interface ReplyOptions {
  reply_markup?: {
    inline_keyboard: ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>>;
  };
}

export const CORE_LIST = CORE_COMPARTMENTS.join(", ");

/** Why a gate button can't act, told from where the run is. */
function gateNotPendingMessage(status: PipelineRunStatus): string {
  return match(status)
    .with(
      "waiting_gate",
      () => "This button is from an earlier checkpoint. Use the buttons on the latest one.",
    )
    .with(
      "running",
      "queued",
      "waiting_event",
      () => "This checkpoint was already decided, and the pipeline has moved on.",
    )
    .with("completed", () => "This pipeline run has already finished.")
    .with("cancelled", () => "This pipeline run was cancelled.")
    .with("failed", () => "This pipeline run stopped after a failure.")
    .exhaustive();
}

export function errorMessage(err: TransportError): string {
  switch (err.code) {
    case "identity_rejected":
      return "You're not authorized on this bot.";
    case "conversation_not_found":
      return "Conversation not found.";
    case "profile_not_found":
      // Rendered for every command that can raise the code — delete, rename,
      // voice, and a conversation whose own profile row is gone. Listing is the
      // next step for all of them; naming a specific repair here would be wrong
      // for most of the callers.
      return "Profile not found. Use /profile list to see what's available.";
    case "profile_in_use":
      return (
        "Profile is still in use. Switch its conversations to another profile (/profile switch), " +
        "/disable skills scheduled to run as it, and delete its /schedules. A profile with message " +
        "history or its own steering rules can't be deleted."
      );
    case "profile_name_taken":
      return "A profile with that name already exists.";
    case "model_unavailable":
      return `Model "${err.model}" isn't available. Use /model to see options.`;
    case "alias_taken":
      return "That alias is already used by another conversation.";
    case "access_denied":
      return `Access denied — ${err.reason}.`;
    case "operation_not_permitted":
      return "Operation not permitted.";
    case "session_not_found":
      return "Session not found.";
    case "repo_not_found":
      return `No repo named "${err.name}". Use /repo list to see available repos.`;
    case "repo_name_taken":
      return `A repo named "${err.name}" already exists.`;
    case "repo_in_use":
      return `Repo "${err.name}" has ${err.activeTasks} active task(s). Wait for them to finish first.`;
    case "repo_invalid_input":
      return `Invalid ${err.field}: ${err.reason}`;
    case "repo_clone_failed":
      return `Clone failed: ${err.reason}`;
    case "repo_local_path_exists":
      return `A directory already exists at ${err.path}. Move it aside or pick a different name.`;
    case "github_identity_unavailable":
      return `GitHub identity unavailable: ${err.reason}`;
    case "sandbox_disabled":
      return "Coding-delegation features are unavailable — set SANDBOX_RUNTIME and restart Cogmo.";
    case "task_not_found":
      return `Task ${shortenId(err.taskId)} not found.`;
    case "task_already_approved":
      return "This plan was already approved — execution is in progress.";
    case "task_not_pending_approval":
      return `This plan can't be approved (status: ${err.status}).`;
    case "task_already_terminal":
      return `Task already finished (status: ${err.status}).`;
    case "skills_disabled":
      return "Skills runtime is unavailable — bootstrap missing skillRunner wiring.";
    case "skill_not_found":
      return `No skill named "${err.name}". Use /skills to list.`;
    case "skill_no_live_deploy":
      return `Skill "${err.name}" has no live deploy at its current sha — re-register the source via the agent or \`cogmo skills register\` first.`;
    case "skill_deploy_not_found":
      return `Skill deploy ${shortenId(err.pendingId)} not found.`;
    case "skill_deploy_not_pending":
      return `This deploy can't be acted on (status: ${err.status}).`;
    case "pipelines_disabled":
      return "Pipelines aren't wired in this deployment.";
    case "pipeline_run_not_found":
      return `No pipeline run with id "${shortenId(err.runId)}".`;
    case "pipeline_gate_not_pending":
      return gateNotPendingMessage(err.status);
    case "skill_deploy_register_failed":
      return `Approve failed: ${err.reason}`;
    case "mcp_disabled":
      return "MCP integrations are unavailable in this deployment.";
    case "mcp_server_not_found":
      return `MCP server ${shortenId(err.serverId)} not found.`;
    case "mcp_server_name_taken":
      return `An MCP server named "${err.name}" already exists.`;
    case "mcp_invalid_config":
      return `Invalid MCP server config: ${err.reason}`;
    case "mcp_tool_not_found":
      return `Tool "${err.toolName}" not found on server ${shortenId(err.serverId)}.`;
    case "mcp_connection_failed":
      return `MCP connection failed: ${err.reason}`;
    case "profile_class_in_use":
      return `Class is referenced by ${err.profileRefs} profile(s). Clear /profile class first.`;
    case "profile_class_has_blocks":
      return `This deletes the class's core-memory blocks (${err.keys.join(", ")}). Repeat the command with confirm to go ahead.`;
    case "profile_class_not_found":
      return `No profile class named "${err.name}". Use /classes to list.`;
    case "profile_class_name_taken":
      return `A profile class named "${err.name}" already exists.`;
    case "unknown_profile_class":
      return `Unknown profile class "${err.name}". Register it with /classes add first.`;
    case "compartment_cap_exceeded":
      return `Custom compartment cap reached (${err.current}/${err.limit}). Remove one with /compartments rm <name> first.`;
    case "compartment_name_taken":
      return `A compartment named "${err.name}" already exists.`;
    case "compartment_name_reserved":
      return `"${err.name}" is a core compartment and can't be redefined.`;
    case "compartment_not_found":
      return `No custom compartment named "${err.name}". Use /compartments to list.`;
    case "compartment_unknown":
      return `Unknown compartment "${err.name}". Use /compartments add ${err.name} <description> first, or pick a core value (${CORE_LIST}).`;
    case "compartment_name_invalid":
      return `Compartment name "${err.name}" is invalid. Use lowercase letters, digits, hyphens, or underscores; start with a letter; max 32 chars.`;
    case "profile_class_name_invalid":
      return `Profile-class name "${err.name}" is invalid. Use lowercase letters, digits, hyphens, or underscores; start with a letter; max 32 chars.`;
    case "schedule_not_found":
      return `No scheduled task with id "${shortenId(err.id)}". Use /schedules to list.`;
    case "schedule_id_malformed":
      return `"${err.id}" doesn't look like a valid task id. Use /schedules to list and copy an id.`;
    case "evolution_unavailable":
      return "Evolution isn't wired in this deployment.";
    case "compaction_unavailable":
      return "Compaction isn't wired in this deployment.";
    case "compaction_failed":
      return err.reason === null
        ? "Couldn't compact this conversation. The error is in the server log."
        : `Couldn't compact this conversation: ${err.reason}`;
  }
}

export function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function toReplyOptions(
  buttons: ReadonlyArray<InlineButton> | undefined,
): ReplyOptions | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  // One button per row for readability on mobile.
  return {
    reply_markup: {
      inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.callbackData }]),
    },
  };
}

/** The part of grammY's `Other` for `sendMessage` that `ReplyOptions` maps onto. */
interface GrammyReplyOptions {
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

/**
 * Narrow a grammY CommandContext/CallbackQueryContext to the minimal shape used by pure
 * command handlers.
 */
interface GrammyCtxLite {
  chat: { id: number } | undefined;
  from: { id: number | string } | undefined;
  match?: unknown;
  reply: (text: string, other?: GrammyReplyOptions) => Promise<unknown>;
}

/** `ReplyOptions` in grammY's shape, whose keyboard rows are mutable arrays. */
function toGrammyReplyOptions(options: ReplyOptions): GrammyReplyOptions {
  // Every other field passes through as is, so one added to ReplyOptions reaches grammY.
  const { reply_markup, ...rest } = options;
  return {
    ...rest,
    ...(reply_markup !== undefined && {
      reply_markup: { inline_keyboard: reply_markup.inline_keyboard.map((row) => [...row]) },
    }),
  };
}

export function toCmdCtx(ctx: GrammyCtxLite, overrideMatch?: string): TelegramCommandContext {
  if (!ctx.chat || !ctx.from) throw new Error("telegram: ctx missing chat/from");
  const match =
    overrideMatch !== undefined
      ? overrideMatch
      : typeof ctx.match === "string"
        ? ctx.match
        : undefined;
  return {
    chat: { id: ctx.chat.id },
    from: { id: ctx.from.id },
    match,
    reply: (text, options) =>
      ctx.reply(text, options === undefined ? undefined : toGrammyReplyOptions(options)),
  };
}
