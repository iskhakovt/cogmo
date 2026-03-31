import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createHandleMessage } from "./agent/handle-message.js";
import { runAgentLoop } from "./agent/loop.js";
import { memoryTools } from "./agent/memory-tools.js";
import { DefaultPromptSource } from "./agent/prompt.js";
import { DrizzleAgentStore } from "./agent/store/index.js";
import { createDefaultTools } from "./agent/tools.js";
import { db } from "./db/index.js";
import { env } from "./env.js";
import { inboundArrived, inngest } from "./inngest/index.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { logger } from "./logger.js";
import { HindsightMemoryProvider } from "./memory/hindsight.js";
import { startChannels } from "./transport/registry.js";
import { DrizzleTransportStore } from "./transport/store/index.js";

/**
 * Wire all application dependencies — stores, providers, tools, adapters, Inngest functions.
 *
 * Returns the assembled pieces so callers can choose how to run them
 * (serve mode, connect mode, or in-process for tests).
 */
export async function bootstrap() {
  await migrate(db, { migrationsFolder: "./migrations" });
  logger.info("database migrations applied");

  const agentStore = new DrizzleAgentStore(db);
  const transportStore = new DrizzleTransportStore(db);

  const user = await agentStore.getFirstUser();
  const profile = await agentStore.getDefaultProfile();
  if (!user || !profile) {
    throw new Error("no user or profile found — run `seed` first");
  }

  const provider = new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL);
  const tools = createDefaultTools(memoryTools);
  const promptSource = new DefaultPromptSource();
  const memory = new HindsightMemoryProvider(env.HINDSIGHT_URL);

  const handleMessage = createHandleMessage({
    agentStore,
    transportStore,
    provider,
    tools,
    memory,
    promptSource,
    runAgentLoop,
  });

  const { functions: channelFunctions, adapters } = await startChannels({
    defaultUserId: user.id,
    defaultProfileId: profile.id,
    transportStore,
    agentStore,
    inngest,
    inboundArrived,
  });

  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [handleMessage, ...channelFunctions];

  return {
    db,
    inngest,
    functions,
    adapters,
    agentStore,
    transportStore,
    provider,
    memory,
  };
}
