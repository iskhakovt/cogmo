/**
 * Multi-turn FSM for `/profile new <name>` and `/profile edit <name>`.
 *
 * State lives in-memory per chat — bot restart mid-dialog loses the draft and the user re-issues
 * the command. This is deliberate: a partial profile should never land in the DB, and the dialog
 * is short-lived enough that restart recovery isn't worth the persistence cost.
 *
 * Text-based input (not inline keyboards) for v0 — simpler to implement and test. Inline-keyboard
 * UX for model/tool selection can come later without changing the state machine.
 *
 * Steps:
 *   prompt  → user types basePrompt (or "skip" in edit mode)
 *   model   → user types model name (or "skip" in edit mode)
 *   confirm → user types "save" or "cancel"
 *
 * The caller in `index.ts` intercepts `bot.on("message:text")` for chats with active dialogs and
 * routes the text here instead of emitting to the agent.
 */

import type { Profile } from "../../../agent/store/index.js";
import type { Transport } from "../../transport.js";
import type { TelegramCommandContext } from "./commands.js";

type Step = "prompt" | "model" | "confirm";

interface DialogState {
  mode: "new" | "edit";
  /** Set in edit mode — the profile being updated. */
  profileId?: string;
  name: string;
  step: Step;
  draft: {
    basePrompt?: string | undefined;
    model?: string | undefined;
  };
  /** Snapshot of the existing profile (edit mode only) — used for "skip" and confirm summary. */
  current?: Profile | undefined;
}

export class ProfileDialogs {
  #state = new Map<number, DialogState>();

  /** True if this chat has an active dialog. Called at the top of `bot.on("message:text")`. */
  has(chatId: number): boolean {
    return this.#state.has(chatId);
  }

