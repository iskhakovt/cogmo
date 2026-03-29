import { Bot } from "grammy";
import type { JsonValue } from "type-fest";
import { logger } from "../../logger.js";
import type { AdapterDeps, AdapterModule, AdapterSetupResult } from "../adapter-module.js";
import { contentToText } from "../content.js";
import type { Adapter } from "../types.js";

export const channelType = "telegram";

class TelegramAdapter implements Adapter {
  #bot: Bot;

  constructor(bot: Bot) {
    this.#bot = bot;
  }

  async deliver(platformAddress: string, content: JsonValue): Promise<void> {
    await this.#bot.api.sendMessage(Number(platformAddress), contentToText(content));
  }

  async stop(): Promise<void> {
    this.#bot.stop();
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

  bot.on("message:text", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    let session = await transport.resolveSession(addr);
    if (!session) {
      const result = await transport.createConversation(addr, handle, { isPrivate: true });
      if (result.isErr()) {
        logger.error({ error: result.error }, "failed to create conversation");
        return;
      }
      session = result.value;
    }
    const emitResult = await transport.emit(session.id, ctx.message.text, platformTs);
    if (emitResult.isErr()) {
      logger.error({ error: emitResult.error }, "failed to emit message");
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
