import { createFal } from "@ai-sdk/fal";
import { S3Client } from "@aws-sdk/client-s3";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { coreMemoryTools } from "./agent/core-memory-tools.js";
import { createDebounceFunctions, type DebounceConfig } from "./agent/debounce.js";
import { createObserver } from "./agent/evolution/index.js";
import { fileTools } from "./agent/file-tools.js";
import { createFileService, FILES_PROMPT_GUIDANCE } from "./agent/files.js";
import { createHandleMessage } from "./agent/handle-message.js";
import { createIdleTimer } from "./agent/idle-timer.js";
import { createImageTools } from "./agent/image-tools.js";
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
import { FallbackLlmProvider } from "./llm/fallback.js";
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
  /**
   * Custom `fetch` for the fal.ai provider — used by integration tests to
   * intercept fal HTTP traffic via a scoped fetch wrapper (see
   * `src/test/fal-mock.ts`). Production wiring leaves this undefined so the
   * SDK uses `globalThis.fetch`.
   */
  falFetchOverride?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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

  // Secrets store — required for decrypting provider credentials and channel tokens.
  if (!env.COGMO_MASTER_KEY) {
    throw new Error(
      "COGMO_MASTER_KEY is required. Generate one with: cogmo gen-key\n" + "Then run: cogmo setup",
    );
  }
  const secretsStore = new DrizzleSecretsStore(
    db,
    deriveMasterKey(parseMasterKey(env.COGMO_MASTER_KEY), "cogmo/secrets-at-rest/v1"),
  );

  const user = await agentStore.getFirstUser();
  const defaultProfile = await agentStore.getDefaultProfile();
  if (!user || !defaultProfile) {
    throw new Error("no user or profile found — run `cogmo setup` first");
  }
  const profile = await agentStore.getProfile(defaultProfile.id);
  if (!profile) {
    throw new Error("default profile disappeared — database inconsistency");
  }

  const provider =
    opts.providerOverride ??
    (await resolveProviderForModel(profile.model, agentStore, secretsStore));

  // S3-compatible file storage (MinIO locally, AWS S3 / R2 in production).
  // Constructed before tool registration because image-tools needs the
  // attachment store injected at factory time.
  const s3Client = new S3Client({
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    region: env.S3_REGION,
    ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }
      : {}),
  });
  const fileService = createFileService(s3Client, env.S3_BUCKET);
  const attachmentStore = createAttachmentStore(s3Client, env.S3_BUCKET);

  // Tool credentials: DB first (wizard-configured), env fallback (dev convenience).
  const tavilyKey = (await secretsStore.getSecret("tavily_api_key")) ?? env.TAVILY_API_KEY;
  const openrouterKey =
    (await secretsStore.getSecret("openrouter_api_key")) ?? env.OPENROUTER_API_KEY;
  const falKey = (await secretsStore.getSecret("fal_api_key")) ?? env.FAL_API_KEY;

  const webTools = createWebTools(tavilyKey, openrouterKey);
  const falProvider = falKey
    ? createFal({ apiKey: falKey, ...(opts.falFetchOverride && { fetch: opts.falFetchOverride }) })
    : undefined;
  const imageTools = createImageTools(falProvider, attachmentStore);
  const tools = createDefaultTools(
    [...memoryTools, ...webTools, ...fileTools, ...coreMemoryTools, ...imageTools],
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
    secretsStore,
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
    ...(profile.summarizationModel && { summarizationModel: profile.summarizationModel }),
  });

  const observer = createObserver({
    agentStore,
    provider,
    memory,
    ...(profile.extractionModel && { extractionModel: profile.extractionModel }),
  });

  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [
    handleMessage,
    idleTimer,
    observer,
    ...debounceFunctions,
    ...channelFunctions,
  ];

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
 * Resolve the LLM provider for a model via the model_providers routing table.
 *
 * Loads every provider registered for the model (ordered by position ASC),
 * decrypts each one's API key, constructs its adapter, and wraps the list
 * in a {@link FallbackLlmProvider}. A single-row list still gets the
 * wrapper — uniform wiring for the agent loop, zero fallback cost at
 * runtime. See `design/providers.md` → Fallback for the semantics.
 *
 * Requires COGMO_MASTER_KEY to be set (for secrets decryption).
 */
async function resolveProviderForModel(
  model: string,
  agentStore: AgentStore,
  secretsStore: SecretsStore,
): Promise<LlmProvider> {
  const rows = await agentStore.listProvidersForModel(model);
  if (rows.length === 0) {
    throw new Error(
      `No provider configured for model "${model}". Run \`cogmo setup\` to configure one.`,
    );
  }

  const providers: LlmProvider[] = [];
  for (const row of rows) {
    const apiKey = await secretsStore.getSecretById(row.secretId);
    if (!apiKey) {
      throw new Error(
        `Secret for provider "${row.name}" not found. Re-run \`cogmo setup\` to reconfigure.`,
      );
    }

    const attrs = row.attrs as Record<string, unknown>;

    switch (row.type) {
      case "anthropic":
        providers.push(new AnthropicProvider(apiKey, row.baseUrl ?? undefined));
        break;
      case "openai_compatible": {
        if (!row.baseUrl) {
          throw new Error(
            `Provider "${row.name}" (openai_compatible) requires a base URL. Re-run \`cogmo setup\` to reconfigure.`,
          );
        }
        providers.push(
          new OpenAICompatibleProvider(row.name, {
            apiKey,
            baseURL: row.baseUrl,
            headers: (attrs.headers as Record<string, string>) ?? undefined,
            promptCaching: (attrs.promptCaching as boolean) ?? false,
          }),
        );
        break;
      }
      default:
        throw new Error(`Unknown provider type: ${row.type}`);
    }
  }

  return new FallbackLlmProvider(providers);
}
