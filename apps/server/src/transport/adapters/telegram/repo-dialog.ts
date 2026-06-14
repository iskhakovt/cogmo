/**
 * Multi-turn FSM for `/repo add` (no positional args).
 *
 * Mirrors `profile-dialog.ts`: in-memory per-chat state, text-based input,
 * dropped on bot restart. Three steps:
 *   name      → user types repo name; uniqueness checked here so the
 *               operator catches collisions before pasting a URL
 *   remoteUrl → user types the git remote
 *   confirm   → user types "save" → clone + register, or "cancel"
 *
 * Cloning is delegated to `Transport.repos.cloneAndAdd` which threads the
 * default GitHub identity's PAT through `GIT_ASKPASS`. Errors surface back
 * through the dialog.
 */

import { parseRemoteUrl } from "../../../agent/coding/open-pr.js";
import type { RepoSummary, Transport, TransportError } from "../../transport.js";
import type { TelegramCommandContext } from "./commands.js";

type Step = "name" | "remote" | "confirm";

interface DialogState {
  step: Step;
  draft: {
    name?: string;
    remoteUrl?: string;
  };
}

export class RepoDialogs {
  #state = new Map<number, DialogState>();

  has(chatId: number): boolean {
    return this.#state.has(chatId);
  }

  /** Start a fresh /repo add flow. Replaces any in-progress dialog. */
  async start(ctx: TelegramCommandContext): Promise<void> {
    this.#state.set(ctx.chat.id, { step: "name", draft: {} });
    await ctx.reply(
      [
        "Adding a repo.",
        "",
        "Step 1/3 — name. Reply with a short identifier (letters, digits, `.-_`).",
        "Or /cancel to abort.",
      ].join("\n"),
    );
  }

  /** Clear any active dialog for this chat. Returns true if one was cleared. */
  cancel(chatId: number): boolean {
    return this.#state.delete(chatId);
  }

  /** Returns true if the message was consumed by the dialog. */
  async handleMessage(transport: Transport, ctx: TelegramCommandContext): Promise<boolean> {
    const state = this.#state.get(ctx.chat.id);
    if (!state) return false;

    const text = (ctx.match ?? "").trim();
    try {
      switch (state.step) {
        case "name":
          await this.#handleName(transport, ctx, state, text);
          return true;
        case "remote":
          await this.#handleRemote(ctx, state, text);
          return true;
        case "confirm":
          await this.#handleConfirm(transport, ctx, state, text);
          return true;
      }
    } catch (e) {
      this.#state.delete(ctx.chat.id);
      throw e;
    }
  }

  async #handleName(
    transport: Transport,
    ctx: TelegramCommandContext,
    state: DialogState,
    text: string,
  ): Promise<void> {
    if (!text) {
      await ctx.reply("Name can't be empty. Reply with a name, or /cancel.");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(text)) {
      await ctx.reply("Name must match [a-zA-Z0-9._-]+ (no spaces or path separators).");
      return;
    }
    const list = await transport.repos.list();
    if (list.isErr()) {
      this.#state.delete(ctx.chat.id);
      await ctx.reply(friendlyError(list.error));
      return;
    }
    if (list.value.some((r) => r.name === text)) {
      await ctx.reply(`A repo named "${text}" already exists. Pick a different name, or /cancel.`);
      return;
    }
    state.draft.name = text;
    state.step = "remote";
    await ctx.reply(
      [
        "Step 2/3 — git remote URL.",
        "",
        "Examples:",
        "  https://github.com/user/repo.git",
        "  git@github.com:user/repo.git",
        "",
        "Reply with the URL, or /cancel.",
      ].join("\n"),
    );
  }

  async #handleRemote(
    ctx: TelegramCommandContext,
    state: DialogState,
    text: string,
  ): Promise<void> {
    if (!text) {
      await ctx.reply("Remote URL can't be empty. Reply with the URL, or /cancel.");
      return;
    }
    // Catch typos ("htps://", missing host) before paying the network
    // round-trip on `git clone`. The verify orchestrator (slice 4.0h)
    // also requires the URL to parse as `owner/repo` for the PR step,
    // so a URL the dialog accepts but the orchestrator can't parse
    // would surface as a confusing post-clone failure.
    if (!parseRemoteUrl(text)) {
      await ctx.reply(
        [
          "That doesn't look like a git remote URL. Examples:",
          "  https://github.com/user/repo.git",
          "  git@github.com:user/repo.git",
          "",
          "Reply with the URL, or /cancel.",
        ].join("\n"),
      );
      return;
    }
    state.draft.remoteUrl = text;
    state.step = "confirm";
    await ctx.reply(
      [
        "Step 3/3 — confirm.",
        "",
        `Name:   ${state.draft.name}`,
        `Remote: ${text}`,
        "",
        "Reply 'save' to clone and register, or /cancel to abort.",
      ].join("\n"),
    );
  }

  async #handleConfirm(
    transport: Transport,
    ctx: TelegramCommandContext,
    state: DialogState,
    text: string,
  ): Promise<void> {
    const t = text.toLowerCase();
    if (t === "cancel") {
      this.#state.delete(ctx.chat.id);
      await ctx.reply("Cancelled.");
      return;
    }
    if (t !== "save") {
      await ctx.reply("Reply 'save' to clone and register, or /cancel to abort.");
      return;
    }

    const { name, remoteUrl } = state.draft;
    if (!name || !remoteUrl) {
      // Defensive: the FSM advances into `confirm` only after both are set.
      this.#state.delete(ctx.chat.id);
      await ctx.reply("Internal error: incomplete draft.");
      return;
    }

    await ctx.reply("Cloning…");
    const res = await transport.repos.cloneAndAdd({ name, remoteUrl });
    this.#state.delete(ctx.chat.id);
    if (res.isErr()) {
      await ctx.reply(friendlyError(res.error));
      return;
    }
    await ctx.reply(formatSuccess(res.value));
  }
}

function formatSuccess(repo: RepoSummary): string {
  return [
    `Repo "${repo.name}" added.`,
    `Path: ${repo.localPath}`,
    `Remote: ${repo.remoteUrl}`,
    `Verify: ${repo.verifyCommand} (default — update via SQL until /repo edit ships)`,
  ].join("\n");
}

function friendlyError(err: TransportError): string {
  switch (err.code) {
    case "sandbox_disabled":
      return "Coding-delegation features are disabled (SANDBOX_RUNTIME not set).";
    case "github_identity_unavailable":
      return `Can't clone: ${err.reason}`;
    case "repo_clone_failed":
      return `Clone failed: ${err.reason}`;
    case "repo_local_path_exists":
      return `A directory already exists at ${err.path}. Move it aside or pick a different name.`;
    case "repo_name_taken":
      return `A repo named "${err.name}" already exists.`;
    case "repo_invalid_input":
      return `Invalid ${err.field}: ${err.reason}`;
    default:
      return "Something went wrong.";
  }
}
