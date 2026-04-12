import { S3Client } from "@aws-sdk/client-s3";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { coreMemoryTools } from "./agent/core-memory-tools.js";
import { createDebounceFunctions, type DebounceConfig } from "./agent/debounce.js";
import { fileTools } from "./agent/file-tools.js";
import { createFileService, FILES_PROMPT_GUIDANCE } from "./agent/files.js";
import { createHandleMessage } from "./agent/handle-message.js";
import { createIdleTimer } from "./agent/idle-timer.js";
import { runStreamingAgentLoop } from "./agent/loop.js";
import { memoryTools } from "./agent/memory-tools.js";
import { DefaultPromptSource } from "./agent/prompt.js";
import { CORE_MEMORY_PROMPT_GUIDANCE, MEMORY_PROMPT_GUIDANCE } from "./agent/service.js";
import type { AgentStore } from "./agent/store/index.js";
import { DrizzleAgentStore } from "./agent/store/index.js";
import { createDefaultTools } from "./agent/tools.js";
import { createWebTools } from "./agent/web-tools.js";
import { db } from "./db/index.js";
import { env } from "./env.js";
import { inboundArrived, inngest } from "./inngest/index.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { OpenAICompatibleProvider } from "./llm/openai-compat.js";
import type { LlmProvider } from "./llm/provider.js";
import { logger } from "./logger.js";
import { HindsightMemoryProvider } from "./memory/hindsight.js";
import { deriveMasterKey, parseMasterKey } from "./secrets/encryption.js";
import { DrizzleSecretsStore, type SecretsStore } from "./secrets/store/index.js";
import { createAttachmentStore } from "./transport/attachment-store.js";
import { createDeliveryRouter } from "./transport/delivery-router.js";
import { startChannels } from "./transport/registry.js";
import { DrizzleTransportStore } from "./transport/store/index.js";

export interface BootstrapOptions {
  /** Inject a provider directly — skips DB resolution. Used by tests. */
  providerOverride?: LlmProvider;
}

/**
 * Wire all application dependencies — stores, providers, tools, adapters, Inngest functions.
 *
 * Returns the assembled pieces so callers can choose how to run them
 * (serve mode, connect mode, or in-process for tests).
 */
export async function bootstrap(opts: BootstrapOptions = {}) {
  await migrate(db, { migrationsFolder: "./migrations" });
  logger.info("database migrations applied");

  const agentStore = new DrizzleAgentStore(db);
  const transportStore = new DrizzleTransportStore(db);

  const user = await agentStore.getFirstUser();
  const defaultProfile = await agentStore.getDefaultProfile();
  if (!user || !defaultProfile) {
    throw new Error("no user or profile found — run `cogmo setup` first");
  }
  const profile = await agentStore.getProfile(defaultProfile.id);
  if (!profile) {
    throw new Error("default profile disappeared — database inconsistency");
  }

  const provider = opts.providerOverride ?? (await resolveProvider({ profile, agentStore }));
  const webTools = createWebTools(env.TAVILY_API_KEY, env.OPENROUTER_API_KEY);
  const tools = createDefaultTools(
    [...memoryTools, ...webTools, ...fileTools, ...coreMemoryTools],
    env.USER_TIMEZONE,
  );
  const promptSource = new DefaultPromptSource({
    timezone: env.USER_TIMEZONE,
    toolDefinitions: () => tools.definitions(),
    serviceGuidance: [MEMORY_PROMPT_GUIDANCE, FILES_PROMPT_GUIDANCE, CORE_MEMORY_PROMPT_GUIDANCE],
    getUserContext: async () => {
      const blocks = await agentStore.getCoreMemoryBlocks(user.id);
      if (blocks.length === 0) return null;
      return blocks.map((b) => `## ${b.key}\n${b.content}`).join("\n\n");
    },
  });
  const memory = new HindsightMemoryProvider(env.HINDSIGHT_URL);

  const idleTimeoutMs = env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;
  const debounceConfig: DebounceConfig = {
    idleTimeoutMs: env.DEBOUNCE_IDLE_SECONDS * 1000,
    maxWaitMs: env.DEBOUNCE_MAXWAIT_SECONDS * 1000,
    resumePolicy: env.DEBOUNCE_RESUME_POLICY,
  };

  // S3-compatible file storage (MinIO locally, AWS S3 / R2 in production)
  const s3Client = new S3Client({
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    region: env.S3_REGION,
    ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }
      : {}),
  });
  const fileService = createFileService(s3Client, env.S3_BUCKET);
  const attachmentStore = createAttachmentStore(s3Client, env.S3_BUCKET);

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
    attachments: attachmentStore,
    idleTimeoutMs,
  });

  const deliveryRouter = createDeliveryRouter({ adapters: adapterMap, transportStore });
  const idleTimer = createIdleTimer({ idleTimeoutMs, transportStore });
  const debounceFunctions = createDebounceFunctions(debounceConfig);

  const handleMessage = createHandleMessage({
    agentStore,
    transportStore,
    provider,
    tools,
    memory,
    promptSource,
    fileService,
    attachments: attachmentStore,
    debounceConfig,
    deliveryRouter,
    runStreamingAgentLoop,
    ...(env.SUMMARIZATION_MODEL && { summarizationModel: env.SUMMARIZATION_MODEL }),
  });

  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [handleMessage, idleTimer, ...debounceFunctions, ...channelFunctions];

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

/**
 * Resolve the LLM provider from DB config.
 *
 * Reads the profile's provider_id FK → loads provider row → decrypts
 * API key from secrets store → constructs the correct adapter class.
 *
 * Requires COGMO_MASTER_KEY to be set (for secrets decryption).
 */
async function resolveProvider(deps: {
  profile: { id: string; providerId: string | null };
  agentStore: AgentStore;
}): Promise<LlmProvider> {
  const { profile, agentStore } = deps;

  if (!profile.providerId) {
    throw new Error("No LLM provider configured. Run `cogmo setup` to configure one.");
  }

  if (!env.COGMO_MASTER_KEY) {
    throw new Error(
      "COGMO_MASTER_KEY is required to decrypt provider credentials.\n" +
        "Generate one with: cogmo gen-key",
    );
  }

  const masterKey = parseMasterKey(env.COGMO_MASTER_KEY);
  const encryptionKey = deriveMasterKey(masterKey, "cogmo/secrets-at-rest/v1");
  const secretsStore = new DrizzleSecretsStore(db, encryptionKey);

  const row = await agentStore.getProvider(profile.providerId);
  if (!row) {
    throw new Error(`LLM provider ${profile.providerId} not found in database`);
  }
  const apiKey = await secretsStore.getSecretById(row.secretId);
  if (!apiKey) {
    throw new Error(
      `Secret for LLM provider "${row.name}" not found. Re-run \`cogmo setup\` to reconfigure.`,
    );
  }

  const attrs = row.attrs as Record<string, unknown>;

  switch (row.type) {
    case "anthropic":
      return new AnthropicProvider(apiKey, row.baseUrl ?? undefined);
    case "openai_compatible":
      return new OpenAICompatibleProvider(row.name, {
        apiKey,
        baseURL: row.baseUrl ?? "",
        headers: (attrs.headers as Record<string, string>) ?? undefined,
        promptCaching: (attrs.promptCaching as boolean) ?? false,
      });
    default:
      throw new Error(`Unknown LLM provider type: ${row.type}`);
  }
}
