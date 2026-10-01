/** `/profile` and its subcommands. `new` and `edit` hand off to the profile dialog. */

import { isCoreCompartment } from "../../../../agent/evolution/memory-extraction-schema.js";
import type { ProfileMemoryScope } from "../../../../agent/store/schema.js";
import type { Transport } from "../../../transport.js";
import type { ProfileDialogs } from "../profile-dialog.js";
import { formatScope, renderProfileList } from "../sessions-ux.js";
import { ambiguityMessage, resolveProfileByName } from "./lookup.js";
import {
  parseScopeSpec,
  parseStreamSpec,
  splitScopeArgs,
  splitStreamArgs,
} from "./profile-args.js";
import { CORE_LIST, errorMessage, type TelegramCommandContext } from "./reply.js";

const USAGE =
  "Usage: /profile [list|switch <name>|new <name>|edit <name>|delete <name>|default [<name>|clear]|scope <name> [clear|compartments=… trust=… [classes=…]]|class <name> <class|clear>]\n" +
  "  /profile default                                        → show this chat's default profile\n" +
  "  /profile default <name>                                 → pin a default for new conversations in this chat\n" +
  "  /profile default clear                                  → unpin (fall back to the global default)\n" +
  "  /profile scope <name>                                   → show current scope\n" +
  "  /profile scope <name> clear                             → unrestricted (recall all)\n" +
  "  /profile scope <name> compartments=work,technical trust=first-party\n" +
  "                                                          → set (compartments + trust required; classes optional)\n" +
  "  /profile scope <name> compartments=… trust=… classes=intimate\n" +
  "                                                          → also restrict on speaker dimension\n" +
  "  /profile class <name> <classname>                       → assign profile to a class\n" +
  "  /profile class <name> clear                             → unclass the profile\n" +
  "  /profile stream <name>                                  → show current streaming prefs\n" +
  "  /profile stream <name> chunk=500                        → rotate to a new message every ~500 chars (100..4000)\n" +
  "  /profile stream <name> edits=off                        → append-only (no mid-message edits; typing indicator carries progress)\n" +
  "  /profile stream <name> chunk=500 edits=off              → both at once\n" +
  "                                                          (use chunk=N edits=on|off — the = is required;\n" +
  "                                                          'chunk 500' without = becomes part of the name)\n" +
  "  /profile autoapprove <name>                             → show current coding-delegation plan autoapprove\n" +
  "  /profile autoapprove <name> on                          → auto-approve plans (skip Telegram round trip)\n" +
  "  /profile autoapprove <name> off                         → require Telegram approve tap before execute (default)\n" +
  `  Compartments: ${CORE_LIST}\n` +
  "  Trust:        first-party, any";

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
    case "default":
      return replyProfileDefault(transport, ctx, handle, addr, arg);
    case "delete":
      return replyProfileDelete(transport, ctx, handle, arg);
    case "new":
      return dialogs.startNew(transport, ctx, arg);
    case "edit":
      return dialogs.startEdit(transport, ctx, arg);
    case "scope": {
      // Profile names can contain spaces (no regex constraint at the schema
      // level), so the name isn't necessarily a single token. `splitScopeArgs`
      // walks from the tail collecting tokens that look like scope spec
      // (`clear` or any `<key>=<value>`); the remaining prefix joins back
      // into the name. Unknown keys are intentionally still routed to the
      // parser so the operator sees "Unknown key …" instead of having a
      // typo absorbed into the profile name.
      // Caveat: profiles literally named `clear` or with `=` in the name
      // can't be addressed — rename via `/profile edit`.
      const { name, scopeTokens } = splitScopeArgs(rest);
      return replyProfileScope(transport, ctx, handle, name, scopeTokens);
    }
    case "class": {
      // Same multi-word-name handling as `scope`: the last token is the
      // class name (or "clear"); everything before is the profile name.
      // Profiles literally named `clear` are unaddressable here too.
      if (rest.length < 2) {
        await ctx.reply(USAGE);
        return;
      }
      const last = rest[rest.length - 1] ?? "";
      const name = rest.slice(0, -1).join(" ");
      return replyProfileClass(transport, ctx, handle, name, last);
    }
    case "stream": {
      // Stream tokens are strictly `<key>=<value>` — no bare keyword like
      // `clear` (the defaults are static; there's nothing to clear back to).
      // That lets a profile literally named `clear` be addressed here.
      const { name, streamTokens } = splitStreamArgs(rest);
      return replyProfileStream(transport, ctx, handle, name, streamTokens);
    }
    case "autoapprove": {
      // Last token is the action (`on`/`off`) when present; everything
      // before is the profile name. Without an action the command shows
      // current state. A profile literally named `on` or `off` is
      // unaddressable here (same trade-off as `class … clear`).
      const last = rest[rest.length - 1]?.toLowerCase();
      const action = last === "on" || last === "off" ? last : undefined;
      const name = action ? rest.slice(0, -1).join(" ") : rest.join(" ");
      return replyProfileAutoapprove(transport, ctx, handle, name, action);
    }
    default:
      await ctx.reply(USAGE);
  }
}

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
  // Load the per-user registries so list rendering can annotate custom
  // compartments (`*`) and restricted classes (`!`). Both are best-effort:
  // a list error degrades to "render without legend markers" rather than
  // failing the whole `/profile list` reply.
  const customsRes = await transport.compartments.list(handle);
  const customs = customsRes.isOk() ? new Set(customsRes.value.map((c) => c.name)) : undefined;
  const classesRes = await transport.profileClasses.list(handle);
  const restrictedClasses = classesRes.isOk()
    ? new Set(classesRes.value.filter((c) => c.restricted).map((c) => c.name))
    : undefined;
  const rendered = renderProfileList(list.value, {
    currentProfileId,
    ...(customs !== undefined && { customCompartments: customs }),
    ...(restrictedClasses !== undefined && { restrictedClasses }),
  });
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
    await ctx.reply(USAGE);
    return;
  }
  const res = await resolveProfileByName(transport, handle, name);
  if (res.kind === "error") {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.kind === "none") {
    await ctx.reply(`No profile named "${name}". Use /profile list to see available profiles.`);
    return;
  }
  if (res.kind === "ambiguous") {
    await ctx.reply(ambiguityMessage(name, res.matches));
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
  const set = await transport.conversations.setProfile(
    handle,
    current.value.conversationId,
    res.profile.id,
  );
  if (set.isErr()) {
    await ctx.reply(errorMessage(set.error));
    return;
  }
  await ctx.reply(`Profile switched to "${name}". Takes effect next turn.`);
}

