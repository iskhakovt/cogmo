/**
 * Per-command Telegram handlers — extracted as pure `(transport, ctx) => void` functions so they
 * can be unit-tested without grammY plumbing. The adapter wires them to `bot.command(...)`.
 *
 * Subcommand parsing (`/profile switch <name>`, `/model <model>`) lives here rather than in
 * `index.ts` so the dispatcher logic is covered by unit tests.
 */

import { actionToDecision } from "../../../agent/coding/permission-keyboard.js";
import { MIN_MESSAGES_FOR_EXTRACTION } from "../../../agent/evolution/index.js";
import {
  CORE_COMPARTMENTS,
  isCoreCompartment,
  MemoryTrustSchema,
} from "../../../agent/evolution/memory-extraction-schema.js";
import type { Profile } from "../../../agent/store/index.js";
import { type ProfileMemoryScope, ProfileMemoryScopeSchema } from "../../../agent/store/schema.js";
import { SERVER_NAME_RE } from "../../../mcp/config.js";
import { truncate } from "../../../util/string.js";
import { isUuid } from "../../../util/uuid.js";
import type {
  EvolutionEventEntry,
  ScheduledTaskAdminEntry,
  Transport,
  TransportError,
} from "../../transport.js";
import type { ProfileDialogs } from "./profile-dialog.js";
import type { RepoDialogs } from "./repo-dialog.js";
import {
  formatScope,
  type InlineButton,
  renderConversationStatus,
  renderModelList,
  renderProfileList,
  renderSessionsList,
} from "./sessions-ux.js";

// Re-exported so tests that pin formatScope's contract via commands.ts
// keep working. The canonical implementation lives in sessions-ux.ts
// (render helper, used by both show-reply and list-line rendering).
export { formatScope };

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

const CORE_LIST = CORE_COMPARTMENTS.join(", ");

const USAGE = {
  resume: "Usage: /resume <alias>",
  name: "Usage: /name <alias>  (or /name -  to clear)",
  profile:
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
    `  Compartments: ${CORE_LIST}\n` +
    "  Trust:        first-party, any",
  classes:
    "Usage: /classes [list|add <name> <description>|rm <name>|restrict <name>|unrestrict <name>]\n" +
    "  /classes                          → list registered profile classes\n" +
    "  /classes add intimate <desc>      → register a new class for /profile class to reference\n" +
    "  /classes rm intimate              → remove a class (must not be assigned to any profile)\n" +
    "  /classes restrict intimate        → mark a class as restricted (recall fails closed unless opted in)\n" +
    "  /classes unrestrict intimate      → clear the restricted flag",
  compartments:
    "Usage: /compartments [list|add <name> <description>|rm <name>]\n" +
    "  /compartments                     → list registered custom compartments\n" +
    "  /compartments add dnd <desc>      → register a new compartment (description is read by the classifier LLM)\n" +
    "  /compartments rm dnd              → remove (forward-only: existing memory tags are kept)\n" +
    `  Core values (always available, not editable): ${CORE_LIST}`,
  model: "Usage: /model [<model>]",
  repo:
    "Usage: /repo [list|add [<name> <local_path> <remote_url>]|remove <name>]\n" +
    "  /repo add (no args)            → guided dialog: clones via the bot PAT\n" +
    "  /repo add <name> <path> <url>  → register an already-cloned repo (scripting)",
  mcp:
    "Usage: /mcp [list|add <name> <config-json>|remove <name>|approve <name> [<tool>]|reject <name> <tool>|pending]\n" +
    '  /mcp add github {"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":{"kind":"secret","name":"mcp:github:token"}}}\n' +
    "  /mcp approve <name>            → connect, snapshot tools (pending), mark server approved\n" +
    "  /mcp approve <name> <tool>     → flip a single tool to approved (visible to the agent)\n" +
    "  /mcp reject <name> <tool>      → mark tool rejected (hidden from the agent)",
  repair: "Usage: /repair  (or /repair <alias|uuid>  to target a specific conversation)",
  disable: "Usage: /disable <name>",
  enable: "Usage: /enable <name>",
  schedules:
    "Usage: /schedules [disable|enable|delete <id>]\n" +
    "  /schedules                   → list scheduled tasks (enabled + disabled)\n" +
    "  /schedules disable <id>      → soft-disable a task (keeps the row; won't fire)\n" +
    "  /schedules enable <id>       → re-enable a previously disabled task\n" +
    "  /schedules delete <id>       → permanently remove a task (no undo)\n" +
    "  Get task ids from `/schedules` output. Full UUID required.",
  learned:
    "Usage: /learned [<id>]\n" +
    "  /learned         → recent evolution events (newest first)\n" +
    "  /learned <id>    → full detail for one event (copy id from the list)",
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
  const target = ctx.match?.trim();
  if (!target) {
    await ctx.reply(USAGE.resume);
    return;
  }
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  // Accept both alias and UUID forms so `/sessions` numbered output (which emits `/resume <uuid>`
  // for unaliased entries) stays actionable. The callback-query path already does this.
  const isUuid = looksLikeUuid(target);
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
    await ctx.reply(USAGE.name);
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
        await ctx.reply(USAGE.profile);
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
    default:
      await ctx.reply(USAGE.profile);
  }
}

export async function handleClasses(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const trimmed = (ctx.match ?? "").trim();
  if (!trimmed) {
    return replyClassesList(transport, ctx, handle);
  }
  const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  switch (sub) {
    case "list":
      return replyClassesList(transport, ctx, handle);
    case "add": {
      // Add takes a name (single token) plus a free-form description (rest).
      // Empty description is rejected at the Transport boundary by the
      // store's NOT NULL on `description`; we surface that with a clearer
      // message here.
      const name = rest[0]?.trim();
      const description = rest.slice(1).join(" ").trim();
      if (!name || !description) {
        await ctx.reply(USAGE.classes);
        return;
      }
      return replyClassesAdd(transport, ctx, handle, name, description);
    }
    case "rm":
    case "remove":
    case "delete": {
      const name = rest.join(" ").trim();
      if (!name) {
        await ctx.reply(USAGE.classes);
        return;
      }
      return replyClassesDelete(transport, ctx, handle, name);
    }
    case "restrict":
    case "unrestrict": {
      const name = rest.join(" ").trim();
      if (!name) {
        await ctx.reply(USAGE.classes);
        return;
      }
      return replyClassesSetRestricted(transport, ctx, handle, name, sub === "restrict");
    }
    default:
      await ctx.reply(USAGE.classes);
  }
}

