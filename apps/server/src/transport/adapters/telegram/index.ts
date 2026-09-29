import { Bot, InputFile } from "grammy";
import type { JsonValue } from "type-fest";
import { PLAN_CALLBACK_REGEX, parsePlanCallback } from "../../../agent/coding/plan-keyboard.js";
import { startCodingProgressSubscriber } from "../../../agent/coding/progress-subscriber.js";
import {
  PIPELINE_GATE_CALLBACK_REGEX,
  parsePipelineGateCallback,
} from "../../../agent/pipeline/gate-keyboard.js";
import {
  boundaryResolvedEvent,
  codingTaskStart,
  pipelineGatePending,
  skillsDeployApprovalRequested,
} from "../../../inngest/events.js";
import { logger } from "../../../logger.js";
import {
  parseSkillsApprovalCallback,
  SKILLS_APPROVAL_CALLBACK_REGEX,
} from "../../../skills/skills-keyboard.js";
import type { OutboundVoice } from "../../adapter-module.js";
import {
  type AdapterDeps,
  type AdapterModule,
  type AdapterSetupResult,
  isRenderedMessage,
  type RenderedMessage,
} from "../../adapter-module.js";
import { type AttachmentStore, mediaTypeToExt } from "../../attachment-store.js";
import type { InboundContent } from "../../content.js";
import type { BufferedInboundEntry, PriorClosedConversation } from "../../store/index.js";
import type { Adapter, StreamHandle, StreamingAdapter, StreamOpts } from "../../types.js";
import { editResolvedBoundaryPrompt } from "./boundary-prompt-editor.js";
import {
  handleClasses,
  handleCompact,
  handleCompartments,
  handleDisable,
  handleEnable,
  handleEnd,
  handleLearned,
  handleMcp,
  handleModel,
  handleName,
  handleNew,
  handlePipelineGateCallback,
  handlePlanCallback,
  handleProfile,
  handleReflect,
  handleRepair,
  handleRepo,
  handleResume,
  handleResumeCallback,
  handleSchedules,
  handleSessions,
  handleSkills,
  handleSkillsApprovalCallback,
  handleStatus,
  handleVoice,
  type TelegramCommandContext,
} from "./commands.js";
import { postPipelineGateKeyboard } from "./pipeline-gate-poster.js";
import { ProfileDialogs } from "./profile-dialog.js";
import { renderTelegramHtml, stripHtmlTags } from "./render.js";
import { RepoDialogs } from "./repo-dialog.js";
import { postSkillsApprovalKeyboard } from "./skills-approval-poster.js";
import { TelegramStreamHandle } from "./stream-handle.js";

export const channelType = "telegram";

const TELEGRAM_CHUNK_TARGET_DEFAULT = 4000;

/**
 * Max characters in the first-user-message snippet used for the "↶ Resume X"
 * button label. Telegram inline button labels render up to ~40 chars cleanly
 * before truncation on mobile; this leaves room for the `↶ Resume ` prefix.
 */
const BOUNDARY_SNIPPET_MAX_CHARS = 25;

/**
 * Regex matched against `callback_data` for boundary prompt taps. UUIDv7
 * format (`[0-9a-f-]{36}`) keeps the pattern unambiguous against other
 * `…:…` callback shapes (`resume:`, `plan:`, `perm:`, `skill:`).
 *
 * **Budget:** Telegram caps `callback_data` at 64 bytes. The longest shape
 * here is `boundary:<36-char-uuid>:resume` = 51 bytes, leaving ~13 bytes
 * of headroom. Adding a third cofactor (e.g. a profile id) would blow the
 * cap; truncate the boundary id to its UUIDv7 timestamp prefix or move to
 * a callback-id table before extending this shape.
 */
const BOUNDARY_CALLBACK_REGEX = /^boundary:([0-9a-f-]{36}):(resume|fresh)$/;

class TelegramAdapter implements Adapter, StreamingAdapter {
  #bot: Bot;
  #attachments: AttachmentStore;
  #activeStreams = new Map<string, TelegramStreamHandle>();
  #polling: Promise<void> | undefined;

  constructor(bot: Bot, attachments: AttachmentStore) {
    this.#bot = bot;
    this.#attachments = attachments;
  }