/**
 * `/profile default [<name>|clear]` — manage the chat-pinned default profile
 * used by `createConversation` when no explicit profile is passed (i.e. plain
 * `/new` or the auto-create on first message). One row per Telegram chat.
 *
 * - no arg → show the current binding
 * - `clear` → remove the binding (fall back to the global default)
 * - `<name>` → resolve to a profile and pin it
 */
async function replyProfileDefault(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  addr: string,
  arg: string,
): Promise<void> {
  if (!arg) {
    const current = await transport.chats.getDefaultProfile(handle, addr);
    if (current.isErr()) {
      await ctx.reply(errorMessage(current.error));
      return;
    }
    if (!current.value) {
      await ctx.reply(
        "No default profile pinned for this chat. New conversations use the global default.\n" +
          "Pin one with /profile default <name>.",
      );
      return;
    }
    await ctx.reply(
      `Default profile for this chat: "${current.value.profileName}".\n` +
        "Use /profile default clear to unpin.",
    );
    return;
  }

  if (arg === "clear") {
    const res = await transport.chats.clearDefaultProfile(handle, addr);
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    await ctx.reply("Default profile cleared. New conversations use the global default.");
    return;
  }

  const res = await resolveProfileByName(transport, handle, arg);
  if (res.kind === "error") {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.kind === "none") {
    await ctx.reply(`No profile named "${arg}". Use /profile list to see available profiles.`);
    return;
  }
  if (res.kind === "ambiguous") {
    await ctx.reply(ambiguityMessage(arg, res.matches));
    return;
  }
  const set = await transport.chats.setDefaultProfile(handle, addr, res.profile.id);
  if (set.isErr()) {
    await ctx.reply(errorMessage(set.error));
    return;
  }
  await ctx.reply(
    `Default profile for this chat pinned to "${arg}". New conversations on this chat will use it.`,
  );
}