export async function handleCompartments(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const trimmed = (ctx.match ?? "").trim();
  if (!trimmed) {
    return replyCompartmentsList(transport, ctx, handle);
  }
  const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  switch (sub) {
    case "list":
      return replyCompartmentsList(transport, ctx, handle);
    case "add": {
      const name = rest[0]?.trim();
      const description = rest.slice(1).join(" ").trim();
      if (!name || !description) {
        await ctx.reply(USAGE.compartments);
        return;
      }
      return replyCompartmentsAdd(transport, ctx, handle, name, description);
    }
    case "rm":
    case "remove":
    case "delete": {
      const name = rest.join(" ").trim();
      if (!name) {
        await ctx.reply(USAGE.compartments);
        return;
      }
      return replyCompartmentsDelete(transport, ctx, handle, name);
    }
    default:
      await ctx.reply(USAGE.compartments);
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

/**
 * Result the Telegram adapter renders for a plan-callback tap. Pure data —
 * `editText` replaces the plan-message body (and clears the keyboard);
 * `followUp`, when set, posts as a separate chat message (used by Revise);
 * `toast` is the small popup Telegram shows on the tapping device only.
 */
export interface PlanCallbackOutcome {
  editText: string;
  followUp?: string;
  toast: string;
}

/**
 * Pure handler for Approve / Revise / Cancel taps on the plan keyboard.
 * Resolves identity (only the conversation owner can act), dispatches the
 * appropriate `transport.coding.*` call, and returns the rendering
 * instructions for the Telegram side.
 *
 * Idempotent against double-taps via Transport's atomic store methods.
 */
export async function handlePlanCallback(
  transport: Transport,
  parsed: { taskId: string; action: "approve" | "revise" | "cancel" },
  tapperPlatformHandle: string,
): Promise<PlanCallbackOutcome> {
  if (parsed.action === "approve") {
    const res = await transport.coding.approvePlan(parsed.taskId, tapperPlatformHandle);
    if (res.isErr()) return { editText: errorMessage(res.error), toast: errorMessage(res.error) };
    return {
      editText: "✅ Plan approved. Execution starting…",
      toast: "Approved",
    };
  }

  // Revise & Cancel both end the current task — Revise additionally tells
  // the user how to continue. Slice 2's "revise" is conversational
  // (matches Cursor / Devin / Claude Code's plan mode): the user describes
  // what to change, and the agent issues a fresh delegate_coding next
  // turn. In-place plan editing requires an editor surface Telegram
  // doesn't have.
  const reason =
    parsed.action === "revise" ? "user requested revisions" : "user cancelled the plan";
  const res = await transport.coding.cancelTask(parsed.taskId, tapperPlatformHandle, reason);
  if (res.isErr()) return { editText: errorMessage(res.error), toast: errorMessage(res.error) };

  if (parsed.action === "revise") {
    return {
      editText: "✏️ Plan revised — see follow-up.",
      followUp:
        "Tell me what you'd like changed about the plan, and I'll re-delegate with your " +
        "feedback.",
      toast: "Revising",
    };
  }
  return { editText: "❌ Plan cancelled.", toast: "Cancelled" };
}

export interface PermissionCallbackOutcome {
  /** Replacement text for the original prompt message (keyboard cleared too). */
  editText: string;
  /** Short toast popup confirming the tap on the user's device. */
  toast: string;
}

/**
 * Tool-gate callback handler — translates a parsed permission button tap
 * into a Transport call + an outcome the adapter renders. Identity check
 * happens inside `transport.coding.respondPermission`.
 */
export async function handlePermissionCallback(
  transport: Transport,
  parsed: {
    taskId: string;
    requestIdShort: string;
    action: "allow_once" | "allow_task" | "deny";
  },
  tapperPlatformHandle: string,
): Promise<PermissionCallbackOutcome> {
  // Single source of truth for the action → (decision, scope) mapping.
  // Lives in `permission-keyboard.ts` alongside `PermissionAction`; the
  // mapping must agree with what's encoded into callback_data, so any
  // future addition (e.g. `deny_task`) only needs editing in one place.
  const { decision, scope } = actionToDecision(parsed.action);

  const res = await transport.coding.respondPermission(
    {
      taskId: parsed.taskId,
      requestIdShort: parsed.requestIdShort,
      decision,
      scope,
    },
    tapperPlatformHandle,
  );
  if (res.isErr()) {
    return { editText: errorMessage(res.error), toast: errorMessage(res.error) };
  }

  switch (parsed.action) {
    case "allow_once":
      return { editText: "✅ Allowed once.", toast: "Allowed" };
    case "allow_task":
      return {
        editText: "✅ Allowed for this task — future matching requests auto-approve.",
        toast: "Allowed for task",
      };
    case "deny":
      return { editText: "❌ Denied.", toast: "Denied" };
  }
}

export interface SkillsApprovalCallbackOutcome {
  editText: string;
  toast: string;
}

/**
 * Skills-deploy approve-tier callback handler — translates a parsed Approve /
 * Deny tap into a `transport.skills.{approveDeploy,denyDeploy}` call and an
 * outcome the adapter renders. Identity check happens inside the Transport
 * layer (`checkSkillsTapper`).
 */
export async function handleSkillsApprovalCallback(
  transport: Transport,
  parsed: { pendingId: string; action: "approve" | "deny" },
  tapperPlatformHandle: string,
): Promise<SkillsApprovalCallbackOutcome> {
  if (parsed.action === "approve") {
    const res = await transport.skills.approveDeploy(parsed.pendingId, tapperPlatformHandle);
    if (res.isErr()) {
      return { editText: errorMessage(res.error), toast: errorMessage(res.error) };
    }
    return {
      editText: `✅ Approved: '${res.value.skillName}' is now live (${res.value.gitSha.slice(0, 7)}).`,
      toast: "Approved",
    };
  }
  // deny
  const res = await transport.skills.denyDeploy(parsed.pendingId, tapperPlatformHandle);
  if (res.isErr()) {
    return { editText: errorMessage(res.error), toast: errorMessage(res.error) };
  }
  return {
    editText: "❌ Deploy denied — no main advance. Re-register a different version to retry.",
    toast: "Denied",
  };
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

type ProfileResolution =
  | { kind: "ok"; profile: Profile }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: ReadonlyArray<Profile> }
  | { kind: "error"; error: TransportError };

/**
 * Resolve a user-typed profile name. Org and user profiles can share a name (uniqueness is per
 * user_id), so when both exist we prefer the caller-owned one. Transport doesn't expose the
 * caller's userId directly, but `profiles.list` only returns org profiles + caller's own —
 * so any non-null userId in the result IS the caller's.
 */
async function resolveProfileByName(
  transport: Transport,
  handle: string,
  name: string,
): Promise<ProfileResolution> {
  const list = await transport.profiles.list(handle);
  if (list.isErr()) return { kind: "error", error: list.error };
  const matches = list.value.filter((p) => p.name === name);
  const [firstMatch] = matches;
  if (!firstMatch) return { kind: "none" };
  if (matches.length === 1) return { kind: "ok", profile: firstMatch };
  // Exactly one user-owned match among several (org + user with same name) → pick the user one.
  const owned = matches.filter((p) => p.userId !== null);
  const [firstOwned] = owned;
  if (owned.length === 1 && firstOwned) return { kind: "ok", profile: firstOwned };
  return { kind: "ambiguous", matches };
}

/**
 * `/repair` — flip a conversation's status from `errored` back to `active`.
 *
 * `/repair`              → acts on the current session's conversation.
 * `/repair <alias|uuid>` → acts on the named conversation.
 *
 * The user-facing escape hatch over `recover-conversation`'s automated
 * `mark-errored` write. Idempotent — repairing an already-active
 * conversation succeeds with a "no-op" reply rather than erroring.
 */
export async function handleRepair(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const arg = ctx.match?.trim();

  let conversationId: string | undefined;
  let label: string;
  if (arg) {
    if (looksLikeUuid(arg)) {
      conversationId = arg;
      label = arg;
    } else {
      const list = await transport.conversations.list(handle);
      if (list.isErr()) {
        await ctx.reply(errorMessage(list.error));
        return;
      }
      const match = list.value.find((c) => c.alias === arg);
      if (!match) {
        await ctx.reply(`No conversation with alias "${arg}". Use /sessions to list.`);
        return;
      }
      conversationId = match.id;
      label = arg;
    }
  } else {
    const session = await transport.resolveSession(addr);
    if (!session) {
      await ctx.reply("No active conversation. Use /sessions and /resume <alias> first.");
      return;
    }
    conversationId = session.conversationId;
    label = "current conversation";
  }

  const res = await transport.conversations.repair(handle, conversationId);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.wasErrored) {
    await ctx.reply(`Repaired ${label}. Send a message to retry.`);
  } else {
    await ctx.reply(`${label} is already active — nothing to repair.`);
  }
}

/**
 * `/voice` — set the per-conversation voice mode override.
 *
 * Forms:
 *   /voice                    — show the current effective mode + provider
 *   /voice auto               — mirror inbound modality (voice in → voice out)
 *   /voice always             — TTS every reply
 *   /voice off | /voice never — text only
 *   /voice clear              — clear override; follow profile default
 *
 * Mutates `conversations.voice_mode` via Transport.conversations.setVoiceMode.
 */
export async function handleVoice(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const arg = ctx.match?.trim().toLowerCase() ?? "";

  const session = await transport.resolveSession(addr);
  if (!session) {
    await ctx.reply("No active conversation. Send a message first.");
    return;
  }
  const conversationId = session.conversationId;

  if (arg === "") {
    // Show current — read directly via getCurrent.
    const current = await transport.conversations.getCurrent(handle, addr);
    if (current.isErr()) {
      await ctx.reply(errorMessage(current.error));
      return;
    }
    const mode = current.value?.voiceMode ?? null;
    const label = mode === null ? "follow profile default" : mode;
    await ctx.reply(
      [
        `Voice mode: ${label}`,
        "",
        "Set: /voice auto | /voice always | /voice off",
        "Clear override: /voice clear",
      ].join("\n"),
    );
    return;
  }

  let mode: "auto" | "always" | "never" | null;
  if (arg === "auto") mode = "auto";
  else if (arg === "always") mode = "always";
  else if (arg === "off" || arg === "never") mode = "never";
  else if (arg === "clear") mode = null;
  else {
    await ctx.reply("Usage: /voice [auto|always|off|clear]");
    return;
  }

  const res = await transport.conversations.setVoiceMode(handle, conversationId, mode);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  const label = mode === null ? "cleared (following profile default)" : mode;
  await ctx.reply(`Voice mode: ${label}`);
}

/**
 * `/status` — show the active conversation's profile, last-turn token use,
 * steering rules, and MCP fan-out at a glance. Read-only, no LLM call.
 */
export async function handleStatus(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const res = await transport.conversations.summary(handle, addr);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (!res.value) {
    await ctx.reply("No active conversation yet — send a message first.");
    return;
  }
  // Mirror replyProfileScope's conditional-fetch pattern: load the
  // customs / restricted-classes registries only when the rendered scope
  // can actually surface a marker, so a `/status` on an unscoped profile
  // doesn't pay for two extra round-trips. Both fetches degrade
  // best-effort — the user asked for status, not a registry list, so
  // a registry error renders without markers rather than failing.
  const summary = res.value;
  const scope = summary.profile.memoryScope;
  const needsCustoms = scope?.compartments.some((c) => !isCoreCompartment(c)) ?? false;
  const hasClasses = scope?.profileClasses !== undefined && scope.profileClasses.length > 0;
  const hasSpeaker = summary.profile.profileClass !== null;
  // Restricted markers can fire either inside `formatScope` (when the
  // scope sets profileClasses) or via the speaker auto-include rendering,
  // which appends the speaker class even when the operator's list omits
  // it. Both paths consult the restricted-class set, so fetch whenever
  // either could fire.
  const needsRestricted = hasClasses || hasSpeaker;
  const customsRes = needsCustoms ? await transport.compartments.list(handle) : undefined;
  const customs = customsRes?.isOk() ? new Set(customsRes.value.map((c) => c.name)) : undefined;
  const classesRes = needsRestricted ? await transport.profileClasses.list(handle) : undefined;
  const restrictedClasses = classesRes?.isOk()
    ? new Set(classesRes.value.filter((c) => c.restricted).map((c) => c.name))
    : undefined;
  await ctx.reply(
    renderConversationStatus(summary, {
      ...(customs !== undefined && { customCompartments: customs }),
      ...(restrictedClasses !== undefined && { restrictedClasses }),
    }),
  );
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

function ambiguityMessage(name: string, matches: ReadonlyArray<Profile>): string {
  const scopes = matches.map((p) => (p.userId === null ? "org" : "user")).join(", ");
  return `Profile name "${name}" is ambiguous (${matches.length} matches: ${scopes}). Use /profile list to see all and pick a unique one.`;
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
    await ctx.reply(USAGE.profile);
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
    await ctx.reply(USAGE.profile);
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

// ── /profile scope ────────────────────────────────────────────────────

/**
 * Tokens that look like a scope-spec atom: the literal `clear` or any
 * `<key>=<value>` shape. Used by `splitScopeArgs` to find the name/spec
 * boundary when the profile name contains spaces.
 *
 * The shape check is keyword-agnostic on purpose — any `key=value`
 * routes to `parseScopeSpec`, where unknown keys (typos like
 * `compartment=` instead of `compartments=`) surface as a precise
 * "Unknown key …" error. Tying the shape to known keys would silently
 * drop typos into the name and fail with a confusing "No profile
 * named …" instead.
 */
function isScopeShape(token: string): boolean {
  return token.toLowerCase() === "clear" || /^[a-z]+=/i.test(token);
}

/**
 * Split `rest` into a (multi-token) profile name and the trailing scope
 * spec. Walks from the end so multi-word names work — e.g.
 * `["my", "work", "clear"]` → name = "my work", spec = ["clear"].
 *
 * Exposed for unit tests; the only caller is the `scope` subcommand
 * dispatcher in `handleProfile`.
 */
export function splitScopeArgs(rest: ReadonlyArray<string>): {
  name: string;
  scopeTokens: ReadonlyArray<string>;
} {
  let splitAt = rest.length;
  while (splitAt > 0 && isScopeShape(rest[splitAt - 1] ?? "")) splitAt--;
  return {
    name: rest.slice(0, splitAt).join(" "),
    scopeTokens: rest.slice(splitAt),
  };
}

/**
 * Pure parser for the scope spec — the tokens after `<name>` in
 * `/profile scope <name> …`. Exposed for unit testing.
 *
 * Forms:
 *   []                                        → show current scope
 *   ["clear"]                                 → set null (unrestricted)
 *   ["compartments=…", "trust=…"]             → set (both keys required, any order)
 */
export type ScopeSpec =
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "set"; scope: ProfileMemoryScope }
  | { kind: "error"; message: string };

export function parseScopeSpec(tokens: ReadonlyArray<string>): ScopeSpec {
  const trimmed = tokens.map((t) => t.trim()).filter(Boolean);
  if (trimmed.length === 0) return { kind: "show" };
  if (trimmed.length === 1 && trimmed[0]?.toLowerCase() === "clear") return { kind: "clear" };

  const collected: { compartments?: string[]; trust?: string[]; profileClasses?: string[] } = {};
  for (const token of trimmed) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      return {
        kind: "error",
        message: `Bad token "${token}". Expected compartments=…, trust=…, or classes=… (or "clear" alone).`,
      };
    }
    const key = token.slice(0, eq).toLowerCase();
    const values = token
      .slice(eq + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // The DB / Zod schema field is `profileClasses`; the user-facing token
    // is `classes=` because the type-it-into-Telegram form benefits from
    // brevity. Translate at the parser boundary so the two layers can
    // evolve independently.
    if (key === "compartments" || key === "trust") {
      if (collected[key] !== undefined) {
        return {
          kind: "error",
          message: `Key "${key}" repeated. Combine values into a single comma-separated list.`,
        };
      }
      collected[key] = values;
    } else if (key === "classes") {
      if (collected.profileClasses !== undefined) {
        return {
          kind: "error",
          message: `Key "classes" repeated. Combine values into a single comma-separated list.`,
        };
      }
      collected.profileClasses = values;
    } else {
      return {
        kind: "error",
        message: `Unknown key "${key}". Expected compartments, trust, or classes.`,
      };
    }
  }
  if (!collected.compartments || !collected.trust) {
    return {
      kind: "error",
      message:
        "Both compartments=… and trust=… are required when setting a scope. Use 'clear' to remove.",
    };
  }

  const parsed = ProfileMemoryScopeSchema.safeParse(collected);
  if (!parsed.success) {
    return {
      kind: "error",
      message:
        `Invalid scope: ${parsed.error.issues.map((i) => i.message).join("; ")}\n` +
        `Compartments (core): ${CORE_LIST} (custom values from /compartments are also accepted)\n` +
        `Trust:        ${MemoryTrustSchema.options.join(", ")}`,
    };
  }
  return { kind: "set", scope: parsed.data };
}

async function replyProfileScope(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  scopeTokens: ReadonlyArray<string>,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE.profile);
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

// ── /profile stream ───────────────────────────────────────────────────

/**
 * Split `rest` into a (multi-token) profile name and the trailing
 * `<key>=<value>` stream tokens. Walks from the end like `splitScopeArgs`
 * but the shape predicate is stricter: only `<key>=<value>` counts as a
 * trailing token. A profile literally named `clear` can be addressed
 * here (unlike `/profile scope`), since stream has no bare-keyword form.
 *
 * Exposed for unit tests; the only caller is the `stream` subcommand
 * dispatcher in `handleProfile`.
 */
export function splitStreamArgs(rest: ReadonlyArray<string>): {
  name: string;
  streamTokens: ReadonlyArray<string>;
} {
  let splitAt = rest.length;
  while (splitAt > 0 && /^[a-z]+=/i.test(rest[splitAt - 1] ?? "")) splitAt--;
  return {
    name: rest.slice(0, splitAt).join(" "),
    streamTokens: rest.slice(splitAt),
  };
}

/**
 * Pure parser for the stream spec — the tokens after `<name>` in
 * `/profile stream <name> …`. Exposed for unit testing.
 *
 * Forms:
 *   []                                        → show current prefs
 *   ["chunk=500"]                             → set chunk only
 *   ["edits=off"]                             → set edits only (on|off|true|false)
 *   ["chunk=500", "edits=off"]                → set both
 *
 * Range for chunk mirrors the `chk_profiles_stream_chunk_chars` CHECK:
 * 100..4000. The DB rejects out-of-range writes; this parser surfaces a
 * friendlier message before the round trip.
 */
export type StreamSpec =
  | { kind: "show" }
  | { kind: "set"; changes: { streamChunkChars?: number; streamEdits?: boolean } }
  | { kind: "error"; message: string };

export function parseStreamSpec(tokens: ReadonlyArray<string>): StreamSpec {
  const trimmed = tokens.map((t) => t.trim()).filter(Boolean);
  if (trimmed.length === 0) return { kind: "show" };
  const changes: { streamChunkChars?: number; streamEdits?: boolean } = {};
  for (const token of trimmed) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      return {
        kind: "error",
        message: `Bad token "${token}". Expected chunk=<n> or edits=on|off.`,
      };
    }
    const key = token.slice(0, eq).toLowerCase();
    const raw = token.slice(eq + 1).trim();
    if (key === "chunk") {
      if (changes.streamChunkChars !== undefined) {
        return { kind: "error", message: `Key "chunk" repeated.` };
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 100 || n > 4000) {
        return {
          kind: "error",
          message: `chunk must be an integer between 100 and 4000 (got "${raw}").`,
        };
      }
      changes.streamChunkChars = n;
    } else if (key === "edits") {
      if (changes.streamEdits !== undefined) {
        return { kind: "error", message: `Key "edits" repeated.` };
      }
      const v = raw.toLowerCase();
      if (v === "on" || v === "true") {
        changes.streamEdits = true;
      } else if (v === "off" || v === "false") {
        changes.streamEdits = false;
      } else {
        return {
          kind: "error",
          message: `edits must be on|off (got "${raw}").`,
        };
      }
    } else {
      return {
        kind: "error",
        message: `Unknown key "${key}". Expected chunk or edits.`,
      };
    }
  }
  return { kind: "set", changes };
}

