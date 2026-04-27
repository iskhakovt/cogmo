import { Bot, InputFile } from "grammy";
import type { JsonValue } from "type-fest";
import { PLAN_CALLBACK_REGEX, parsePlanCallback } from "../../../agent/coding/plan-keyboard.js";
import { CodingProgressSubscriber } from "../../../agent/coding/progress-subscriber.js";
import { parseGeneratedImagePayload } from "../../../agent/image-tools.js";
import { codingTaskStart } from "../../../inngest/events.js";
import type { StreamEvent } from "../../../llm/types.js";
import { logger } from "../../../logger.js";
import {
  type AdapterDeps,
  type AdapterModule,
  type AdapterSetupResult,
  isRenderedMessage,
  type RenderedMessage,
} from "../../adapter-module.js";
import { type AttachmentStore, mediaTypeToExt } from "../../attachment-store.js";
import { contentToText } from "../../content.js";
import type { Adapter, StreamHandle, StreamingAdapter } from "../../types.js";
import {
  handleEnd,
  handleModel,
  handleName,
  handleNew,
  handlePlanCallback,
  handleProfile,
  handleRepo,
  handleResume,
  handleResumeCallback,
  handleSessions,
  type TelegramCommandContext,
} from "./commands.js";
import { ProfileDialogs } from "./profile-dialog.js";
import { renderTelegramHtml, stripHtmlTags } from "./render.js";

export const channelType = "telegram";

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
    } else {
      await this.#bot.api.sendMessage(chatId, contentToText(content as JsonValue));
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
    }
    // other tool_results: skip — LLM will summarize

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

  async finish(): Promise<void> {
    await this.#pending;
    if (this.#accumulated && this.#messageId) {
      // Final edit with HTML formatting
      const rendered = renderTelegramHtml(this.#accumulated);
      try {
        await this.#bot.api.editMessageText(this.#chatId, this.#messageId, rendered.text, {
          ...(rendered.parseMode && { parse_mode: rendered.parseMode }),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("can't parse entities")) {
          logger.warn("telegram: stream finish HTML parse failed, keeping plain text");
        } else if (!msg.includes("message is not modified")) {
          throw err;
        }
      }
    } else if (this.#accumulated) {
      await this.#edit(this.#accumulated);
    }
    this.#onDone();
  }

  async abort(error: string): Promise<void> {
    await this.#pending;
    const text = this.#accumulated ? `${this.#accumulated}\n\n⚠️ ${error}` : `⚠️ ${error}`;
    await this.#edit(text);
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
  bot.command("model", (ctx) => handleModel(transport, toCmdCtx(ctx)));
  bot.command("repo", (ctx) => handleRepo(transport, toCmdCtx(ctx)));

  // Mid-dialog abort for /profile new|edit flows.
  bot.command("cancel", async (ctx) => {
    if (profileDialogs.cancel(ctx.chat.id)) {
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

      const file = await ctx.api.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${creds.token}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());

      const path = await transport.uploadAttachment(buffer, "image/jpeg");
      const caption = ctx.message.caption ?? "";

      const content: JsonValue[] = [];
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

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, "telegram bot error");
  });

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
    const { inngest, codingStore, transportStore, streamingRegistry } = deps.codingProgress;
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
          const task = await codingStore.getTask(taskId);
          if (!task?.conversationId) return { skipped: "no conversation" };

          const sessions = await transportStore.getActiveSessionsForConversation(
            task.conversationId,
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
  }

  return { adapter, functions };
}

export { renderTelegramHtml } from "./render.js";

export const telegramModule = {
  channelType,
  setup,
  renderOutput: renderTelegramHtml,
} satisfies AdapterModule;