  /**
   * Take ownership of the polling promise returned by grammY's `bot.start()`.
   * Captured so `stop()` can await it to drain — without this, `bot.stop()`
   * aborts a pending retry sleep and grammY rejects with "Aborted delay" as
   * an unhandled rejection, which crashes the test process even though all
   * tests passed.
   */
  attachPolling(polling: Promise<void>): void {
    this.#polling = polling.catch((err: unknown) => {
      // Expected: bot.stop() aborts grammY's retry-backoff sleep, which
      // rejects with "Aborted delay" (from node:timers/promises). Anything
      // else is a real failure worth logging.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Aborted delay") {
        logger.error({ err }, "telegram polling loop failed");
      }
    });
  }

  async deliver(platformAddress: string, content: RenderedMessage | JsonValue): Promise<void> {
    const chatId = Number(platformAddress);
    if (isRenderedMessage(content)) {
      try {
        await this.#bot.api.sendMessage(chatId, content.text, {
          ...(content.parseMode && { parse_mode: content.parseMode }),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("can't parse entities")) {
          logger.warn("telegram: HTML parse failed, falling back to plain text");
          await this.#bot.api.sendMessage(chatId, stripHtmlTags(content.text));
        } else {
          throw err;
        }
      }
      // Send any attached images as separate photo messages after the text.
      for (const img of content.images ?? []) {
        await this.#bot.api.sendPhoto(
          chatId,
          new InputFile(img.data, `image.${mediaTypeToExt(img.mediaType)}`),
        );
      }
      // Send any attached documents as separate file messages after photos.
      for (const doc of content.documents ?? []) {
        await this.#bot.api.sendDocument(chatId, new InputFile(doc.data, doc.name));
      }
    } else {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      await this.#bot.api.sendMessage(chatId, text);
    }
  }

  /**
   * Open the run's stream, or hand back the one already open: Inngest
   * re-invokes the turn at every step boundary, and each invocation opens
   * again. A handle leaves the run once it settles, so an open after a
   * failure — the retry of the step it failed — starts a fresh one.
   */
  async openStream(
    platformAddress: string,
    runId: string,
    opts?: StreamOpts,
  ): Promise<StreamHandle> {
    const existing = this.#activeStreams.get(runId);
    if (existing) return existing;

    const handle = new TelegramStreamHandle(
      this.#bot,
      this.#attachments,
      Number(platformAddress),
      runId,
      {
        chunkChars: opts?.chunkChars ?? TELEGRAM_CHUNK_TARGET_DEFAULT,
        allowEdits: opts?.allowEdits ?? true,
      },
    );
    this.#activeStreams.set(runId, handle);
    void handle.done.then(() => {
      if (this.#activeStreams.get(runId) === handle) this.#activeStreams.delete(runId);
    });
    return handle;
  }

  /**
   * Voice delivery — Telegram's `sendVoice` renders the OGG/Opus audio as a
   * voice-bubble UI. Other formats fall back to `sendAudio` (regular audio
   * file). Called by the delivery router AFTER the streamed text message
   * has already been delivered (Option B in design/voice.md), so a TTS
   * failure can never strand the user.
   */
  async sendVoice(platformAddress: string, audio: OutboundVoice): Promise<void> {
    const chatId = Number(platformAddress);
    const ext = mediaTypeToExt(audio.mediaType);
    const file = new InputFile(audio.audio, `voice.${ext}`);
    if (audio.mediaType === "audio/ogg" || audio.mediaType === "audio/opus") {
      await this.#bot.api.sendVoice(chatId, file);
    } else {
      // Non-Opus → degrade to sendAudio (still playable, just not the
      // voice-bubble UI). Slice 1 doesn't bundle ffmpeg.
      await this.#bot.api.sendAudio(chatId, file);
    }
  }

  async stop(): Promise<void> {
    this.#bot.stop();
    // Drain the polling loop so any in-flight retry-backoff abort rejects
    // before this process exits — otherwise the unhandled rejection lands
    // on the runtime/test harness instead of being swallowed in attachPolling.
    if (this.#polling) await this.#polling;
  }
}

/**
 * Download a Telegram-hosted file (photo / document / voice / etc.) by file_id.
 *
 * Two failure modes the inline `getFile + fetch + arrayBuffer` chain
 * silently absorbed:
 *
 *   1. `getFile()` returns `file_path: undefined` for files >20MB and for
 *      certain media types. The URL would become `.../bot<token>/undefined`
 *      and Telegram's CDN responds with a 404 HTML page; without an
 *      explicit guard we'd upload that HTML as the user's "document".
 *   2. The CDN can return 4xx/5xx (rate limit, expired file_id, transient
 *      outage). `arrayBuffer()` succeeds anyway, returning the error body —
 *      same garbage-upload outcome.
 *
 * Throws on either, so the caller's existing try/catch logs and skips
 * instead of persisting a bogus attachment.
 */
interface FileDownloadCtx {
  api: { getFile: (fileId: string) => Promise<{ file_path?: string }> };
}

async function downloadTelegramFile(
  ctx: FileDownloadCtx,
  fileId: string,
  botToken: string,
): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`telegram getFile returned no file_path (file_id=${fileId})`);
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `telegram file download failed: ${response.status} ${response.statusText} (file_id=${fileId})`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Telegram adapter — long-polling bot, delivers via Bot API.
 */