  /** Start a fresh /profile new flow. `name` must be non-empty and must not collide. */
  async startNew(transport: Transport, ctx: TelegramCommandContext, name: string): Promise<void> {
    if (!name) {
      await ctx.reply("Usage: /profile new <name>");
      return;
    }
    const handle = String(ctx.from.id);
    const list = await transport.profiles.list(handle);
    if (list.isErr()) {
      await ctx.reply(friendlyError(list.error));
      return;
    }
    if (list.value.some((p) => p.name === name)) {
      await ctx.reply(`A profile named "${name}" already exists. Pick a different name.`);
      return;
    }
    this.#state.set(ctx.chat.id, {
      mode: "new",
      name,
      step: "prompt",
      draft: {},
    });
    await ctx.reply(
      [
        `Creating profile "${name}".`,
        "",
        "Step 1/3 — system prompt. Reply with the prompt text, or /cancel to abort.",
      ].join("\n"),
    );
  }

  /** Start a /profile edit flow. Profile must exist and be owned by the caller. */
  async startEdit(transport: Transport, ctx: TelegramCommandContext, name: string): Promise<void> {
    if (!name) {
      await ctx.reply("Usage: /profile edit <name>");
      return;
    }
    const handle = String(ctx.from.id);
    const list = await transport.profiles.list(handle);
    if (list.isErr()) {
      await ctx.reply(friendlyError(list.error));
      return;
    }
    // Name uniqueness is per user_id — a user profile can share a name with an org one.
    // Prefer the user-owned match when both exist; surface ambiguity if we can't disambiguate.
    const matches = list.value.filter((p) => p.name === name);
    if (matches.length === 0) {
      await ctx.reply(`No profile named "${name}".`);
      return;
    }
    const owned = matches.filter((p) => p.userId !== null);
    const [firstOwned] = owned;
    let found: Profile;
    if (owned.length === 1 && firstOwned) {
      found = firstOwned;
    } else if (owned.length === 0 && matches.length === 1) {
      // Only an org match — can't edit org profiles via Transport.
      await ctx.reply(`"${name}" is an org profile and can't be edited here.`);
      return;
    } else {
      // Defensive branch: UNIQUE(user_id, name) NULLS NOT DISTINCT means we should see at most
      // one org + one user row per name, and the owned==1 case above always wins that. If this
      // fires, something odd is going on schema-wise — point the user at /profile list.
      const scopes = matches.map((p) => (p.userId === null ? "org" : "user")).join(", ");
      await ctx.reply(
        `Multiple profiles named "${name}" (${matches.length}: ${scopes}) — can't determine which one to edit. Use /profile list to inspect.`,
      );
      return;
    }
    this.#state.set(ctx.chat.id, {
      mode: "edit",
      profileId: found.id,
      name,
      step: "prompt",
      draft: {},
      current: found,
    });
    await ctx.reply(
      [
        `Editing profile "${name}".`,
        "",
        "Step 1/3 — system prompt.",
        `Current: ${ellipsize(found.basePrompt, 200)}`,
        "",
        "Reply with a new prompt, 'skip' to keep current, or /cancel.",
      ].join("\n"),
    );
  }

  /** Clear any active dialog for this chat. Returns true if one was cleared. */
  cancel(chatId: number): boolean {
    return this.#state.delete(chatId);
  }

  /**
   * Handle a free-form text message from a chat with an active dialog.
   * Returns true if the message was consumed (caller should not emit to agent).
   */
  async handleMessage(transport: Transport, ctx: TelegramCommandContext): Promise<boolean> {
    const state = this.#state.get(ctx.chat.id);
    if (!state) return false;

    const text = ctx.match ?? "";
    try {
      switch (state.step) {
        case "prompt":
          await this.#handlePromptStep(ctx, state, text);
          return true;
        case "model":
          await this.#handleModelStep(transport, ctx, state, text);
          return true;
        case "confirm":
          await this.#handleConfirmStep(transport, ctx, state, text);
          return true;
      }
    } catch (e) {
      this.#state.delete(ctx.chat.id);
      throw e;
    }
  }

  async #handlePromptStep(
    ctx: TelegramCommandContext,
    state: DialogState,
    text: string,
  ): Promise<void> {
    if (state.mode === "edit" && text.trim().toLowerCase() === "skip") {
      state.draft.basePrompt = state.current?.basePrompt;
    } else if (text.trim()) {
      state.draft.basePrompt = text;
    } else {
      await ctx.reply("Prompt can't be empty. Reply with the prompt text, or /cancel.");
      return;
    }
    state.step = "model";
    await ctx.reply(
      [
        "Step 2/3 — model.",
        state.mode === "edit" ? `Current: ${state.current?.model}` : "",
        "Reply with a model name (e.g. claude-sonnet-5).",
        state.mode === "edit" ? "'skip' to keep current, or /cancel." : "Or /cancel.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async #handleModelStep(
    transport: Transport,
    ctx: TelegramCommandContext,
    state: DialogState,
    text: string,
  ): Promise<void> {
    const trimmed = text.trim();
    if (state.mode === "edit" && trimmed.toLowerCase() === "skip") {
      state.draft.model = state.current?.model;
    } else if (trimmed) {
      state.draft.model = trimmed;
    } else {
      await ctx.reply("Reply with a model name, or /cancel.");
      return;
    }
    state.step = "confirm";
    const models = await transport.models.list();
    const summary = [
      "Step 3/3 — confirm.",
      "",
      `Name:   ${state.name}`,
      `Prompt: ${ellipsize(state.draft.basePrompt ?? "", 200)}`,
      `Model:  ${state.draft.model}`,
      "",
      "Reply 'save' to apply, or /cancel to abort.",
    ];
    if (state.draft.model && !models.includes(state.draft.model)) {
      summary.push(
        "",
        `⚠️ "${state.draft.model}" isn't in the current model list. Save will fail unless it's user-selectable.`,
        `Available: ${models.join(", ") || "(none)"}`,
      );
    }
    await ctx.reply(summary.join("\n"));
  }

  async #handleConfirmStep(
    transport: Transport,
    ctx: TelegramCommandContext,
    state: DialogState,
    text: string,
  ): Promise<void> {
    const t = text.trim().toLowerCase();
    if (t === "cancel") {
      this.#state.delete(ctx.chat.id);
      await ctx.reply("Cancelled.");
      return;
    }
    if (t !== "save") {
      await ctx.reply("Reply 'save' to apply, or /cancel to abort.");
      return;
    }

    const handle = String(ctx.from.id);
    if (state.mode === "new") {
      const res = await transport.profiles.create(handle, {
        name: state.name,
        basePrompt: state.draft.basePrompt ?? "",
        model: state.draft.model ?? "",
        toolSet: defaultToolSetFor(state),
      });
      if (res.isErr()) {
        await ctx.reply(friendlyError(res.error));
        // Keep dialog state so user can /cancel or retry a fix — but for v0, just drop it
        this.#state.delete(ctx.chat.id);
        return;
      }
      this.#state.delete(ctx.chat.id);
      await ctx.reply(`Profile "${state.name}" created.`);
      return;
    }

    // edit
    if (!state.profileId) throw new Error("profile-dialog: edit without profileId");
    const changes: Parameters<Transport["profiles"]["update"]>[2] = {};
    if (
      state.draft.basePrompt !== undefined &&
      state.draft.basePrompt !== state.current?.basePrompt
    ) {
      changes.basePrompt = state.draft.basePrompt;
    }
    if (state.draft.model !== undefined && state.draft.model !== state.current?.model) {
      changes.model = state.draft.model;
    }
    // All-skipped edit path — nothing to update. Avoid calling profiles.update with {},
    // which would throw "No values to set" from Drizzle.
    if (Object.keys(changes).length === 0) {
      this.#state.delete(ctx.chat.id);
      await ctx.reply(`No changes to apply to "${state.name}".`);
      return;
    }
    const res = await transport.profiles.update(handle, state.profileId, changes);
    if (res.isErr()) {
      await ctx.reply(friendlyError(res.error));
      this.#state.delete(ctx.chat.id);
      return;
    }
    this.#state.delete(ctx.chat.id);
    await ctx.reply(`Profile "${state.name}" updated.`);
  }
}

/**
 * Default toolSet for new user profiles — every tool, matched via the `"*"`
 * glob. Profiles are filtered against `compileToolMatchers(toolSet)` at
 * turn-build time (see `composeTurnTools`); a future `/profile edit <tools>`
 * sub-flow can expose explicit tool / glob selection. Takes `state` so we can
 * extend later (e.g. inherit from a current profile in edit mode) without
 * changing the call site.
 */
function defaultToolSetFor(_state: DialogState): string[] {
  return ["*"];
}

function ellipsize(s: string, n: number): string {
  if (!s) return "(empty)";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function friendlyError(err: { code: string; model?: string; reason?: string }): string {
  if (err.code === "model_unavailable")
    return `Model "${err.model}" isn't available. Use /model to see options.`;
  if (err.code === "profile_name_taken") return "A profile with that name already exists.";
  if (err.code === "access_denied") return `Access denied — ${err.reason ?? ""}.`;
  if (err.code === "profile_not_found") return "Profile not found.";
  if (err.code === "identity_rejected") return "You're not authorized on this bot.";
  return "Something went wrong.";
}
