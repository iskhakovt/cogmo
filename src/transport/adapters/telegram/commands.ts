/**
 * Per-command Telegram handlers — extracted as pure `(transport, ctx) => void` functions so they
 * can be unit-tested without grammY plumbing. The adapter wires them to `bot.command(...)`.
 *
 * Subcommand parsing (`/profile switch <name>`, `/model <model>`) lives here rather than in
 * `index.ts` so the dispatcher logic is covered by unit tests.
 */

import { actionToDecision } from "../../../agent/coding/permission-keyboard.js";
import type { Profile } from "../../../agent/store/index.js";
import { isUuid } from "../../../util/uuid.js";
import type { Transport, TransportError } from "../../transport.js";
import type { ProfileDialogs } from "./profile-dialog.js";
import type { RepoDialogs } from "./repo-dialog.js";
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
  repo:
    "Usage: /repo [list|add [<name> <local_path> <remote_url>]|remove <name>]\n" +
    "  /repo add (no args)            → guided dialog: clones via the bot PAT\n" +
    "  /repo add <name> <path> <url>  → register an already-cloned repo (scripting)",
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
    editText: "❌ Denied. The deploy stays pending — no main advance.",
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
  await ctx.reply(
    profileName
      ? `New conversation started with profile "${profileName}".`
      : "New conversation started.",
  );
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
    case "skill_deploy_not_found":
      return `Skill deploy ${shortenId(err.pendingId)} not found.`;
    case "skill_deploy_not_pending":
      return `This deploy can't be acted on (status: ${err.status}).`;
    case "skill_deploy_register_failed":
      return `Approve failed: ${err.reason}`;
  }
  // Exhaustive — if a new TransportError code is added, TypeScript will warn
  // at call sites that return `string` (the inferred return becomes `string | undefined`).
  // Belt-and-suspenders: surface a generic message rather than passing undefined to ctx.reply.
  return "Something went wrong.";
}

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
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