/**
 * Narrow a grammY CommandContext/CallbackQueryContext to the minimal shape used by pure
 * command handlers. Pure `TelegramCommandContext.reply` declares a narrower options type than
 * grammY's; the wrapper casts at the boundary — runtime-safe because `reply_markup` is a
 * valid field on grammY's `Other`.
 */
interface GrammyCtxLite {
  chat: { id: number } | undefined;
  from: { id: number | string } | undefined;
  match?: unknown;
  reply: (text: string, other?: Record<string, unknown>) => Promise<unknown>;
}

function toCmdCtx(ctx: GrammyCtxLite, overrideMatch?: string): TelegramCommandContext {
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
    reply: (text, options) => ctx.reply(text, options as Record<string, unknown> | undefined),
  };
}

export async function setup(deps: AdapterDeps): Promise<AdapterSetupResult> {
  const { credentials, transport, attachments, boundary: boundaryConfig } = deps;
  const creds = credentials as { token: string; apiRoot?: string };
  const bot = new Bot(creds.token, creds.apiRoot ? { client: { apiRoot: creds.apiRoot } } : {});
  const adapter = new TelegramAdapter(bot, attachments);
  const profileDialogs = new ProfileDialogs();
  const repoDialogs = new RepoDialogs();

  bot.command("start", async (ctx) => {
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

  // Admin commands — each delegates to a pure handler in commands.ts.
  // grammY's ctx is ducktyped to `TelegramCommandContext` at call time; `ctx.match` holds
  // the trailing text after the command word (empty string for bare `/profile`).
  bot.command("new", (ctx) => handleNew(transport, toCmdCtx(ctx)));
  bot.command("sessions", (ctx) => handleSessions(transport, toCmdCtx(ctx)));
  bot.command("resume", (ctx) => handleResume(transport, toCmdCtx(ctx)));
  bot.command("name", (ctx) => handleName(transport, toCmdCtx(ctx)));
  bot.command("end", (ctx) => handleEnd(transport, toCmdCtx(ctx)));
  bot.command("compact", (ctx) => handleCompact(transport, toCmdCtx(ctx)));
  bot.command("profile", (ctx) => handleProfile(transport, toCmdCtx(ctx), profileDialogs));
  bot.command("classes", (ctx) => handleClasses(transport, toCmdCtx(ctx)));
  bot.command("compartments", (ctx) => handleCompartments(transport, toCmdCtx(ctx)));
  bot.command("model", (ctx) => handleModel(transport, toCmdCtx(ctx)));
  bot.command("repo", (ctx) => handleRepo(transport, toCmdCtx(ctx), repoDialogs));
  bot.command("mcp", (ctx) => handleMcp(transport, toCmdCtx(ctx)));
  bot.command("repair", (ctx) => handleRepair(transport, toCmdCtx(ctx)));
  bot.command("voice", (ctx) => handleVoice(transport, toCmdCtx(ctx)));
  bot.command("status", (ctx) => handleStatus(transport, toCmdCtx(ctx)));
  bot.command("skills", (ctx) => handleSkills(transport, toCmdCtx(ctx)));
  bot.command("disable", (ctx) => handleDisable(transport, toCmdCtx(ctx)));
  bot.command("enable", (ctx) => handleEnable(transport, toCmdCtx(ctx)));
  bot.command("schedules", (ctx) => handleSchedules(transport, toCmdCtx(ctx)));
  bot.command("learned", (ctx) => handleLearned(transport, toCmdCtx(ctx)));
  bot.command("reflect", (ctx) => handleReflect(transport, toCmdCtx(ctx)));

  // Mid-dialog abort for /profile new|edit and /repo add flows. Evaluate
  // both branches (no `||` short-circuit) so a hypothetical "both dialogs
  // simultaneously active" state — possible only if a future code path
  // forgets to clear one before opening the other — gets fully torn down
  // rather than leaving the second FSM live.
  bot.command("cancel", async (ctx) => {
    const cancelledProfile = profileDialogs.cancel(ctx.chat.id);
    const cancelledRepo = repoDialogs.cancel(ctx.chat.id);
    if (cancelledProfile || cancelledRepo) {
      await ctx.reply("Cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  // Boundary prompt taps — callback_data = "boundary:<boundaryId>:<resume|fresh>"
  bot.callbackQuery(BOUNDARY_CALLBACK_REGEX, async (ctx) => {
    const boundaryId = ctx.match?.[1];
    const action = ctx.match?.[2];
    if (!boundaryId || !action) return;

    const isResume = action === "resume";
    const result = await transport.boundary.resolve({
      boundaryId,
      choice: isResume ? { kind: "resume-prior" } : { kind: "fresh" },
      reason: isResume ? "user_resume" : "user_fresh",
    });

    try {
      // Drop the keyboard so the buttons can't be tapped twice. Same pattern
      // as plan / permission / skills-approval callback handlers.
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("message is not modified")) {
        logger.warn({ err }, "telegram: failed to clear boundary keyboard");
      }
    }

    if (result.isErr()) {
      const code = result.error.code;
      const toast = code === "boundary_not_found" ? "Already resolved" : "Resolution failed";
      await ctx.answerCallbackQuery({ text: toast });
      return;
    }

    await ctx.answerCallbackQuery({
      text: isResume ? "Picking up where we left off." : "Starting fresh.",
    });
  });

  // Inline keyboard taps from /sessions list — callback_data = "resume:<alias|conversationId>"
  bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
    const target = ctx.match?.[1];
    if (!target) return;
    await handleResumeCallback(transport, toCmdCtx(ctx, ""), target);
    await ctx.answerCallbackQuery();
  });

  // Plan keyboard: Approve / Revise / Cancel — callback_data = "plan:<taskId>:<action>"
  bot.callbackQuery(PLAN_CALLBACK_REGEX, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const fromId = ctx.from?.id;
    if (!data || fromId === undefined) return;
    const parsed = parsePlanCallback(data);
    if (!parsed) return;

    const outcome = await handlePlanCallback(transport, parsed, String(fromId));

    // Edit the original plan message: replace its body with the outcome
    // text and clear the keyboard so the buttons don't linger after the
    // tap. Telegram returns 400 "message is not modified" on no-op edits;
    // ignore. Failure to edit (e.g. message deleted by the user) shouldn't
    // block the rest of the outcome.
    try {
      // Pass an empty inline_keyboard rather than reply_markup: undefined.
      // grammY's strict-optional types reject `undefined` for reply_markup,
      // and Telegram accepts an empty keyboard array as "remove the
      // existing keyboard".
      await ctx.editMessageText(outcome.editText, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("message is not modified")) {
        logger.warn({ err }, "telegram: failed to edit plan message");
      }
    }
    if (outcome.followUp) {
      await ctx.reply(outcome.followUp);
    }
    await ctx.answerCallbackQuery({ text: outcome.toast });
  });

  // Pipeline gate keyboard: Approve / Cancel — callback_data = "pipe:<runId>:<action>:<token>"
  bot.callbackQuery(PIPELINE_GATE_CALLBACK_REGEX, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const fromId = ctx.from?.id;
    if (!data || fromId === undefined) return;
    const parsed = parsePipelineGateCallback(data);
    if (!parsed) return;

    const outcome = await handlePipelineGateCallback(transport, parsed, String(fromId));
    if (outcome.clearKeyboard) {
      try {
        await ctx.editMessageText(outcome.editText, { reply_markup: { inline_keyboard: [] } });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("message is not modified")) {
          logger.warn({ err }, "telegram: failed to edit pipeline gate message");
        }
      }
    }
    await ctx.answerCallbackQuery({ text: outcome.toast });
  });

  // Skills approval keyboard: Approve / Deny — callback_data =
  // "skill:<pendingId>:<approve|deny>"
  bot.callbackQuery(SKILLS_APPROVAL_CALLBACK_REGEX, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const fromId = ctx.from?.id;
    if (!data || fromId === undefined) return;
    const parsed = parseSkillsApprovalCallback(data);
    if (!parsed) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      // No chat, no conversation to act from; answer so the button stops spinning.
      await ctx.answerCallbackQuery({ text: "Open this approval in its chat." });
      return;
    }

    const outcome = await handleSkillsApprovalCallback(
      transport,
      parsed,
      String(fromId),
      String(chatId),
    );
    try {
      await ctx.editMessageText(outcome.editText, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("message is not modified")) {
        logger.warn({ err }, "telegram: failed to edit skills approval message");
      }
    }
    await ctx.answerCallbackQuery({ text: outcome.toast });
  });

  function boundaryButtonLabel(prior: PriorClosedConversation): string {
    // Snippet is already capped at BOUNDARY_SNIPPET_MAX_CHARS by the store;
    // alias is user-set and unbounded — truncate to the same cap so a long
    // emoji-laden alias can't push the button past Telegram's 64-byte
    // callback-text limit. Code-point slice (Array.from) so multi-byte
    // graphemes don't split mid-char.
    const raw = prior.alias ?? prior.firstUserSnippet ?? "previous chat";
    const chars = Array.from(raw);
    return chars.length <= BOUNDARY_SNIPPET_MAX_CHARS
      ? raw
      : `${chars.slice(0, BOUNDARY_SNIPPET_MAX_CHARS - 1).join("")}…`;
  }

  /**
   * Send the boundary prompt and persist the hold. Two-message-API trip:
   * `ctx.reply` first to obtain a message id, then `editMessageReplyMarkup`
   * once the boundary row exists (so the inline-keyboard `callback_data` can
   * carry the row's id). The intermediate state — prompt text without
   * buttons — is only visible for the round-trip latency.
   *
   * Returns `true` when the hold was created (caller should NOT emit the
   * inbound; it's buffered). Returns `false` to fall through to fresh-create.
   */
  async function fireBoundaryPrompt(
    ctx: { reply: (text: string) => Promise<{ message_id: number }> },
    addr: string,
    handle: string,
    prior: PriorClosedConversation,
    firstInbound: BufferedInboundEntry,
  ): Promise<boolean> {
    let promptMessageId: number | null = null;
    try {
      const label = boundaryButtonLabel(prior);
      const sent = await ctx.reply(
        "It's been a while since our last chat. Pick up where we left off, or start fresh?",
      );
      promptMessageId = sent.message_id;
      const { boundaryId } = await transport.boundary.start({
        platformAddress: addr,
        platformUserHandle: handle,
        priorConversationId: prior.conversationId,
        promptMessageId: String(sent.message_id),
        firstInbound,
        timeoutMs: boundaryConfig.promptTimeoutMs,
      });
      await bot.api.editMessageReplyMarkup(addr, sent.message_id, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `↶ Resume ${label}`, callback_data: `boundary:${boundaryId}:resume` },
              { text: "✦ Start fresh", callback_data: `boundary:${boundaryId}:fresh` },
            ],
          ],
        },
      });
      return true;
    } catch (err) {
      logger.error({ err }, "telegram: failed to fire boundary prompt — falling back to fresh");
      // If `ctx.reply` succeeded but a later step (boundary.start /
      // editMessageReplyMarkup) threw, the user is staring at a
      // button-less "Pick up where we left off?" prompt with no follow-up.
      // Best-effort delete so the caller's createConversation+emit fallback
      // produces a clean reply thread. Failure to delete is logged at warn
      // — the user just sees a stale prompt above the agent reply.
      if (promptMessageId !== null) {
        try {
          await bot.api.deleteMessage(addr, promptMessageId);
        } catch (delErr) {
          logger.warn(
            { err: delErr, promptMessageId },
            "telegram: failed to delete dangling boundary prompt",
          );
        }
      }
      return false;
    }
  }

  /**
   * Single entry point for every channel-side inbound (text, photo, document,
   * voice). Routes through the boundary-hold gate before falling back to the
   * normal `resolveSession` → `createConversation` → `emit` flow.
   *
   *   1. If a hold is already open for this address, append + return.
   *   2. `resolveSession` — if active, emit normally.
   *   3. Else `boundary.peek` — if there's a substantive prior, fire the
   *      prompt + buffer the inbound and return.
   *   4. Else `createConversation` + emit as before.
   */
  /**
   * Per-chat dispatch tail. Serialises `dispatchInbound` calls keyed on
   * `addr` so two inbounds arriving close-together don't both observe
   * `findActive → null` + `peek → prior` and race to create competing
   * boundary holds (UNIQUE constraint catches the conflict but the loser
   * would otherwise fall through to `createConversation` and split the
   * chat across two conversations).
   *
   * grammY's default polling runner already serialises updates from one
   * chat through the middleware chain, so this is belt-and-braces — but
   * the cost is one Map entry per active chat and the future-proofing is
   * worth it for webhook deployments or concurrency-enabled runners.
   */
  const dispatchTails = new Map<string, Promise<void>>();

  async function dispatchInbound(
    ctx: { reply: (text: string) => Promise<{ message_id: number }> },
    addr: string,
    handle: string,
    content: InboundContent,
    platformTs: Date,
  ): Promise<void> {
    const prev = dispatchTails.get(addr) ?? Promise.resolve();
    const myTurn = prev.then(() => doDispatch(ctx, addr, handle, content, platformTs));
    // Wrap with a swallowed-error tail so a thrown body doesn't break the
    // chain for the next inbound on this chat.
    const tail: Promise<void> = myTurn.then(
      () => undefined,
      () => undefined,
    );
    dispatchTails.set(addr, tail);
    // Auto-cleanup once we're the still-most-recent tail.
    tail.then(() => {
      if (dispatchTails.get(addr) === tail) dispatchTails.delete(addr);
    });
    return myTurn;
  }

  async function doDispatch(
    ctx: { reply: (text: string) => Promise<{ message_id: number }> },
    addr: string,
    handle: string,
    content: InboundContent,
    platformTs: Date,
  ): Promise<void> {
    const buffered: BufferedInboundEntry = {
      content,
      platformTs: platformTs.toISOString(),
    };

    const pending = await transport.boundary.findActive(addr);
    if (pending) {
      await transport.boundary.append(pending.id, buffered);
      return;
    }

    let session = await transport.resolveSession(addr);
    if (!session) {
      const prior = await transport.boundary.peek(
        addr,
        boundaryConfig.minUserTurns,
        BOUNDARY_SNIPPET_MAX_CHARS,
      );
      if (prior) {
        const fired = await fireBoundaryPrompt(ctx, addr, handle, prior, buffered);
        if (fired) return;
      }
      const result = await transport.createConversation(addr, handle, { isPrivate: true });
      if (result.isErr()) {
        if (result.error.code === "identity_rejected") {
          logger.info({ handle }, "telegram: rejected unauthorized user");
        } else {
          logger.error({ error: result.error }, "failed to create conversation");
        }
        return;
      }
      session = result.value;
    }

    const emitResult = await transport.emit(session.id, content, platformTs);
    if (emitResult.isErr()) {
      logger.error({ error: emitResult.error }, "failed to emit message");
    }
  }

  bot.on("message:text", async (ctx) => {
    // Mid-dialog input (e.g. /profile new flow) goes to the FSM, not the agent.
    // This check MUST run before typing indicator / session resolve / emit —
    // otherwise the draft text leaks into conversation history.
    if (profileDialogs.has(ctx.chat.id)) {
      await profileDialogs.handleMessage(transport, toCmdCtx(ctx, ctx.message.text));
      return;
    }
    if (repoDialogs.has(ctx.chat.id)) {
      await repoDialogs.handleMessage(transport, toCmdCtx(ctx, ctx.message.text));
      return;
    }

    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    await dispatchInbound(ctx, addr, handle, ctx.message.text, platformTs);
  });

  bot.on("message:photo", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    try {
      // Get the largest photo (last in array)
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;

      const buffer = await downloadTelegramFile(ctx, photo.file_id, creds.token);

      const path = await transport.uploadAttachment(buffer, "image/jpeg");
      const caption = ctx.message.caption ?? "";

      const content: InboundContent = [];
      if (caption) content.push({ type: "text", text: caption });
      content.push({ type: "image", path, mediaType: "image/jpeg" });

      await dispatchInbound(ctx, addr, handle, content, platformTs);
    } catch (err) {
      logger.error({ err }, "failed to process photo");
    }
  });

  bot.on("message:document", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    try {
      const doc = ctx.message.document;
      // Telegram's mime_type is best-effort — fall back to octet-stream so
      // the LLM call doesn't reject a missing media_type at validation.
      const mediaType = doc.mime_type ?? "application/octet-stream";

      const buffer = await downloadTelegramFile(ctx, doc.file_id, creds.token);

      const path = await transport.uploadAttachment(buffer, mediaType);
      const caption = ctx.message.caption ?? "";
      const name = doc.file_name;

      // Telegram's "Send as file" path delivers images (PNG, full-res JPEG,
      // etc.) as documents. Route image/* MIME types to the image block so
      // they hit the LLM's vision pipeline instead of the document pipeline
      // — Anthropic's `document` content block doesn't accept image media
      // types and would 400-fail.
      const isImage = mediaType.startsWith("image/");

      const content: InboundContent = [];
      if (caption) content.push({ type: "text", text: caption });
      if (isImage) {
        content.push({ type: "image", path, mediaType });
      } else {
        content.push({
          type: "document",
          path,
          mediaType,
          ...(name && { name }),
        });
      }

      await dispatchInbound(ctx, addr, handle, content, platformTs);
    } catch (err) {
      logger.error({ err }, "failed to process document");
    }
  });

  // Voice messages — Telegram's first-class voice clip type. Always OGG/Opus.
  // The handler stops at upload + emit; transcription happens in the
  // orchestrator's durable `transcribe-voice` step (so retries replay from
  // cache rather than re-charging STT). See design/voice.md.
  bot.on("message:voice", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    try {
      const voice = ctx.message.voice;
      // Telegram voice clips are always OGG/Opus per the Bot API spec; the
      // mime_type field is informational. Hardcode rather than relying on it.
      const mediaType = "audio/ogg";

      const buffer = await downloadTelegramFile(ctx, voice.file_id, creds.token);
      const path = await transport.uploadAttachment(buffer, mediaType);
      const caption = ctx.message.caption ?? "";
      const durationMs = voice.duration ? voice.duration * 1000 : undefined;

      const content: InboundContent = [];
      if (caption) content.push({ type: "text", text: caption });
      content.push({
        type: "voice",
        path,
        mediaType,
        ...(durationMs !== undefined && { durationMs }),
      });

      await dispatchInbound(ctx, addr, handle, content, platformTs);
    } catch (err) {
      logger.error({ err }, "failed to process voice message");
    }
  });

  // Note: `message:audio` (music/podcast attachments) is intentionally NOT
  // handled. Routing music files through STT would burn tokens on songs
  // and would also flip auto voice mode to "voice out" because
  // `lastInboundWasVoice` would become true. Voice notes
  // (`message:voice`) are the well-defined PTT shape; explicit
  // transcription of attached audio files is a future opt-in feature
  // (with a duration cap and a separate block type). See PR #149 review.

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, "telegram bot error");
  });

  // Populate the client-side command menu (the "/" / Menu button in Telegram).
  // Idempotent: Telegram replaces the list on each call. Failure here is
  // non-fatal — log and proceed so the bot still starts.
  await bot.api
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

  adapter.attachPolling(
    bot.start({
      onStart: () => logger.info("telegram adapter started"),
    }),
  );

  // Coding-progress wiring — listen for coding/task/start, find the
  // Telegram session attached to the task's conversation, and subscribe
  // a per-task message renderer that edits in place as plan + execute
  // events stream through the registry.
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [];
  const { inngest, channelId } = deps;
  if (deps.codingProgress) {
    const { codingStore, runInTx, transportStore, streamingRegistry } = deps.codingProgress;
    functions.push(
      inngest.createFunction(
        {
          id: `telegram-coding-progress-${channelId}`,
          triggers: [codingTaskStart],
          retries: 0,
          concurrency: { limit: 1, key: "event.data.taskId" },
        },
        async ({ event }) => {
          const taskId = event.data.taskId;
          const task = await runInTx((tx) => codingStore.getTask(tx, taskId));
          const taskConversationId = task?.conversationId;
          if (!taskConversationId) return { skipped: "no conversation" };

          const sessions = await runInTx((tx) =>
            transportStore.getActiveSessionsForConversation(tx, taskConversationId),
          );
          const tgSession = sessions.find((s) => s.channelId === channelId);
          if (!tgSession) return { skipped: "no telegram session for this conversation" };

          startCodingProgressSubscriber({
            taskId,
            chatId: Number(tgSession.platformAddress),
            goal: task.goal,
            channelId,
            bot: {
              sendMessage: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts),
              editMessageText: (chatId, messageId, text, opts) =>
                bot.api.editMessageText(chatId, messageId, text, opts),
            },
            registry: streamingRegistry,
          });
          return { subscribed: true };
        },
      ),
    );
  }

  // Skills approve-tier deploy gate — listen on
  // skills/deploy/approval-requested, post the inline keyboard message into
  // the originating conversation's session. The runner's register call has
  // already returned with status=pending_approval; the keyboard tap routes
  // straight to transport.skills.approveDeploy/denyDeploy.
  if (deps.skillsApproval) {
    const { skillStore, runInTx, transportStore } = deps.skillsApproval;
    functions.push(
      inngest.createFunction(
        {
          id: `telegram-skills-approval-${channelId}`,
          triggers: [skillsDeployApprovalRequested],
          retries: 0,
        },
        async ({ event }) =>
          postSkillsApprovalKeyboard({
            event: event.data,
            channelId,
            runInTx,
            skillStore,
            transportStore,
            sendMessage: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts),
          }),
      ),
    );
  }

  // Pipeline gate checkpoint — post the Approve / Cancel keyboard to this
  // channel's session on the run conversation when a run parks on a gate.
  // The gate's waiter owns the timeout, so a post that fails or never
  // happens cannot wedge the run.
  if (deps.pipelineGate) {
    const { runInTx, transportStore } = deps.pipelineGate;
    functions.push(
      inngest.createFunction(
        {
          id: `telegram-pipeline-gate-${channelId}`,
          triggers: [pipelineGatePending],
          retries: 0,
        },
        async ({ event }) =>
          postPipelineGateKeyboard({
            event: event.data,
            channelId,
            runInTx,
            transportStore,
            sendMessage: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts),
          }),
      ),
    );
  }

  // Boundary-prompt cleanup — listen on conversation/boundary/resolved and
  // rewrite the "Resume / Start fresh" prompt to its outcome, clearing the
  // keyboard. A button tap also drops the keyboard synchronously in its
  // callback handler; this listener owns the text edit and is the only path
  // that fires for a waiter-timeout resolution (no callback runs there).
  // Always registered — every Telegram channel can fire the boundary prompt.
  functions.push(
    inngest.createFunction(
      {
        id: `telegram-boundary-resolved-${channelId}`,
        triggers: [boundaryResolvedEvent],
        retries: 0,
      },
      async ({ event }) =>
        editResolvedBoundaryPrompt({
          event: event.data,
          channelId,
          editMessageText: (chatId, messageId, text, opts) =>
            bot.api.editMessageText(chatId, messageId, text, opts),
        }),
    ),
  );

  return { adapter, functions };
}

export { renderTelegramHtml } from "./render.js";

export const telegramModule = {
  channelType,
  setup,
  renderOutput: renderTelegramHtml,
  pipelineGates: true,
} satisfies AdapterModule;
