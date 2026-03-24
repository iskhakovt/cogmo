import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connect } from "inngest/connect";
import { runAgentLoop } from "./agent/loop.js";
import { DefaultPromptSource } from "./agent/prompt.js";
import { createDefaultTools } from "./agent/tools.js";
import { CliChannel } from "./channels/cli.js";
import { single } from "./db/helpers.js";
import { db } from "./db/index.js";
import { profiles, users } from "./db/schema.js";
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

  // Ensure default user and profile exist
  const defaultProfileId = await ensureDefaults();

  // Wire dependencies
  const provider = new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL);
  const tools = createDefaultTools();
  const promptSource = new DefaultPromptSource();

  const handleMessage = createHandleMessage({
    db,
    provider,
    tools,
    assembleSystemPrompt: (db, profileId) => promptSource.assemble(db, profileId),
    runAgentLoop,
    defaultProfileId,
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

const DEFAULT_BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

async function ensureDefaults(): Promise<string> {
  return db.transaction(async (tx) => {
    // Upsert default user
    const existingUsers = await tx.select().from(users).limit(1);
    let userId: string;
    if (existingUsers[0]) {
      userId = existingUsers[0].id;
    } else {
      userId = single(await tx.insert(users).values({}).returning({ id: users.id })).id;
    }

    // Upsert default profile
    const existingProfiles = await tx.select().from(profiles).limit(1);
    if (existingProfiles[0]) {
      return existingProfiles[0].id;
    }

    const newProfile = single(
      await tx
        .insert(profiles)
        .values({
          userId,
          name: "assistant",
          basePrompt: DEFAULT_BASE_PROMPT,
          model: "claude-sonnet-4-20250514",
          toolSet: ["get_current_time"],
        })
        .returning({ id: profiles.id }),
    );

    logger.info("created default user and profile");
    return newProfile.id;
  });
}

main().catch((err) => {
  logger.fatal({ err }, "fatal error");
  process.exit(1);
});
