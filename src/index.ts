import { hostname } from "node:os";
import { createFal } from "@ai-sdk/fal";
import { S3Client } from "@aws-sdk/client-s3";
import Docker from "dockerode";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ClaudeCodeBackend } from "./agent/coding/claude.js";
import {
  createCodingExecuteOrchestrator,
  createCodingOrchestrator,
  type ExecuteStreamHandle,
  type PlanStreamHandle,
} from "./agent/coding/orchestrator.js";
import { createCodingService } from "./agent/coding/service.js";
import { DrizzleCodingStore } from "./agent/coding/store/index.js";
import { CodingStreamingRegistry } from "./agent/coding/streaming-registry.js";
import { DELEGATE_CODING_GUIDANCE, delegateCodingTool } from "./agent/coding/tool.js";
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
import { LocalInProcessSandbox, type Sandbox } from "./sandbox/index.js";
import { DrizzleSandboxStore } from "./sandbox/store/index.js";
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
  const sandboxStore = new DrizzleSandboxStore(db);

  // Sandbox is opt-in via SANDBOX_RUNTIME — coding-delegation features fail
  // with a clear error when the env var is unset. No silent fallback.
  let sandbox: Sandbox | null = null;
  let sandboxInstanceId: string | null = null;
  if (env.SANDBOX_RUNTIME) {
    const docker = new Docker();
    const instance = await sandboxStore.insertInstance({
      host: hostname(),
      pid: process.pid,
    });
    sandboxInstanceId = instance.id;
    sandbox = await LocalInProcessSandbox.create({
      docker,
      store: sandboxStore,
      runtime: env.SANDBOX_RUNTIME,
      instanceId: instance.id,
    });
    const { orphansReaped } = await sandbox.reconcileCrashedInstances(instance.id);
    if (orphansReaped > 0) {
      logger.warn({ orphansReaped }, "reaped orphan containers from prior instance(s)");
    }
    logger.info({ runtime: env.SANDBOX_RUNTIME, instanceId: instance.id }, "sandbox initialized");
  } else {
    logger.info("SANDBOX_RUNTIME unset — sandbox module disabled (coding-delegation unavailable)");
  }

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

  // Coding store + service factory + durable orchestrator. The
  // `delegate_coding` tool is registered unconditionally so the LLM sees
  // it; it throws a clear error at call time when the sandbox is
  // unavailable (rather than disappearing from the prompt every other
  // run).
  //
  // The streaming registry is the in-process pub/sub bridge between the
  // orchestrator (publisher, runs inside Inngest) and the Telegram
  // delivery adapter (subscriber, slice 2.0g). Single instance per
  // process; both sides look up by taskId.
  const codingStore = new DrizzleCodingStore(db);
  const codingBackend = new ClaudeCodeBackend();
  const codingStreamingRegistry = new CodingStreamingRegistry();
  const codingServiceFactory = (conversationId: string) =>
    createCodingService(
      {
        codingStore,
        inngest,
        sandboxAvailable: sandbox !== null,
      },
      conversationId,
    );

  // Register the durable orchestrator only when the sandbox is available
  // — without it the function would always fail at create-container.
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const codingFunctions: any[] = [];
  if (sandbox) {
    const orchestratorDeps = {
      store: codingStore,
      sandbox,
      backend: codingBackend,
      devbaseImage: env.COGMO_DEVBASE_IMAGE,
      defaultResourceLimits: { cpus: 2, memory_bytes: 2 * 1024 * 1024 * 1024, pids: 256 },
      taskTtlMs: env.CODING_TASK_IDLE_TTL_MINUTES * 60 * 1000,
      worktreesDir: env.COGMO_WORKTREES_DIR,
      openPlanStream: async (taskId: string): Promise<PlanStreamHandle> => ({
        async appendText(delta) {
          codingStreamingRegistry.publish(taskId, { kind: "text", delta });
        },
        async finalize(plan) {
          codingStreamingRegistry.publish(taskId, { kind: "plan_finalized", plan });
        },
        async fail(reason) {
          codingStreamingRegistry.publish(taskId, { kind: "failed", reason });
        },
      }),
      openExecuteStream: async (taskId: string): Promise<ExecuteStreamHandle> => ({
        async appendText(delta) {
          codingStreamingRegistry.publish(taskId, { kind: "text", delta });
        },
        async toolCall(tool) {
          codingStreamingRegistry.publish(taskId, { kind: "tool_call", tool });
        },
        async toolResult(tool, ok, summary) {
          codingStreamingRegistry.publish(taskId, {
            kind: "tool_result",
            tool,
            ok,
            ...(summary !== undefined && { summary }),
          });
        },
        async complete(ok) {
          codingStreamingRegistry.publish(taskId, { kind: "execute_complete", ok });
        },
        async fail(reason) {
          codingStreamingRegistry.publish(taskId, { kind: "failed", reason });
        },
      }),
    };
    codingFunctions.push(createCodingOrchestrator(orchestratorDeps, inngest));
    codingFunctions.push(createCodingExecuteOrchestrator(orchestratorDeps, inngest));
  }

  const tools = createDefaultTools(
    [
      ...memoryTools,
      ...webTools,
      ...fileTools,
      ...coreMemoryTools,
      ...imageTools,
      delegateCodingTool,
    ],
    env.USER_TIMEZONE,
  );
  const promptSource = new DefaultPromptSource({
    timezone: env.USER_TIMEZONE,
    toolDefinitions: () => tools.definitions(),
    serviceGuidance: [
      MEMORY_PROMPT_GUIDANCE,
      FILES_PROMPT_GUIDANCE,
      CORE_MEMORY_PROMPT_GUIDANCE,
      DELEGATE_CODING_GUIDANCE,
    ],
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
    codingStore,
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
    codingServiceFactory,
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
    ...codingFunctions,
  ];

  return {
    db,
    inngest,
    functions,
    adapters,
    agentStore,
    transportStore,
    sandboxStore,
    sandbox,
    sandboxInstanceId,
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