async function replyProfileDelete(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE);
    return;
  }
  const res = await resolveProfileByName(transport, handle, name);
  if (res.kind === "error") {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.kind === "none") {
    await ctx.reply(`No profile named "${name}".`);
    return;
  }
  if (res.kind === "ambiguous") {
    await ctx.reply(ambiguityMessage(name, res.matches));
    return;
  }
  const del = await transport.profiles.delete(handle, res.profile.id);
  if (del.isErr()) {
    await ctx.reply(errorMessage(del.error));
    return;
  }
  await ctx.reply(`Profile "${name}" deleted.`);
}

async function replyProfileScope(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  scopeTokens: ReadonlyArray<string>,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE);
    return;
  }
  const resolved = await resolveProfileByName(transport, handle, name);
  if (resolved.kind === "error") {
    await ctx.reply(errorMessage(resolved.error));
    return;
  }
  if (resolved.kind === "none") {
    await ctx.reply(`No profile named "${name}".`);
    return;
  }
  if (resolved.kind === "ambiguous") {
    await ctx.reply(ambiguityMessage(name, resolved.matches));
    return;
  }
  const profile = resolved.profile;

  const spec = parseScopeSpec(scopeTokens);
  if (spec.kind === "error") {
    await ctx.reply(spec.message);
    return;
  }

  // Skip the customs fetch when the rendered scope is null or all-core —
  // the `* = custom` legend never fires for those, so the roundtrip is
  // wasted. Same for restricted classes: only fetch when the scope sets
  // `profileClasses`, since the `! = restricted` legend can't fire otherwise.
  const renderedScope: ProfileMemoryScope | null =
    spec.kind === "show" ? profile.memoryScope : spec.kind === "clear" ? null : spec.scope;
  const needsCustoms = renderedScope?.compartments.some((c) => !isCoreCompartment(c)) ?? false;
  const needsRestricted =
    renderedScope?.profileClasses !== undefined && renderedScope.profileClasses.length > 0;

  let customs: ReadonlySet<string> | undefined;
  if (needsCustoms) {
    const customsRes = await transport.compartments.list(handle);
    if (customsRes.isErr()) {
      await ctx.reply(errorMessage(customsRes.error));
      return;
    }
    customs = new Set(customsRes.value.map((c) => c.name));
  }

  let restricted: ReadonlySet<string> | undefined;
  if (needsRestricted) {
    const classesRes = await transport.profileClasses.list(handle);
    if (classesRes.isErr()) {
      await ctx.reply(errorMessage(classesRes.error));
      return;
    }
    restricted = new Set(classesRes.value.filter((c) => c.restricted).map((c) => c.name));
  }

  if (spec.kind === "show") {
    await ctx.reply(
      `Scope for "${profile.name}": ${formatScope(
        profile.memoryScope,
        customs,
        restricted,
        profile.profileClass,
      )}`,
    );
    return;
  }

  const newScope: ProfileMemoryScope | null = spec.kind === "clear" ? null : spec.scope;
  const update = await transport.profiles.update(handle, profile.id, { memoryScope: newScope });
  if (update.isErr()) {
    await ctx.reply(errorMessage(update.error));
    return;
  }
  await ctx.reply(
    `Scope for "${profile.name}" updated: ${formatScope(
      newScope,
      customs,
      restricted,
      profile.profileClass,
    )}`,
  );
}

