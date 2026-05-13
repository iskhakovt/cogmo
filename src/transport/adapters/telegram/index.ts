import { Bot, InputFile } from "grammy";
import type { JsonValue } from "type-fest";
import {
  buildPermissionKeyboard,
  PERMISSION_CALLBACK_REGEX,
  parsePermissionCallback,
} from "../../../agent/coding/permission-keyboard.js";
import { PLAN_CALLBACK_REGEX, parsePlanCallback } from "../../../agent/coding/plan-keyboard.js";
import { CodingProgressSubscriber } from "../../../agent/coding/progress-subscriber.js";
import { parseGeneratedDocumentPayload } from "../../../agent/document-tools.js";
import { parseGeneratedImagePayload } from "../../../agent/image-tools.js";
import {
  codingTaskPermissionRequested,
  codingTaskStart,
  skillsDeployApprovalRequested,
} from "../../../inngest/events.js";
import type { StreamEvent } from "../../../llm/types.js";
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
import type { Adapter, StreamHandle, StreamingAdapter } from "../../types.js";
import {
  handleClasses,
  handleCompartments,
  handleDisable,
  handleEnable,
  handleEnd,
  handleMcp,
  handleModel,
  handleName,
  handleNew,
  handlePermissionCallback,
  handlePlanCallback,
  handleProfile,
  handleRepair,
  handleRepo,
  handleResume,
  handleResumeCallback,
  handleSessions,
  handleSkills,
  handleSkillsApprovalCallback,
  handleStatus,
  handleVoice,
  type TelegramCommandContext,
} from "./commands.js";
import { ProfileDialogs } from "./profile-dialog.js";
import { renderTelegramHtml, stripHtmlTags } from "./render.js";
import { RepoDialogs } from "./repo-dialog.js";
import { postSkillsApprovalKeyboard } from "./skills-approval-poster.js";

export const channelType = "telegram";

// Telegram caps a single text message at 4096 chars. Streaming edits that
// crossed this cap previously raised MESSAGE_TOO_LONG, killing the conversation
// at the boundary. We rotate to a new message before the source text reaches
// 4000 chars (leaving headroom for HTML tag expansion); chunks whose HTML
// render still exceeds the cap fall back to plain text.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_CHUNK_TARGET = 4000;

/**
 * Find a clean split point in `text` no later than `target`. Prefers higher-
 * quality boundaries (paragraph > line > sentence > word) and falls back to a
 * hard char split if no break exists in [target/2, target]. The returned
 * index is the slice point — `text.slice(0, idx)` is the head, the rest is
 * the tail.
 */
export function findTelegramSplitBoundary(text: string, target: number): number {
  if (text.length <= target) return text.length;
  // Reject boundaries close to the start — a sub-500-char head wastes a
  // message. Above that, prefer the highest-quality separator anywhere in
  // [minIdx, target].
  const minIdx = Math.min(500, Math.floor(target * 0.25));
  for (const sep of ["\n\n", "\n", ". ", "! ", "? ", " "]) {
    const idx = text.lastIndexOf(sep, target - sep.length);
    if (idx >= minIdx) return idx + sep.length;
  }
  // No natural break — hard cut. JS strings index UTF-16 code units; never
  // slice between the two halves of a surrogate pair, or Telegram receives
  // malformed UTF-8 and rejects the message.
  let idx = target;
  const code = text.charCodeAt(idx - 1);
  if (code >= 0xd800 && code <= 0xdbff) idx -= 1;
  return idx;
}

class TelegramAdapter implements Adapter, StreamingAdapter {
  #bot: Bot;
  #attachments: AttachmentStore;
  #activeStreams = new Map<string, TelegramStreamHandle>();

  constructor(bot: Bot, attachments: AttachmentStore) {
    this.#bot = bot;
    this.#attachments = attachments;
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

  async openStream(platformAddress: string, runId: string): Promise<StreamHandle> {
    const existing = this.#activeStreams.get(runId);
    if (existing) return existing;

    const handle = new TelegramStreamHandle(
      this.#bot,
      this.#attachments,
      Number(platformAddress),
      runId,
      () => {
        this.#activeStreams.delete(runId);
      },
    );
    this.#activeStreams.set(runId, handle);
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
  }
}

/**
 * Stream handle for Telegram — sends an initial message on first push,
 * then edits it progressively with throttling to respect rate limits.
 *
 * Generated images (`tool_result` from `generate_image`) are delivered
 * mid-stream via `sendPhoto`. Dedup is keyed on `runId + path` so Inngest
 * retries of the same handle never send the image twice.
 */
class TelegramStreamHandle implements StreamHandle {
  #bot: Bot;
  #attachments: AttachmentStore;
  #chatId: number;
  #runId: string;
  #messageId: number | null = null;
  #accumulated = "";
  #lastEditTime = 0;
  #editInterval = 500; // ms between edits
  #sentImages = new Set<string>();
  #sentDocuments = new Set<string>();
  #onDone: () => void;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    bot: Bot,
    attachments: AttachmentStore,
    chatId: number,
    runId: string,
    onDone: () => void,
  ) {
    this.#bot = bot;
    this.#attachments = attachments;
    this.#chatId = chatId;
    this.#runId = runId;
    this.#onDone = onDone;
  }

