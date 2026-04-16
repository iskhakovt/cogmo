/**
 * Per-command Telegram handlers — extracted as pure `(transport, ctx) => void` functions so they
 * can be unit-tested without grammY plumbing. The adapter wires them to `bot.command(...)`.
 *
 * Subcommand parsing (`/profile switch <name>`, `/model <model>`) lives here rather than in
 * `index.ts` so the dispatcher logic is covered by unit tests.
 */

import type { Transport, TransportError } from "../../transport.js";
import type { ProfileDialogs } from "./profile-dialog.js";
import {
  type InlineButton,
  renderModelList,
  renderProfileList,
  renderSessionsList,
} from "./sessions-ux.js";

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

const USAGE = {
  resume: "Usage: /resume <alias>",
  name: "Usage: /name <alias>  (or /name -  to clear)",
  profile: "Usage: /profile [list|switch <name>|new <name>|edit <name>|delete <name>]",
  model: "Usage: /model [<model>]",
};

// ---- Public handlers ----

export async function handleSessions(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const current = await transport.conversations.getCurrent(handle, addr);
  const currentConversationId =
    current.isOk() && current.value ? current.value.conversationId : undefined;

  const res = await transport.conversations.list(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  const rendered = renderSessionsList(res.value, { currentConversationId });
  await ctx.reply(rendered.text, toReplyOptions(rendered.buttons));
}

export async function handleResume(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const alias = ctx.match?.trim();
  if (!alias) {
    await ctx.reply(USAGE.resume);
    return;
  }
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const res = await transport.resumeConversation(addr, handle, { alias });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(`Resumed conversation "${alias}".`);
}

export async function handleName(transport: Transport, ctx: TelegramCommandContext): Promise<void> {
  const arg = ctx.match?.trim();
  if (!arg) {
    await ctx.reply(USAGE.name);
    return;
  }
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const current = await transport.conversations.getCurrent(handle, addr);
  if (current.isErr()) {
    await ctx.reply(errorMessage(current.error));
    return;
  }
  if (!current.value) {
    await ctx.reply("No active conversation yet — send a message first.");
    return;
  }

  const newAlias = arg === "-" ? null : arg;
  const res = await transport.conversations.setAlias(
    handle,
    current.value.conversationId,
    newAlias,
  );
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(newAlias ? `Alias set: "${newAlias}".` : "Alias cleared.");
}

export async function handleEnd(transport: Transport, ctx: TelegramCommandContext): Promise<void> {
  const addr = String(ctx.chat.id);
  const session = await transport.resolveSession(addr);
  if (!session) {
    await ctx.reply("No active conversation.");
    return;
  }
  await transport.closeSession(session.id);
  await ctx.reply("Conversation ended. Send a message to start a new one.");
}

export async function handleProfile(
  transport: Transport,
  ctx: TelegramCommandContext,
  dialogs: ProfileDialogs,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const [sub, ...rest] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(" ");

  switch (sub) {
    case undefined:
    case "":
    case "list":
      return replyProfileList(transport, ctx, handle, addr);
    case "switch":
      return replyProfileSwitch(transport, ctx, handle, addr, arg);
    case "delete":
      return replyProfileDelete(transport, ctx, handle, arg);
    case "new":
      return dialogs.startNew(transport, ctx, arg);
    case "edit":
      return dialogs.startEdit(transport, ctx, arg);
    default:
      await ctx.reply(USAGE.profile);
  }
}

export async function handleModel(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const pick = ctx.match?.trim();

  const current = await transport.conversations.getCurrent(handle, addr);
  if (current.isErr()) {
    await ctx.reply(errorMessage(current.error));
    return;
  }
  if (!current.value) {
    await ctx.reply("No active conversation yet — send a message first.");
    return;
  }

  if (!pick) {
    const models = await transport.models.list();
    const body = renderModelList(models, { currentModel: current.value.model });
    await ctx.reply(body);
    return;
  }

  const res = await transport.profiles.update(handle, current.value.profileId, { model: pick });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Model for "${current.value.profileName}" set to ${pick}. Takes effect next turn.`,
  );
}

/** Callback-query handler for inline-keyboard taps from /sessions. */
export async function handleResumeCallback(
  transport: Transport,
  ctx: TelegramCommandContext,
  target: string,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  // Callback data is either an alias or a conversationId. UUIDs contain hyphens at fixed offsets;
  // aliases may or may not. Treat as UUID if it matches the v7 shape.
  const key = looksLikeUuid(target)
    ? ({ conversationId: target } as const)
    : ({ alias: target } as const);
  const res = await transport.resumeConversation(addr, handle, key);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply("Resumed.");
}

// ---- Internal helpers ----

async function replyProfileList(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  addr: string,
): Promise<void> {
  const list = await transport.profiles.list(handle);
  if (list.isErr()) {
    await ctx.reply(errorMessage(list.error));
    return;
  }
  const current = await transport.conversations.getCurrent(handle, addr);
  const currentProfileId = current.isOk() && current.value ? current.value.profileId : undefined;
  const rendered = renderProfileList(list.value, { currentProfileId });
  await ctx.reply(rendered.text);
}

async function replyProfileSwitch(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  addr: string,
  name: string,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE.profile);
    return;
  }
  const list = await transport.profiles.list(handle);
  if (list.isErr()) {
    await ctx.reply(errorMessage(list.error));
    return;
  }
  const match = list.value.find((p) => p.name === name);
  if (!match) {
    await ctx.reply(`No profile named "${name}". Use /profile list to see available profiles.`);
    return;
  }
  const current = await transport.conversations.getCurrent(handle, addr);
  if (current.isErr()) {
    await ctx.reply(errorMessage(current.error));
    return;
  }
  if (!current.value) {
    await ctx.reply("No active conversation yet — send a message first.");
    return;
  }
  const res = await transport.conversations.setProfile(
    handle,
    current.value.conversationId,
    match.id,
  );
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(`Profile switched to "${name}". Takes effect next turn.`);
}

async function replyProfileDelete(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE.profile);
    return;
  }
  const list = await transport.profiles.list(handle);
  if (list.isErr()) {
    await ctx.reply(errorMessage(list.error));
    return;
  }
  const match = list.value.find((p) => p.name === name);
  if (!match) {
    await ctx.reply(`No profile named "${name}".`);
    return;
  }
  const res = await transport.profiles.delete(handle, match.id);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(`Profile "${name}" deleted.`);
}

function errorMessage(err: TransportError): string {
  switch (err.code) {
    case "identity_rejected":
      return "You're not authorized on this bot.";
    case "conversation_not_found":
      return "Conversation not found.";
    case "profile_not_found":
      return "Profile not found.";
    case "profile_in_use":
      return "Profile has active conversations. Switch them first.";
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
  }
}

function toReplyOptions(
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

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeUuid(s: string): boolean {
  return UUID_V7_PATTERN.test(s);
}
