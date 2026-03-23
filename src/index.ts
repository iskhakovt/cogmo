import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connect } from "inngest/connect";
import { runAgentLoop } from "./agent/loop.js";
import { assembleSystemPrompt } from "./agent/prompt.js";
import { createDefaultTools } from "./agent/tools.js";
import { CliChannel } from "./channels/cli.js";
import { db } from "./db/index.js";
import { env } from "./env.js";
import {
  createCliRespond,
  createHandleMessage,
  inngest,
  messageReceived,
} from "./inngest/index.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { logger } from "./logger.js";

async function main() {
  // Apply database migrations
  await migrate(db, { migrationsFolder: "./migrations" });
  logger.info("database migrations applied");

  // Wire dependencies
  const provider = new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL);
  const tools = createDefaultTools();

  const handleMessage = createHandleMessage({
    db,
    provider,
    tools,
    assembleSystemPrompt,
    runAgentLoop,
  });

  const cliChannel = new CliChannel();
  const cliRespond = createCliRespond(cliChannel);

  // Start Inngest Connect — WebSocket to local Inngest server
  const connection = await connect({
    apps: [
      {
        client: inngest,
        functions: [handleMessage, cliRespond],
      },
    ],
    handleShutdownSignals: ["SIGTERM", "SIGINT"],
  });

  logger.info({ connectionId: connection.connectionId }, "inngest connected");

  // Start CLI input — each line becomes a message/received event
  cliChannel.start((msg) => {
    inngest
      .send(
        messageReceived.create({
          conversationId: msg.chatId,
          channel: msg.channel,
          chatId: msg.chatId,
          userId: msg.userId,
          text: msg.text,
        }),
      )
      .catch((err) => logger.error({ err }, "failed to send message event"));
  });

  logger.info("assistant ready — type a message");

  // Wait for connection to close (shutdown signal)
  await connection.closed;
  cliChannel.stop();
  logger.info("assistant stopped");
}

main().catch((err) => {
  logger.fatal({ err }, "fatal error");
  process.exit(1);
});