  async push(event: StreamEvent): Promise<void> {
    if (event.type === "text_delta") {
      this.#accumulated += event.text;
    } else if (event.type === "tool_start") {
      this.#accumulated += `\n🔍 ${event.name}...\n`;
    } else if (event.type === "status") {
      this.#accumulated += `\n⏳ ${event.message}\n`;
    } else if (event.type === "tool_result" && event.name === "generate_image" && !event.isError) {
      await this.#sendGeneratedImage(event.output);
      return;
    } else if (event.type === "tool_result" && event.name === "send_document" && !event.isError) {
      await this.#sendGeneratedDocument(event.output);
      return;
    }
    // other tool_results: skip — LLM will summarize

    // Drain any overflow eagerly, bypassing the throttle — once accumulated
    // crosses the chunk target, further edits to the same message would 400.
    await this.#drainOverflow();
    await this.#throttledEdit();
  }

  async #sendGeneratedImage(output: string): Promise<void> {
    const payload = parseGeneratedImagePayload(output);
    if (!payload) {
      logger.warn(
        { runId: this.#runId },
        "telegram: generate_image tool_result didn't match expected payload shape",
      );
      return;
    }
    const { path, mediaType } = payload;

    // Dedup across Inngest retries — same run + path = already delivered.
    // Only mark as sent AFTER successful delivery so a transient S3/Telegram
    // failure leaves room for the next retry to succeed.
    const dedupKey = `${this.#runId}:${path}`;
    if (this.#sentImages.has(dedupKey)) return;

    try {
      const bytes = await this.#attachments.download(path);
      await this.#bot.api.sendPhoto(
        this.#chatId,
        new InputFile(bytes, `image.${mediaTypeToExt(mediaType)}`),
      );
      this.#sentImages.add(dedupKey);
      // Strip the "🔍 generate_image..." placeholder from the accumulated
      // text now that the photo has been delivered. Otherwise the placeholder
      // lingers in the final edited message alongside the image.
      this.#accumulated = this.#accumulated.replace(/\n?🔍 generate_image\.\.\.\n?/g, "");
    } catch (err) {
      // Don't crash the stream on a single image failure — user still gets the text.
      // dedupKey is intentionally NOT added so the next Inngest retry can try again.
      logger.error({ err, path, runId: this.#runId }, "telegram: failed to send generated image");
    }
  }

  async #sendGeneratedDocument(output: string): Promise<void> {
    const payload = parseGeneratedDocumentPayload(output);
    if (!payload) {
      logger.warn(
        { runId: this.#runId },
        "telegram: send_document tool_result didn't match expected payload shape",
      );
      return;
    }
    const { path, name } = payload;

    const dedupKey = `${this.#runId}:${path}`;
    if (this.#sentDocuments.has(dedupKey)) return;

    try {
      const bytes = await this.#attachments.download(path);
      await this.#bot.api.sendDocument(this.#chatId, new InputFile(bytes, name));
      this.#sentDocuments.add(dedupKey);
      this.#accumulated = this.#accumulated.replace(/\n?🔍 send_document\.\.\.\n?/g, "");
    } catch (err) {
      logger.error(
        { err, path, runId: this.#runId },
        "telegram: failed to send generated document",
      );
    }
  }

  async finish(): Promise<void> {
    await this.#pending;
    await this.#drainOverflow();
    if (this.#accumulated) {
      await this.#finalizeChunk(this.#accumulated);
      this.#accumulated = "";
    }
    this.#onDone();
  }

  async abort(error: string): Promise<void> {
    await this.#pending;
    // Drain any mid-stream overflow first so the error tail lands on the last
    // partial chunk, not floating in its own message.
    await this.#drainOverflow();
    const text = this.#accumulated ? `${this.#accumulated}\n\n⚠️ ${error}` : `⚠️ ${error}`;
    this.#accumulated = text;
    // Appending the tail may push us back over the cap — drain once more,
    // then emit whatever remains as plain text (no HTML render on errors).
    await this.#drainOverflow();
    if (this.#accumulated) {
      await this.#edit(this.#accumulated);
      this.#accumulated = "";
    }
    this.#onDone();
  }

  async #throttledEdit(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastEditTime < this.#editInterval) return;
    await this.#edit(this.#accumulated);
  }

  async #edit(text: string): Promise<void> {
    if (!text) return;
    // Serialize edits — no two in flight at once
    this.#pending = this.#pending.then(async () => {
      try {
        if (!this.#messageId) {
          const msg = await this.#bot.api.sendMessage(this.#chatId, text);
          this.#messageId = msg.message_id;
        } else {
          await this.#bot.api.editMessageText(this.#chatId, this.#messageId, text);
        }
        this.#lastEditTime = Date.now();
      } catch (err: unknown) {
        // Telegram returns 400 "message is not modified" for no-op edits — ignore
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("message is not modified")) throw err;
      }
    });
    await this.#pending;
  }

  /**
   * Split `#accumulated` into Telegram-sized chunks. Each head is finalized
   * (HTML-rendered into its own message) and `#messageId` is reset so the
   * tail starts a fresh message. Repeats until what remains fits.
   */
  async #drainOverflow(): Promise<void> {
    while (this.#accumulated.length > TELEGRAM_CHUNK_TARGET) {
      const splitIdx = findTelegramSplitBoundary(this.#accumulated, TELEGRAM_CHUNK_TARGET);
      const head = this.#accumulated.slice(0, splitIdx);
      this.#accumulated = this.#accumulated.slice(splitIdx);
      await this.#finalizeChunk(head);
    }
  }

  /**
   * Send/edit one finalized message with HTML rendering, then freeze it by
   * clearing `#messageId`. Falls back to plain text if the rendered output
   * exceeds Telegram's char cap or fails entity parsing.
   */
  async #finalizeChunk(text: string): Promise<void> {
    if (!text) return;
    this.#pending = this.#pending.then(async () => {
      const rendered = renderTelegramHtml(text);
      const useHtml =
        rendered.parseMode != null && rendered.text.length <= TELEGRAM_MAX_MESSAGE_LENGTH;
      const body = useHtml ? rendered.text : text;
      const opts = useHtml && rendered.parseMode ? { parse_mode: rendered.parseMode } : undefined;
      try {
        if (this.#messageId == null) {
          const sent = opts
            ? await this.#bot.api.sendMessage(this.#chatId, body, opts)
            : await this.#bot.api.sendMessage(this.#chatId, body);
          // Don't store sent.message_id — this chunk is final, the next chunk
          // (if any) creates a new message.
          void sent;
        } else {
          if (opts) {
            await this.#bot.api.editMessageText(this.#chatId, this.#messageId, body, opts);
          } else {
            await this.#bot.api.editMessageText(this.#chatId, this.#messageId, body);
          }
        }
        this.#lastEditTime = Date.now();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("can't parse entities")) {
          // On the edit path the message already shows the plain-text body
          // from prior throttled edits, so no follow-up call is needed. On
          // the send path the chunk hasn't been delivered yet — retry plain.
          if (this.#messageId == null) {
            logger.warn("telegram: chunk HTML parse failed, retrying as plain text");
            await this.#bot.api.sendMessage(this.#chatId, text);
          } else {
            logger.warn("telegram: stream finish HTML parse failed, keeping plain text");
          }
        } else if (!msg.includes("message is not modified")) {
          throw err;
        }
      } finally {
        this.#messageId = null;
      }
    });
    await this.#pending;
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
  const { credentials, transport, attachments } = deps;
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

  // Permission keyboard: Once / Task / Deny — callback_data =
  // "perm:<taskId>:<requestIdShort>:<o|t|d>"
  bot.callbackQuery(PERMISSION_CALLBACK_REGEX, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const fromId = ctx.from?.id;
    if (!data || fromId === undefined) return;
    const parsed = parsePermissionCallback(data);
    if (!parsed) return;

    const outcome = await handlePermissionCallback(transport, parsed, String(fromId));
    try {
      await ctx.editMessageText(outcome.editText, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("message is not modified")) {
        logger.warn({ err }, "telegram: failed to edit permission message");
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

    const outcome = await handleSkillsApprovalCallback(transport, parsed, String(fromId));
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

  async function resolveOrCreateSession(addr: string, handle: string) {
    let session = await transport.resolveSession(addr);
    if (!session) {
      const result = await transport.createConversation(addr, handle, { isPrivate: true });
      if (result.isErr()) {
        if (result.error.code === "identity_rejected") {
          logger.info({ handle }, "telegram: rejected unauthorized user");
        } else {
          logger.error({ error: result.error }, "failed to create conversation");
        }
        return null;
      }
      session = result.value;
    }
    return session;
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

    const session = await resolveOrCreateSession(addr, handle);
    if (!session) return;

    const emitResult = await transport.emit(session.id, ctx.message.text, platformTs);
    if (emitResult.isErr()) {
      logger.error({ error: emitResult.error }, "failed to emit message");
    }
  });

  bot.on("message:photo", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    const session = await resolveOrCreateSession(addr, handle);
    if (!session) return;

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

      const emitResult = await transport.emit(session.id, content, platformTs);
      if (emitResult.isErr()) {
        logger.error({ error: emitResult.error }, "failed to emit photo message");
      }
    } catch (err) {
      logger.error({ err }, "failed to process photo");
    }
  });

  bot.on("message:document", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    const session = await resolveOrCreateSession(addr, handle);
    if (!session) return;

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

      const emitResult = await transport.emit(session.id, content, platformTs);
      if (emitResult.isErr()) {
        logger.error({ error: emitResult.error }, "failed to emit document message");
      }
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

    const session = await resolveOrCreateSession(addr, handle);
    if (!session) return;

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

      const emitResult = await transport.emit(session.id, content, platformTs);
      if (emitResult.isErr()) {
        logger.error({ error: emitResult.error }, "failed to emit voice message");
      }
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
      { command: "cancel", description: "Abort the current interactive dialog" },
      { command: "start", description: "Show help" },
    ])
    .catch((err) => logger.warn({ err }, "failed to register telegram bot commands"));

  bot.start({
    onStart: () => logger.info("telegram adapter started"),
  });

  // Coding-progress wiring — listen for coding/task/start, find the
  // Telegram session attached to the task's conversation, and subscribe
  // a per-task message renderer that edits in place as plan + execute
  // events stream through the registry.
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [];
  if (deps.codingProgress) {
    const { inngest, codingStore, runInTx, transportStore, streamingRegistry } =
      deps.codingProgress;
    const channelId = deps.channelId;
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

          CodingProgressSubscriber.start({
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

    // Tool gate — listen for `coding/task/permission-requested`, render the
    // inline keyboard message into the task's Telegram session. The
    // orchestrator's `step.waitForEvent` is already armed and resumes when
    // the user taps a button. requestId is already truncated by the
    // orchestrator (matches the same `shortenRequestId` form the keyboard
    // and the wait `if:` filter use).
    functions.push(
      inngest.createFunction(
        {
          id: `telegram-coding-permission-${channelId}`,
          triggers: [codingTaskPermissionRequested],
          retries: 0,
        },
        async ({ event }) => {
          const { taskId, requestId, tool } = event.data;
          const task = await runInTx((tx) => codingStore.getTask(tx, taskId));
          const taskConversationId = task?.conversationId;
          if (!taskConversationId) return { skipped: "no conversation" };

          const sessions = await runInTx((tx) =>
            transportStore.getActiveSessionsForConversation(tx, taskConversationId),
          );
          const tgSession = sessions.find((s) => s.channelId === channelId);
          if (!tgSession) return { skipped: "no telegram session for this conversation" };

          const keyboard = buildPermissionKeyboard(taskId, requestId);
          // Tool names may contain `[`, `*`, `_`, etc. (notably MCP tools
          // like `mcp__github__create_pr`). Posting them under
          // `parse_mode: "Markdown"` would 400-fail the request when the
          // markup turns out to be malformed. Plain text avoids the
          // escape-or-break tradeoff entirely; the prompt is short and
          // doesn't need formatting.
          const text = `🔐 Permission requested: ${tool}\n\nAllow this tool call?`;
          await bot.api.sendMessage(Number(tgSession.platformAddress), text, {
            reply_markup: keyboard,
          });
          return { posted: true };
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
    const { inngest, skillStore, runInTx, transportStore } = deps.skillsApproval;
    const channelId = deps.channelId;
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

  return { adapter, functions };
}

export { renderTelegramHtml } from "./render.js";

export const telegramModule = {
  channelType,
  setup,
  renderOutput: renderTelegramHtml,
} satisfies AdapterModule;
