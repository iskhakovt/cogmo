import { Bot } from "grammy";
import { z } from "zod";
import { logger } from "../../../logger.js";
import type { AdapterDeps, AdapterModule, AdapterSetupResult } from "../../adapter-module.js";
import { TelegramAdapter } from "./adapter.js";
import { registerCallbackQueries } from "./callback-routes.js";
import { publishCommandMenu, registerCommands } from "./command-routes.js";
import { commandComposer } from "./forwarded.js";
import { createInboundDispatch } from "./inbound-dispatch.js";
import { telegramFunctions } from "./inngest-functions.js";
import { registerMessageHandlers } from "./message-handlers.js";
import { ProfileDialogs } from "./profile-dialog.js";
import { renderTelegramHtml } from "./render.js";
import { RepoDialogs } from "./repo-dialog.js";

export const channelType = "telegram";

/** grammY's default Bot API server. */
const TELEGRAM_API_ROOT = "https://api.telegram.org";

/** `channels.credentials` once the registry has resolved its secret references. */
const TelegramCredentialsSchema = z.object({
  token: z.string().min(1),
  /** A self-hosted Bot API server; Telegram's own when absent or empty. */
  apiRoot: z.string().optional(),
});

export async function setup(deps: AdapterDeps): Promise<AdapterSetupResult> {
  const { credentials, transport, attachments, boundary } = deps;
  const parsed = TelegramCredentialsSchema.safeParse(credentials);
  if (!parsed.success) {
    throw new Error(`telegram credentials: ${z.prettifyError(parsed.error)}`);
  }
  const { token } = parsed.data;
  // An empty apiRoot means Telegram's own server, for the bot and its file downloads alike.
  const apiRoot = parsed.data.apiRoot || TELEGRAM_API_ROOT;
  const bot = new Bot(token, { client: { apiRoot } });
  const adapter = new TelegramAdapter(bot, attachments);
  const profileDialogs = new ProfileDialogs();
  const repoDialogs = new RepoDialogs();
  // Forwarded messages never run commands; they reach the message handlers below.
  registerCommands(commandComposer(bot), { transport, profileDialogs, repoDialogs });
  registerCallbackQueries(bot, transport);
  registerMessageHandlers(bot, {
    transport,
    token,
    apiRoot,
    profileDialogs,
    repoDialogs,
    dispatchInbound: createInboundDispatch({ transport, api: bot.api, boundary }),
  });

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, "telegram bot error");
  });

  await publishCommandMenu(bot.api);

  adapter.attachPolling(
    bot.start({
      onStart: () => logger.info("telegram adapter started"),
    }),
  );

  return { adapter, functions: telegramFunctions(deps, bot) };
}

export const telegramModule = {
  channelType,
  setup,
  renderOutput: renderTelegramHtml,
  pipelineGates: true,
} satisfies AdapterModule;
