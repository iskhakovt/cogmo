import { Bot } from "grammy";
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

export async function setup(deps: AdapterDeps): Promise<AdapterSetupResult> {
  const { credentials, transport, attachments, boundary } = deps;
  const creds = credentials as { token: string; apiRoot?: string };
  const bot = new Bot(creds.token, creds.apiRoot ? { client: { apiRoot: creds.apiRoot } } : {});
  const adapter = new TelegramAdapter(bot, attachments);
  const profileDialogs = new ProfileDialogs();
  const repoDialogs = new RepoDialogs();
  // Forwarded messages never run commands; they reach the message handlers below.
  registerCommands(commandComposer(bot), { transport, profileDialogs, repoDialogs });
  registerCallbackQueries(bot, transport);
  registerMessageHandlers(bot, {
    transport,
    token: creds.token,
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

export { renderTelegramHtml } from "./render.js";

export const telegramModule = {
  channelType,
  setup,
  renderOutput: renderTelegramHtml,
  pipelineGates: true,
} satisfies AdapterModule;