async function replyProfileStream(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  streamTokens: ReadonlyArray<string>,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE);
    return;
  }
  const resolved = await resolveProfileByName(transport, handle, name);
  if (resolved.kind === "error") {
    await ctx.reply(errorMessage(resolved.error));
    return;
  }
  if (resolved.kind === "none") {
    await ctx.reply(`No profile named "${name}".`);
    return;
  }
  if (resolved.kind === "ambiguous") {
    await ctx.reply(ambiguityMessage(name, resolved.matches));
    return;
  }
  const profile = resolved.profile;

  const spec = parseStreamSpec(streamTokens);
  if (spec.kind === "error") {
    await ctx.reply(spec.message);
    return;
  }
  if (spec.kind === "show") {
    await ctx.reply(formatStreamPrefs(profile.name, profile.streamChunkChars, profile.streamEdits));
    return;
  }
  const res = await transport.profiles.update(handle, profile.id, spec.changes);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    formatStreamPrefs(res.value.name, res.value.streamChunkChars, res.value.streamEdits),
  );
}

function formatStreamPrefs(name: string, chunk: number, edits: boolean): string {
  const editsLine = edits
    ? "edits on (mid-message edits + banners)"
    : "edits off (append-only; typing indicator for progress)";
  return `Stream prefs for "${name}":\n  chunk: ${chunk} chars\n  ${editsLine}`;
}

/**
 * `/profile autoapprove <name> [on|off]`. With no action, prints the
 * current mode. With `on`/`off`, flips the profile's plan-gate
 * autoapprove: `on` skips the Telegram approve/revise/cancel round trip
 * after the plan streams and auto-approves; `off` (default) keeps the
 * round trip.
 */
async function replyProfileAutoapprove(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  action: "on" | "off" | undefined,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE);
    return;
  }
  const resolved = await resolveProfileByName(transport, handle, name);
  if (resolved.kind === "error") {
    await ctx.reply(errorMessage(resolved.error));
    return;
  }
  if (resolved.kind === "none") {
    await ctx.reply(`No profile named "${name}".`);
    return;
  }
  if (resolved.kind === "ambiguous") {
    await ctx.reply(ambiguityMessage(name, resolved.matches));
    return;
  }
  const profile = resolved.profile;
  if (action === undefined) {
    await ctx.reply(formatAutoapprove(profile.name, profile.codingAutoapproveMode));
    return;
  }
  const res = await transport.profiles.update(handle, profile.id, {
    codingAutoapproveMode: action,
  });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(formatAutoapprove(res.value.name, res.value.codingAutoapproveMode));
}

function formatAutoapprove(name: string, mode: "off" | "on"): string {
  const tail =
    mode === "on"
      ? "on — plans auto-approve once persisted (no Telegram round trip)"
      : "off — Telegram approve tap required before execute";
  return `Autoapprove for "${name}": ${tail}`;
}

async function replyProfileClass(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  classOrClear: string,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE);
    return;
  }
  const resolved = await resolveProfileByName(transport, handle, name);
  if (resolved.kind === "error") {
    await ctx.reply(errorMessage(resolved.error));
    return;
  }
  if (resolved.kind === "none") {
    await ctx.reply(`No profile named "${name}".`);
    return;
  }
  if (resolved.kind === "ambiguous") {
    await ctx.reply(ambiguityMessage(name, resolved.matches));
    return;
  }
  const profile = resolved.profile;
  const className = classOrClear.toLowerCase() === "clear" ? null : classOrClear;
  const res = await transport.profiles.setClass(handle, profile.id, className);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (className === null) {
    await ctx.reply(`Class for "${profile.name}" cleared. Future memories will be untagged.`);
  } else {
    await ctx.reply(
      `Class for "${profile.name}" set to "${className}". Takes effect on the next Observer fire.`,
    );
  }
}
