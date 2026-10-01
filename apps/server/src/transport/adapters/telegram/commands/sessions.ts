/** `/new`, `/sessions`, `/resume`, `/name`, `/end`: which conversation this chat is in. */

import type { Transport } from "../../../transport.js";
import { renderSessionsList } from "../sessions-ux.js";
import { ambiguityMessage, looksLikeUuid, resolveProfileByName } from "./lookup.js";
import { errorMessage, type TelegramCommandContext, toReplyOptions } from "./reply.js";

const RESUME_USAGE = "Usage: /resume <alias>";
const NAME_USAGE = "Usage: /name <alias>  (or /name -  to clear)";

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
  const target = ctx.match?.trim();
  if (!target) {
    await ctx.reply(RESUME_USAGE);
    return;
  }
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  // Accept both alias and UUID forms so `/sessions` numbered output (which emits `/resume <uuid>`
  // for unaliased entries) stays actionable. The callback-query path already does this.
  const isUuid = looksLikeUuid(target);

  // Boundary hold open? Drain the buffered inbounds into the user-specified
  // target instead of taking the standard `resumeConversation` path. Aliases
  // resolve through the same `findConversationByAlias` lookup that
  // `resumeConversation` uses, so identity + ownership are still checked
  // (ACL semantics live inside `resolveBoundary`).
  const pending = await transport.boundary.findActive(addr);
  if (pending) {
    let conversationId: string;
    if (isUuid) {
      conversationId = target;
    } else {
      const list = await transport.conversations.list(handle);
      if (list.isErr()) {
        await ctx.reply(errorMessage(list.error));
        return;
      }
      const found = list.value.find((c) => c.alias === target);
      if (!found) {
        await ctx.reply(`No conversation aliased "${target}". Use /sessions to list.`);
        return;
      }
      conversationId = found.id;
    }
    const resolved = await transport.boundary.resolve({
      boundaryId: pending.id,
      choice: { kind: "resume-target", conversationId },
      reason: "user_resume_target",
    });
    if (resolved.isErr()) {
      const code = resolved.error.code;
      await ctx.reply(
        code === "access_denied"
          ? `Cannot resume "${target}" — not yours.`
          : code === "conversation_not_found"
            ? `No conversation matching "${target}".`
            : code === "boundary_not_found"
              ? "That prompt already resolved."
              : "Resume failed.",
      );
      return;
    }
    const label = isUuid ? await resumeLabelFor(transport, handle, conversationId) : target;
    await ctx.reply(`Resumed conversation "${label}".`);
    return;
  }

  const key = isUuid ? ({ conversationId: target } as const) : ({ alias: target } as const);
  const res = await transport.resumeConversation(addr, handle, key);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  // For UUID form, look up a friendlier label (alias or preview) so the user doesn't see a
  // 36-char hex blob echoed back. For alias form, the alias itself is the label.
  const label = isUuid ? await resumeLabelFor(transport, handle, res.value.conversationId) : target;
  await ctx.reply(`Resumed conversation "${label}".`);
}

async function resumeLabelFor(
  transport: Transport,
  handle: string,
  conversationId: string,
): Promise<string> {
  const list = await transport.conversations.list(handle);
  if (list.isErr()) return conversationId;
  const conv = list.value.find((c) => c.id === conversationId);
  return conv?.alias ?? conv?.lastMessagePreview ?? conversationId;
}

export async function handleName(transport: Transport, ctx: TelegramCommandContext): Promise<void> {
  const arg = ctx.match?.trim();
  if (!arg) {
    await ctx.reply(NAME_USAGE);
    return;
  }
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  // resolveSession is enough here — setAlias on Transport enforces ownership internally.
  // Avoids the extra profile join that getCurrent would do.
  const session = await transport.resolveSession(addr);
  if (!session) {
    await ctx.reply("No active conversation yet — send a message first.");
    return;
  }

  const newAlias = arg === "-" ? null : arg;
  const res = await transport.conversations.setAlias(handle, session.conversationId, newAlias);
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

export async function handleNew(transport: Transport, ctx: TelegramCommandContext): Promise<void> {
  const addr = String(ctx.chat.id);
  const handle = String(ctx.from.id);
  const profileName = ctx.match?.trim();

  let profileId: string | undefined;
  if (profileName) {
    const res = await resolveProfileByName(transport, handle, profileName);
    if (res.kind === "error") {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    if (res.kind === "none") {
      await ctx.reply(`No profile named "${profileName}". Use /profile list.`);
      return;
    }
    if (res.kind === "ambiguous") {
      await ctx.reply(ambiguityMessage(profileName, res.matches));
      return;
    }
    profileId = res.profile.id;
  }

  // Boundary hold open? The user just resolved their own ambivalence: drain
  // the buffered inbounds into a fresh conversation under the requested
  // profile and let `resolveBoundary` emit `boundary/resolved` (which
  // cancels the waiter). Skip the regular createConversation path.
  const pending = await transport.boundary.findActive(addr);
  if (pending) {
    const res = await transport.boundary.resolve({
      boundaryId: pending.id,
      choice: profileId ? { kind: "fresh", profileId } : { kind: "fresh" },
      reason: "user_command",
    });
    if (res.isErr()) {
      await ctx.reply("Could not start a new conversation right now.");
      return;
    }
    const profile = await transport.conversations.getCurrent(handle, addr);
    const used =
      profile.isOk() && profile.value ? profile.value.profileName : (profileName ?? "default");
    await ctx.reply(`Started a new conversation (${used}).`);
    return;
  }

  const existing = await transport.resolveSession(addr);
  if (existing) await transport.closeSession(existing.id);
  const result = await transport.createConversation(
    addr,
    handle,
    profileId ? { isPrivate: true, profileId } : { isPrivate: true },
  );
  if (result.isErr()) {
    await ctx.reply(errorMessage(result.error));
    return;
  }
  // Surface the profile actually used. createConversation returns the
  // resolved name in its success value, so the reply names the profile of
  // the conversation we just created — atomic with the insert, and
  // race-free against a concurrent /new on the same chat (which would
  // otherwise swap the "current" session out from under us if we asked
  // getCurrent after the fact).
  await ctx.reply(`New conversation started with profile "${result.value.profileName}".`);
}