async function replyProfileStream(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  streamTokens: ReadonlyArray<string>,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE.profile);
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

// ── /profile class + /classes ─────────────────────────────────────────

async function replyProfileClass(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  classOrClear: string,
): Promise<void> {
  if (!name) {
    await ctx.reply(USAGE.profile);
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

async function replyClassesList(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
): Promise<void> {
  const res = await transport.profileClasses.list(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.length === 0) {
    await ctx.reply(
      "No profile classes registered. Use /classes add <name> <description> to create one.",
    );
    return;
  }
  let sawRestricted = false;
  const lines = res.value.map((c) => {
    if (c.restricted) sawRestricted = true;
    const marker = c.restricted ? " (restricted)" : "";
    return `• ${c.name}${marker} — ${c.description}`;
  });
  const legend = sawRestricted
    ? "\n\n(restricted) — readers must opt in via /profile scope … classes=… or speak as the class."
    : "";
  await ctx.reply(`Profile classes:\n${lines.join("\n")}${legend}`);
}

async function replyClassesSetRestricted(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  restricted: boolean,
): Promise<void> {
  const res = await transport.profileClasses.setRestricted(handle, name, restricted);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (restricted) {
    await ctx.reply(
      `Class "${name}" marked restricted. Readers without an explicit opt-in (or that don't speak as "${name}") won't see its memories.`,
    );
  } else {
    await ctx.reply(
      `Class "${name}" no longer restricted. Recall returns to open-by-default for this class.`,
    );
  }
}

/**
 * Names that collide with `/profile class <name> …` parser sentinels —
 * any class named "clear" is creatable but unaddressable here because
 * `replyProfileClass` interprets `clear` as the clear-action. Reject
 * up front so the user sees an actionable error instead of creating
 * a class they can't assign via Telegram.
 *
 * The reserve lives at the Telegram boundary (not Transport / store)
 * because "clear" is a string-parser ambiguity specific to this
 * adapter — a future REST adapter taking `{className: null}` for the
 * clear case has no such conflict, and pushing the reserve down would
 * over-constrain it. A direct `Transport.profileClasses.create` caller
 * (Direct adapter, scripts) can still create a class named `clear`;
 * it just won't be addressable via `/profile class … clear` until the
 * Telegram parser learns a different sentinel.
 */
const RESERVED_CLASS_NAMES = new Set(["clear"]);

async function replyClassesAdd(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  description: string,
): Promise<void> {
  if (RESERVED_CLASS_NAMES.has(name.toLowerCase())) {
    await ctx.reply(
      `"${name}" is reserved (used by /profile class <name> clear). Pick a different class name.`,
    );
    return;
  }
  const res = await transport.profileClasses.create(handle, { name, description });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Registered class "${res.value.name}". Assign it with /profile class <profile> ${res.value.name}.`,
  );
}

async function replyClassesDelete(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
): Promise<void> {
  const res = await transport.profileClasses.delete(handle, name);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(`Class "${name}" removed.`);
}

async function replyCompartmentsList(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
): Promise<void> {
  const res = await transport.compartments.list(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.length === 0) {
    await ctx.reply(
      `No custom compartments registered. Use /compartments add <name> <description> to create one.\n\nCore (always available): ${CORE_LIST}`,
    );
    return;
  }
  const lines = res.value.map((c) => `• ${c.name} — ${c.description}`);
  await ctx.reply(
    `Custom compartments:\n${lines.join("\n")}\n\nCore (always available): ${CORE_LIST}`,
  );
}

async function replyCompartmentsAdd(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  description: string,
): Promise<void> {
  const res = await transport.compartments.create(handle, { name, description });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Registered compartment "${res.value.name}". The description you wrote is the classifier's instruction sheet — the LLM reads it on every Observer fire to decide when to use this bucket. Takes effect on the next fire; facts picked for it will be tagged compartment:${res.value.name}.`,
  );
}

async function replyCompartmentsDelete(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
): Promise<void> {
  const res = await transport.compartments.delete(handle, name);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Compartment "${name}" removed. Forward-only — existing memories tagged compartment:${name} are kept; the classifier will stop picking this bucket for new facts.`,
  );
}

// ── /repo ─────────────────────────────────────────────────────────────

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
    // No positional args → guided dialog (slice 4.0c). When the FSM isn't
    // wired (e.g. unit tests for the positional path), fall through to the
    // usage hint so the operator gets a clear nudge instead of silence.
    if (!name && !localPath && !remoteUrl) {
      if (repoDialogs) {
        await repoDialogs.start(ctx);
        return;
      }
      await ctx.reply(USAGE.repo);
      return;
    }
    if (!name || !localPath || !remoteUrl) {
      await ctx.reply(USAGE.repo);
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
      await ctx.reply(USAGE.repo);
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

  await ctx.reply(USAGE.repo);
}

// ── /mcp ──────────────────────────────────────────────────────────────

export async function handleMcp(transport: Transport, ctx: TelegramCommandContext): Promise<void> {
  const handle = String(ctx.from.id);
  const raw = (ctx.match ?? "").trim();
  if (!raw) {
    await ctx.reply(USAGE.mcp);
    return;
  }

  // Parse the leading subcommand off; preserve the rest verbatim because
  // /mcp add carries trailing JSON which must not be re-tokenised.
  const firstSpace = raw.indexOf(" ");
  const subcommand = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();

  switch (subcommand) {
    case "list": {
      const res = await transport.mcp.listServers(handle);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      if (res.value.length === 0) {
        await ctx.reply("No MCP servers configured. Add one with `/mcp add <name> <config-json>`.");
        return;
      }
      const lines = res.value.map((s) => {
        const transportKind = s.config.transport;
        const enabledMark = s.enabled ? "" : " (disabled)";
        const counts = `${s.approvedToolCount}/${s.toolCount} tool${s.toolCount === 1 ? "" : "s"} approved`;
        const tail = s.lastError ? ` — last error: ${truncate(s.lastError, 80)}` : "";
        return `${s.name} [${transportKind}] — ${s.approvalStatus}, ${counts}${enabledMark}${tail}`;
      });
      // Budget warning: when the total approved-tool count across all enabled
      // servers exceeds the configured cap, `resolveTools` drops the tail
      // alphabetically every turn. Surface a notice on `/mcp list` so the
      // operator sees this without having to read logs.
      const approvedTotal = res.value
        .filter((s) => s.enabled && s.approvalStatus === "approved")
        .reduce((sum, s) => sum + s.approvedToolCount, 0);
      const budget = transport.mcp.toolBudget();
      const budgetNote =
        budget > 0 && approvedTotal > budget
          ? `\n\n⚠ ${approvedTotal} approved tools exceed budget ${budget} — ${approvedTotal - budget} will be dropped per turn alphabetically. Tighten profile.toolSet globs to pick which tools the agent sees.`
          : "";
      await ctx.reply(`MCP servers:\n${lines.join("\n")}${budgetNote}`);
      return;
    }

    case "pending": {
      const res = await transport.mcp.listServers(handle);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      const pending = res.value.filter(
        (s) => s.approvalStatus !== "approved" || s.toolCount > s.approvedToolCount,
      );
      if (pending.length === 0) {
        await ctx.reply("Nothing pending — every server and tool is approved.");
        return;
      }
      const lines = pending.map((s) => {
        const tail =
          s.toolCount > s.approvedToolCount
            ? ` (${s.toolCount - s.approvedToolCount} tool${s.toolCount - s.approvedToolCount === 1 ? "" : "s"} pending)`
            : "";
        return `${s.name} — server status: ${s.approvalStatus}${tail}`;
      });
      await ctx.reply(`Pending approvals:\n${lines.join("\n")}`);
      return;
    }

    case "add": {
      // Pre-check the name shape against the same regex the store enforces,
      // so a typo'd name surfaces a precise error instead of round-tripping
      // through the schema layer as a generic mcp_invalid_config.
      const nameMatch = rest.match(/^(\S+)\s+(\{.*\})$/s);
      if (!nameMatch || nameMatch[1] === undefined || nameMatch[2] === undefined) {
        await ctx.reply(USAGE.mcp);
        return;
      }
      const name = nameMatch[1];
      const json = nameMatch[2];
      if (!SERVER_NAME_RE.test(name)) {
        await ctx.reply(
          `Invalid MCP server name: ${JSON.stringify(name)} — must match ${SERVER_NAME_RE.source} (lowercase, alphanumerics, single underscores between segments).`,
        );
        return;
      }
      let config: unknown;
      try {
        config = JSON.parse(json);
      } catch (e) {
        await ctx.reply(
          `Invalid JSON: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE.mcp}`,
        );
        return;
      }
      const res = await transport.mcp.addServer(handle, {
        name,
        // Validation runs server-side via McpServerConfigSchema; pass through.
        config: config as never,
        enabled: true,
      });
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      await ctx.reply(
        `MCP server "${res.value.name}" added (status: ${res.value.approvalStatus}).\nRun /mcp approve ${res.value.name} to connect, snapshot tools, and enable approval.`,
      );
      return;
    }

    case "remove":
    case "rm": {
      const name = rest.split(/\s+/)[0];
      if (!name) {
        await ctx.reply(USAGE.mcp);
        return;
      }
      const lookup = await transport.mcp.listServers(handle);
      if (lookup.isErr()) {
        await ctx.reply(errorMessage(lookup.error));
        return;
      }
      const server = lookup.value.find((s) => s.name === name);
      if (!server) {
        await ctx.reply(`No MCP server named "${name}".`);
        return;
      }
      const res = await transport.mcp.removeServer(handle, server.id);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      await ctx.reply(`MCP server "${name}" removed.`);
      return;
    }

    case "approve": {
      const args = rest.split(/\s+/).filter(Boolean);
      const [name, toolName] = args;
      if (!name) {
        await ctx.reply(USAGE.mcp);
        return;
      }
      const lookup = await transport.mcp.listServers(handle);
      if (lookup.isErr()) {
        await ctx.reply(errorMessage(lookup.error));
        return;
      }
      const server = lookup.value.find((s) => s.name === name);
      if (!server) {
        await ctx.reply(`No MCP server named "${name}".`);
        return;
      }

      if (toolName) {
        const res = await transport.mcp.approveTool(handle, server.id, toolName);
        if (res.isErr()) {
          await ctx.reply(errorMessage(res.error));
          return;
        }
        await ctx.reply(`Tool "${name}.${toolName}" approved.`);
        return;
      }

      const res = await transport.mcp.approveServer(handle, server.id);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      await ctx.reply(
        `MCP server "${name}" approved.\nTools snapshotted as pending — run /mcp approve ${name} <tool> per tool to surface them to the agent.`,
      );
      return;
    }

    case "reject": {
      const [name, toolName] = rest.split(/\s+/).filter(Boolean);
      if (!name || !toolName) {
        await ctx.reply(USAGE.mcp);
        return;
      }
      const lookup = await transport.mcp.listServers(handle);
      if (lookup.isErr()) {
        await ctx.reply(errorMessage(lookup.error));
        return;
      }
      const server = lookup.value.find((s) => s.name === name);
      if (!server) {
        await ctx.reply(`No MCP server named "${name}".`);
        return;
      }
      const res = await transport.mcp.rejectTool(handle, server.id, toolName);
      if (res.isErr()) {
        await ctx.reply(errorMessage(res.error));
        return;
      }
      await ctx.reply(`Tool "${name}.${toolName}" rejected.`);
      return;
    }

    default:
      await ctx.reply(USAGE.mcp);
  }
}

// ── /skills, /disable, /enable ────────────────────────────────────────

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
    await ctx.reply(USAGE.disable);
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
    await ctx.reply(USAGE.enable);
    return;
  }
  const handle = String(ctx.from.id);
  const res = await transport.skills.enable(handle, name);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.alreadyEnabled) {
    await ctx.reply(`Skill "${res.value.name}" is already enabled.`);
  } else {
    await ctx.reply(`Skill "${res.value.name}" enabled.`);
  }
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
  }
}

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// ── /schedules ────────────────────────────────────────────────────────

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
    await ctx.reply(USAGE.schedules);
    return;
  }
  if (!id) {
    await ctx.reply(USAGE.schedules);
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

/**
 * Treat a `/resume <target>` argument as a UUID iff it matches the
 * standard 8-4-4-4-12 shape. Slice 2 enforced version-7 strictly; we
 * relax to any-version because the Telegram surface only uses this
 * to disambiguate UUID-looking strings from aliases — handing a
 * structurally-valid-but-unknown UUID to \`resumeConversation\` falls
 * through to an honest \"not found\" error.
 */
function looksLikeUuid(s: string): boolean {
  return isUuid(s.toLowerCase());
}

// ── /learned + /reflect ───────────────────────────────────────────────

/**
 * `/learned` — list the most recent evolution events for the user.
 * `/learned <id>` — detail view for one event.
 *
 * Surfaces the audit log written by every processed Observer fire (both
 * autonomous on `conversation/idle` and manual via `/reflect`). The digest
 * shows enough to spot what changed at a glance; the detail view fans out
 * each branch (corrections / memories / consolidation / pending drain).
 *
 * See `design/evolution.md` → Audit Log & Manual Trigger.
 */
export async function handleLearned(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const arg = ctx.match?.trim() ?? "";

  if (arg === "") {
    const res = await transport.evolution.listEvents(handle, { limit: 10 });
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    if (res.value.length === 0) {
      await ctx.reply(
        "No evolution events yet. The Observer runs after a conversation goes idle, " +
          "or you can run it now with /reflect.",
      );
      return;
    }
    await ctx.reply(formatEvolutionDigest(res.value));
    return;
  }

  // Anything else is treated as an id lookup. Reject obviously-bad shapes
  // early so the DB hit only happens on plausible UUIDs.
  if (!looksLikeUuid(arg)) {
    await ctx.reply(USAGE.learned);
    return;
  }

  const res = await transport.evolution.getEvent(handle, arg);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value === null) {
    await ctx.reply(`No evolution event with id "${shortenId(arg)}". Use /learned to list.`);
    return;
  }
  await ctx.reply(formatEvolutionDetail(res.value));
}

/**
 * `/reflect` — run the Observer synchronously for the current conversation
 * and reply with a one-line digest. The autonomous idle-fire path is
 * untouched; this is the user-initiated debug-shaped trigger that lets the
 * operator see what extraction would do without waiting for idle.
 *
 * Respects the same min-message gate (`MIN_MESSAGES_FOR_EXTRACTION = 4`)
 * as the autonomous path — too-short conversations reply with a clear
 * "not enough yet" message rather than silently no-op.
 */
export async function handleReflect(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);

  await ctx.reply("Reflecting on this conversation…");

  const res = await transport.evolution.triggerReflection(handle, addr);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }

  const outcome = res.value;
  switch (outcome.status) {
    case "no_session":
      await ctx.reply("No active conversation here — send a message first.");
      return;
    case "skipped": {
      const message =
        outcome.reason === "too_short"
          ? `Conversation too short to reflect on yet (need at least ${MIN_MESSAGES_FOR_EXTRACTION} messages).`
          : // `conversation_not_found` / `profile_not_found` mean the underlying
            // row vanished mid-call — surfaces as a soft error rather than an
            // exception so the command doesn't crash the bot.
            "Couldn't load the conversation. Try /sessions to confirm it's there.";
      await ctx.reply(message);
      return;
    }
    case "processed": {
      const { ruleChanges, memoryCount, drained, eventId } = outcome;
      const ruleSummary =
        ruleChanges.extracted + ruleChanges.reinforced + ruleChanges.promoted === 0
          ? "no rule changes"
          : `${ruleChanges.extracted} new, ${ruleChanges.reinforced} reinforced, ${ruleChanges.promoted} promoted`;
      const memorySummary =
        memoryCount === 0 && drained === 0
          ? "no memories"
          : `${memoryCount} extracted, ${drained} drained`;
      await ctx.reply(
        `Reflected. Rules: ${ruleSummary}. Memories: ${memorySummary}.\n` +
          `/learned ${eventId} for the full breakdown.`,
      );
      return;
    }
  }
}

/**
 * Render the `/learned` digest — one line per event, newest first. Keeps
 * each entry under ~120 chars so a 10-event list fits well under
 * Telegram's 4096-char message cap with room for the header.
 */
function formatEvolutionDigest(
  events: ReadonlyArray<EvolutionEventEntry>,
  now: Date = new Date(),
): string {
  const header = `Evolution events (${events.length}):`;
  const lines = events.map((e, i) => {
    const c = e.payload.corrections;
    const m = e.payload.memories;
    const ruleDelta = c.extracted + c.reinforced + c.promoted;
    const memoryDelta = m.extracted;
    const tag = e.triggeredBy === "manual" ? " [manual]" : "";
    return (
      `${i + 1}. ${e.id}${tag}\n` +
      `   ${formatRelativeTime(e.createdAt, now)} — ${ruleDelta} rule change(s), ${memoryDelta} memory write(s)`
    );
  });
  return [header, ...lines].join("\n");
}

/**
 * Render `/learned <id>` — full breakdown of one event. Mirrors the
 * structured-log fields the Observer emits per fire so the operator can
 * cross-reference against process logs when debugging.
 */
function formatEvolutionDetail(event: EvolutionEventEntry, now: Date = new Date()): string {
  const { payload } = event;
  const skipped =
    payload.corrections.outOfScopeReinforcementsSkipped +
    payload.corrections.unknownRuleReinforcementsSkipped;
  const lines: string[] = [
    `Event ${event.id}`,
    // Both forms: relative for at-a-glance scanning, ISO for log-grep parity.
    `When: ${formatRelativeTime(event.createdAt, now)} (${event.createdAt.toISOString()})`,
    `Triggered by: ${event.triggeredBy}`,
    `Conversation: ${event.conversationId}`,
    `Profile: ${payload.profileId}`,
    `Transcript: ${payload.messageCount} message(s)`,
  ];
  if (payload.durationMs !== undefined) {
    lines.push(`Took: ${formatDurationMs(payload.durationMs)}`);
  }
  lines.push(
    "",
    "Corrections:",
    `  extracted:    ${payload.corrections.extracted}`,
    `  reinforced:   ${payload.corrections.reinforced}`,
    `  promoted:     ${payload.corrections.promoted}`,
    `  contradicted: ${payload.corrections.contradictions}`,
  );
  // Surface the skipped counters only when non-zero — they're zero on
  // most fires and the silence is the signal. When something WAS
  // skipped, the operator wants to see it spelled out so they can
  // reconcile against `extracted + reinforced`. Pre-computed total
  // gates the whole block so a "0 skipped" line never adds noise.
  if (skipped > 0) {
    lines.push(
      `  skipped:      ${skipped} (${payload.corrections.outOfScopeReinforcementsSkipped} out-of-scope, ${payload.corrections.unknownRuleReinforcementsSkipped} unknown-rule)`,
    );
  }
  if (payload.consolidation) {
    lines.push("", "Consolidation:");
    lines.push(`  merged groups: ${payload.consolidation.mergedGroups}`);
    lines.push(`  rules removed: ${payload.consolidation.rulesRemoved}`);
  }
  lines.push("", `Memories: ${payload.memories.extracted} extracted`);
  for (const [network, count] of Object.entries(payload.memories.byNetwork)) {
    lines.push(`  ${network}: ${count}`);
  }
  if (payload.drained.drained > 0) {
    lines.push("", `Pending drained: ${payload.drained.drained}`);
    for (const [network, count] of Object.entries(payload.drained.byNetwork)) {
      lines.push(`  ${network}: ${count}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format a past instant as a short human-readable delta from `now`.
 * Optimised for at-a-glance scanning in chat. Delegates the formatting
 * to `Intl.RelativeTimeFormat` (built-in, Node ≥18) so the strings
 * follow locale conventions ("yesterday" / "5 minutes ago"). The Intl
 * API can't pick the "best" unit itself — caller still chooses
 * seconds/minutes/hours/days — but everything past unit selection
 * (pluralisation, "yesterday" vs "1 day ago", negative sign placement)
 * is handled by the platform.
 *
 * Older than a week → fall back to an ISO date stamp. Future
 * timestamps work too (Intl produces "in 5 minutes" etc.); a future
 * `createdAt` would be a stamping bug, but the renderer shouldn't
 * crash on it.
 *
 * Exported so unit tests can pin `now` deterministically.
 */
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelativeTime(when: Date, now: Date): string {
  // Negative delta = past, positive = future; `RelativeTimeFormat`
  // matches that sign convention.
  const deltaSec = (when.getTime() - now.getTime()) / 1000;
  const absSec = Math.abs(deltaSec);
  if (absSec < 45) return RELATIVE_TIME_FORMAT.format(0, "second");
  const min = deltaSec / 60;
  if (Math.abs(min) < 60) return RELATIVE_TIME_FORMAT.format(Math.round(min), "minute");
  const hr = min / 60;
  if (Math.abs(hr) < 24) return RELATIVE_TIME_FORMAT.format(Math.round(hr), "hour");
  const day = hr / 24;
  if (Math.abs(day) < 7) return RELATIVE_TIME_FORMAT.format(Math.round(day), "day");
  // Anything older than a week is calendar-scale; a relative phrase
  // ("3 weeks ago") loses too much resolution for an audit log. ISO
  // date stamp keeps grep parity with structured logs.
  return when.toISOString().slice(0, 10);
}

/**
 * Compact ms → human duration. Uses `Intl.DurationFormat` (Node ≥22)
 * with `style: "narrow"` ("1m 32s") and trims to the largest two
 * relevant units. Sub-second values stay raw ms because the Intl
 * variant collapses them to "0 seconds".
 */
const DURATION_FORMAT = new Intl.DurationFormat("en", { style: "narrow" });

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return DURATION_FORMAT.format({ seconds: sec });
  return DURATION_FORMAT.format(sec === 0 ? { minutes: min } : { minutes: min, seconds: sec });
}
