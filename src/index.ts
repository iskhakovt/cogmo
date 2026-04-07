import { S3Client } from "@aws-sdk/client-s3";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileTools } from "./agent/file-tools.js";
import { createFileService } from "./agent/files.js";
import { createHandleMessage } from "./agent/handle-message.js";
import { runStreamingAgentLoop } from "./agent/loop.js";
import { memoryTools } from "./agent/memory-tools.js";
import { DefaultPromptSource } from "./agent/prompt.js";
import { DrizzleAgentStore } from "./agent/store/index.js";
import { createDefaultTools } from "./agent/tools.js";
import { createWebTools } from "./agent/web-tools.js";
import { db } from "./db/index.js";
import { env } from "./env.js";
import { inboundArrived, inngest } from "./inngest/index.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { logger } from "./logger.js";
import { HindsightMemoryProvider } from "./memory/hindsight.js";
import { createDeliveryRouter } from "./transport/delivery-router.js";
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
  const webTools = createWebTools(env.TAVILY_API_KEY, env.OPENROUTER_API_KEY);
  const tools = createDefaultTools([...memoryTools, ...webTools, ...fileTools], env.USER_TIMEZONE);
  const promptSource = new DefaultPromptSource(env.USER_TIMEZONE);
  const memory = new HindsightMemoryProvider(env.HINDSIGHT_URL);

  // S3-compatible file storage (MinIO locally, AWS S3 / R2 in production)
  const s3Client = new S3Client({
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    region: env.S3_REGION,
    ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }
      : {}),
  });
  const fileService = createFileService(s3Client, env.S3_BUCKET);

  const {
    functions: channelFunctions,
    adapters,
    adapterMap,
  } = await startChannels({
    defaultUserId: user.id,
    defaultProfileId: profile.id,
    transportStore,
    agentStore,
    inngest,
    inboundArrived,
  });

  const deliveryRouter = createDeliveryRouter({ adapters: adapterMap, transportStore });

  const handleMessage = createHandleMessage({
    agentStore,
    transportStore,
    provider,
    tools,
    memory,
    promptSource,
    fileService,
    deliveryRouter,
    runStreamingAgentLoop,
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
