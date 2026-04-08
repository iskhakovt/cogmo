import { Bot } from "grammy";
import type { JsonValue } from "type-fest";
import type { StreamEvent } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { AdapterDeps, AdapterModule, AdapterSetupResult } from "../adapter-module.js";
import { contentToText } from "../content.js";
import type { Adapter, StreamHandle, StreamingAdapter } from "../types.js";

export const channelType = "telegram";

class TelegramAdapter implements Adapter, StreamingAdapter {
  #bot: Bot;
  #activeStreams = new Map<string, TelegramStreamHandle>();

  constructor(bot: Bot) {
    this.#bot = bot;
  }

  async deliver(platformAddress: string, content: JsonValue): Promise<void> {
    await this.#bot.api.sendMessage(Number(platformAddress), contentToText(content));
  }

  async openStream(platformAddress: string, runId: string): Promise<StreamHandle> {
    const existing = this.#activeStreams.get(runId);
    if (existing) return existing;

    const handle = new TelegramStreamHandle(this.#bot, Number(platformAddress), () => {
      this.#activeStreams.delete(runId);
    });
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
 */
class TelegramStreamHandle implements StreamHandle {
  #bot: Bot;
  #chatId: number;
  #messageId: number | null = null;
  #accumulated = "";
  #lastEditTime = 0;
  #editInterval = 500; // ms between edits
  #onDone: () => void;
  #pending: Promise<void> = Promise.resolve();

  constructor(bot: Bot, chatId: number, onDone: () => void) {
    this.#bot = bot;
    this.#chatId = chatId;
    this.#onDone = onDone;
  }

  async push(event: StreamEvent): Promise<void> {
    if (event.type === "text_delta") {
      this.#accumulated += event.text;
    } else if (event.type === "tool_start") {
      this.#accumulated += `\n🔍 ${event.name}...\n`;
    }
    // tool_result: skip — LLM will summarize

    await this.#throttledEdit();
  }

  async finish(): Promise<void> {
    await this.#pending;
    if (this.#accumulated) {
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
export async function setup(deps: AdapterDeps): Promise<AdapterSetupResult> {
  const { credentials, transport } = deps;
  const creds = credentials as { token: string; apiRoot?: string };
  const bot = new Bot(creds.token, creds.apiRoot ? { client: { apiRoot: creds.apiRoot } } : {});
  const adapter = new TelegramAdapter(bot);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Assistant ready. Send a message to start chatting.\n\n/new — start a new conversation",
    );
  });

  bot.command("new", async (ctx) => {
    const addr = String(ctx.chat.id);
    const session = await transport.resolveSession(addr);
    if (session) {
      await transport.closeSession(session.id);
    }
    await ctx.reply("New conversation started.");
  });

  async function resolveOrCreateSession(addr: string, handle: string) {
    let session = await transport.resolveSession(addr);
    if (!session) {
      const result = await transport.createConversation(addr, handle, { isPrivate: true });
      if (result.isErr()) {
        logger.error({ error: result.error }, "failed to create conversation");
        return null;
      }
      session = result.value;
    }
    return session;
  }

  bot.on("message:text", async (ctx) => {
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
      const base64 = buffer.toString("base64");

      const path = await transport.uploadAttachment(base64, "image/jpeg");
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

  return { adapter, functions: [] };
}

export default { channelType, setup } satisfies AdapterModule;
