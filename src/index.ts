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
import { createCodingVerifyOrchestrator } from "./agent/coding/verify-orchestrator.js";
import { coreMemoryTools } from "./agent/core-memory-tools.js";
import { createDebounceFunctions, type DebounceConfig } from "./agent/debounce.js";
import { createDocumentTools } from "./agent/document-tools.js";
import { createObserver } from "./agent/evolution/index.js";
import { fileTools } from "./agent/file-tools.js";
import { createFileService, FILES_PROMPT_GUIDANCE } from "./agent/files.js";
import { createHandleMessage } from "./agent/handle-message.js";
import { createIdleTimer } from "./agent/idle-timer.js";
import { createImageTools } from "./agent/image-tools.js";
import { runStreamingAgentLoop } from "./agent/loop.js";
import { memoryTools } from "./agent/memory-tools.js";
import { DefaultPromptSource } from "./agent/prompt.js";
import { createRecoverConversation } from "./agent/recover-conversation.js";
import { CORE_MEMORY_PROMPT_GUIDANCE, MEMORY_PROMPT_GUIDANCE } from "./agent/service.js";
import { DrizzleAgentStore } from "./agent/store/index.js";
import { createDefaultTools } from "./agent/tools.js";
import { createWebTools } from "./agent/web-tools.js";
import { db, transactor } from "./db/index.js";
import { env } from "./env.js";
import { inboundArrived, inngest } from "./inngest/index.js";
import type { LlmProvider } from "./llm/provider.js";
import {
  constantResolver,
  createDbProviderResolver,
  type LlmProviderResolver,
} from "./llm/resolver.js";
import { logger } from "./logger.js";
import { HostRunner as McpHostRunner } from "./mcp/client/runner.js";
import { McpRegistryImpl } from "./mcp/registry.js";
import { DrizzleMcpStore } from "./mcp/store/index.js";
import { HindsightMemoryProvider } from "./memory/hindsight.js";
import { CogmoSocketProxy, LocalInProcessSandbox, type Sandbox } from "./sandbox/index.js";
import { createSandboxReaper } from "./sandbox/reaper.js";
import { DrizzleSandboxStore } from "./sandbox/store/index.js";
import { deriveMasterKey, parseMasterKey } from "./secrets/encryption.js";
import { DrizzleSecretsStore } from "./secrets/store/index.js";
import { bootstrapSkillsRepo } from "./skills/repo.js";
import { SkillRunnerImpl } from "./skills/runner.js";
import { registerSkillTool, SKILLS_PROMPT_GUIDANCE } from "./skills/skills-tool.js";
import { DrizzleSkillStore } from "./skills/store/index.js";
import { createAttachmentStore } from "./transport/attachment-store.js";
import { createDeliveryRouter } from "./transport/delivery-router.js";
import { startChannels } from "./transport/registry.js";
import { DrizzleTransportStore } from "./transport/store/index.js";

export interface BootstrapOptions {
  /**
   * Inject a provider directly — skips DB resolution and serves the same
   * provider for every model. Used by tests; production wiring leaves this
   * undefined so the DB-backed resolver picks per turn.
   */
  providerOverride?: LlmProvider;
  /**
   * Custom `fetch` for the fal.ai provider — used by integration tests to
   * intercept fal HTTP traffic via a scoped fetch wrapper (see
   * `src/test/fal-mock.ts`). Production wiring leaves this undefined so the
   * SDK uses `globalThis.fetch`.
   */
  falFetchOverride?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Custom `fetch` for the OpenAI voice provider — used by integration tests
   * to intercept `/v1/audio/speech` and `/v1/audio/transcriptions` traffic
   * (see `src/test/openai-voice-mock.ts`). Production wiring leaves this
   * undefined so the SDK uses `globalThis.fetch`. Scoped to the voice
   * provider instance only — does not affect Anthropic/S3/etc.
   */
  voiceFetchOverride?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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

  // Bring the skills bare repo to its expected state on every boot —
  // idempotent. The pre-receive hook is rewritten unconditionally so a Cogmo
  // upgrade that tightens the policy takes effect on existing deployments.
  // See `design/skills.md` → Skill storage.
  const skillsRepo = await bootstrapSkillsRepo({ path: env.COGMO_SKILLS_PATH });
  if (skillsRepo.initialized) {
    logger.info({ path: skillsRepo.path }, "skills bare repo initialized");
  }

  const tx = transactor(db);
  const agentStore = new DrizzleAgentStore(tx);
  const transportStore = new DrizzleTransportStore(tx);
  const sandboxStore = new DrizzleSandboxStore(tx);

  // Sandbox is opt-in via SANDBOX_RUNTIME — coding-delegation features fail
  // with a clear error when the env var is unset. No silent fallback.
  let sandbox: Sandbox | null = null;
  let sandboxInstanceId: string | null = null;
  let sandboxDocker: Docker | null = null;
  if (env.SANDBOX_RUNTIME) {
    const docker = new Docker();
    sandboxDocker = docker;
    const instance = await sandboxStore.insertInstance({
      host: hostname(),
      pid: process.pid,
    });
    sandboxInstanceId = instance.id;
    const proxy = await CogmoSocketProxy.create({
      socketDir: env.SANDBOX_PROXY_SOCKET_DIR,
      hostDockerSocket: env.SANDBOX_HOST_DOCKER_SOCKET,
    });
    sandbox = await LocalInProcessSandbox.create({
      docker,
      store: sandboxStore,
      runtime: env.SANDBOX_RUNTIME,
      instanceId: instance.id,
      proxy,
      askpassBaseDir: env.SANDBOX_ASKPASS_DIR,
    });
    const { orphansReaped } = await sandbox.reconcileCrashedInstances(instance.id);
    if (orphansReaped > 0) {
      logger.warn({ orphansReaped }, "reaped orphan containers from prior instance(s)");
    }
    logger.info(
      {
        runtime: env.SANDBOX_RUNTIME,
        instanceId: instance.id,
        proxySocketDir: env.SANDBOX_PROXY_SOCKET_DIR,
      },
      "sandbox initialized",
    );
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
    tx,
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

  // Per-turn provider dispatch: handle-message and observer call this
  // resolver with the snapshot's model on every fire. The DB-backed
  // implementation memoizes by model so each (process, model) pair pays
  // one DB read + one AES decrypt total, then a Map lookup. Tests pass a
  // `providerOverride` to short-circuit to a single provider for every
  // model. See design/providers.md → Provider dispatch.
  const resolveProvider: LlmProviderResolver = opts.providerOverride
    ? constantResolver(opts.providerOverride)
    : createDbProviderResolver({ agentStore, secretsStore });

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
  const documentTools = createDocumentTools(attachmentStore);

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
  const codingStore = new DrizzleCodingStore(tx);
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
      // Threaded for the failure-cascade WIP-ref push (`safeTeardownWorktree`).
      // Verify-orchestrator already needs it for commit signing + push auth;
      // the plan/execute orchestrators reuse the same identity to push
      // dirty/unpushed worktrees to `refs/cogmo-wip/<taskId>` on failure.
      secretsStore,
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
        async started() {
          codingStreamingRegistry.publish(taskId, { kind: "execute_started" });
        },
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
        async complete(ok, tokens) {
          codingStreamingRegistry.publish(taskId, {
            kind: "execute_complete",
            ok,
            ...(tokens !== undefined && { tokens }),
          });
        },
        async fail(reason) {
          codingStreamingRegistry.publish(taskId, { kind: "failed", reason });
        },
      }),
    };
    codingFunctions.push(createCodingOrchestrator(orchestratorDeps, inngest));
    codingFunctions.push(createCodingExecuteOrchestrator(orchestratorDeps, inngest));
    codingFunctions.push(
      createCodingVerifyOrchestrator(
        {
          store: codingStore,
          sandbox,
          secretsStore,
          askpassBaseDir: env.SANDBOX_ASKPASS_DIR,
          devbaseImage: env.COGMO_DEVBASE_IMAGE,
          defaultResourceLimits: orchestratorDeps.defaultResourceLimits,
          taskTtlMs: orchestratorDeps.taskTtlMs,
          openExecuteStream: orchestratorDeps.openExecuteStream,
        },
        inngest,
      ),
    );

    // Sandbox reaper — runs every minute, kills TTL-expired containers,
    // discovers orphans tagged with dead instance ids, marks stale DB
    // rows exited. See `src/sandbox/reaper.ts`.
    if (sandboxDocker && sandboxInstanceId) {
      codingFunctions.push(
        createSandboxReaper(
          {
            docker: sandboxDocker,
            store: sandboxStore,
            instanceId: sandboxInstanceId,
          },
          inngest,
        ),
      );
    }
  }

  const tools = createDefaultTools(
    [
      ...memoryTools,
      ...webTools,
      ...fileTools,
      ...coreMemoryTools,
      ...imageTools,
      ...documentTools,
      delegateCodingTool,
      registerSkillTool,
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
      SKILLS_PROMPT_GUIDANCE,
    ],
    getUserContext: async () => {
      const blocks = await agentStore.getCoreMemoryBlocks(user.id);
      if (blocks.length === 0) return null;
      return blocks.map((b) => `## ${b.key}\n${b.content}`).join("\n\n");
    },
  });
  const memory = new HindsightMemoryProvider(env.HINDSIGHT_URL, {
    maxQueryTokens: env.HINDSIGHT_RECALL_MAX_QUERY_TOKENS,
  });

  // Skills runtime — Tier 1 ready in P3.1; register / classifier ship in P3.3.
  // The runner is exposed so the `cogmo skills` CLI subcommand can drive it
  // without re-bootstrapping. Bank id is the user id (per `design/memory.md`
  // single-user single-bank model). `skillsRepoPath` is what enables the
  // register / rollback flows to read SKILL.md from git and advance
  // `refs/heads/main`.
  const skillStore = new DrizzleSkillStore(tx);
  const skillRunner = await SkillRunnerImpl.create({
    store: skillStore,
    secretsStore,
    memory,
    files: fileService,
    ...(sandbox && { sandbox }),
    user: { id: user.id, timezone: env.USER_TIMEZONE },
    memoryBankId: user.id,
    skillsRepoPath: env.COGMO_SKILLS_PATH,
    // Cache Pyodide's pre-built packages under the skills repo's git dir
    // so JsDelivr fetches don't repeat across worker spawns. Only matters
    // for skills that micropip-install pure-Python wheels — the stdlib is
    // always bundled.
    pyodidePackageCacheDir: `${env.COGMO_SKILLS_PATH}/.pyodide-cache`,
  });

  const idleTimeoutMs = env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;
  const debounceConfig: DebounceConfig = {
    idleTimeoutMs: env.DEBOUNCE_IDLE_SECONDS * 1000,
    maxWaitMs: env.DEBOUNCE_MAXWAIT_SECONDS * 1000,
    resumePolicy: env.DEBOUNCE_RESUME_POLICY,
  };

  // Single MCP registry shared by handle-message (per-turn `resolveTools`) and
  // every channel's Transport (admin `/mcp` operations). Constructed before
  // startChannels so the same connection pool is reused — duplicate registries
  // would each spawn their own subprocess on first use.
  const mcpStore = new DrizzleMcpStore(tx);
  const mcpRegistry = new McpRegistryImpl({
    store: mcpStore,
    secrets: secretsStore,
    runner: new McpHostRunner(),
    callTimeoutMs: env.MCP_CALL_TIMEOUT_MS,
    idleEvictionMs: env.MCP_IDLE_EVICTION_MS,
    evictionIntervalMs: env.MCP_EVICTION_INTERVAL_MS,
    toolBudget: env.MCP_TOOL_BUDGET,
  });
  await mcpRegistry.start();

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
    codingStreamingRegistry,
    skillRunner,
    skillStore,
    mcpRegistry,
    inngest,
    inboundArrived,
    attachments: attachmentStore,
    idleTimeoutMs,
    secretsStore,
    reposDir: env.COGMO_REPOS_DIR,
  });

  const deliveryRouter = createDeliveryRouter({ adapters: adapterMap, transportStore });
  const idleTimer = createIdleTimer({ idleTimeoutMs, transportStore });
  const debounceFunctions = createDebounceFunctions(debounceConfig);

  // Voice — bootstrap a single OpenAIVoiceProvider when voice_config is
  // present. Decoupled from delivery via interfaces so swapping to
  // ElevenLabs/Deepgram later is a constructor change, not a wiring
  // change. See design/voice.md.
  //
  // voice_config is loaded ONCE at bootstrap; operator config changes
  // (swap voice, rotate key, change provider) require a process restart
  // in slice 1. Hot-reload is on the backlog (todo.md → "Voice config
  // hot-reload"). Personal-scale single-user tolerates the restart
  // cleanly; promote when multi-user lands or operator-driven tweaks
  // become frequent.
  const voiceCfgRow = await agentStore.getVoiceConfig();
  let ttsProvider: import("./voice/types.js").TtsProvider | undefined;
  let sttProvider: import("./voice/types.js").SttProvider | undefined;
  let voiceCfgForTurn: { ttsVoice: string; ttsModel: string } | undefined;
  if (voiceCfgRow) {
    // Slice 1 only ships OpenAIVoiceProvider. Surface a warn when the
    // operator points at an unsupported provider so the misconfig is
    // visible (otherwise voice silently degrades to text-only with no
    // operator-facing signal).
    if (voiceCfgRow.ttsProvider !== "openai") {
      logger.warn(
        { ttsProvider: voiceCfgRow.ttsProvider },
        "voice_config.tts_provider unsupported in slice 1 — voice replies disabled. Set tts_provider='openai' or wait for slice 2 (ElevenLabs/Deepgram).",
      );
    } else if (voiceCfgRow.sttProvider !== "openai") {
      logger.warn(
        { sttProvider: voiceCfgRow.sttProvider },
        "voice_config.stt_provider unsupported in slice 1 — voice transcription disabled. Set stt_provider='openai' or wait for slice 2.",
      );
    }
    const ttsKey = await secretsStore.getSecretById(voiceCfgRow.ttsSecretId);
    const sttKey = await secretsStore.getSecretById(voiceCfgRow.sttSecretId);
    if (ttsKey && sttKey && voiceCfgRow.ttsProvider === "openai") {
      const { OpenAIVoiceProvider } = await import("./voice/openai.js");
      const tts = new OpenAIVoiceProvider({
        apiKey: ttsKey,
        ...(voiceCfgRow.ttsBaseUrl && { baseURL: voiceCfgRow.ttsBaseUrl }),
        ...(opts.voiceFetchOverride && { fetch: opts.voiceFetchOverride }),
      });
      ttsProvider = tts;
      // Reuse the TTS provider for STT only when both keys AND base URLs
      // match — `tts` was constructed with `voiceCfgRow.ttsBaseUrl`, so
      // routing STT to it when sttBaseUrl differs would silently send STT
      // requests to the wrong endpoint. Swap independently when
      // ElevenLabs/Deepgram arrive.
      const canReuse =
        ttsKey === sttKey &&
        voiceCfgRow.sttProvider === "openai" &&
        voiceCfgRow.ttsBaseUrl === voiceCfgRow.sttBaseUrl;
      sttProvider = canReuse
        ? tts
        : voiceCfgRow.sttProvider === "openai"
          ? new OpenAIVoiceProvider({
              apiKey: sttKey,
              ...(voiceCfgRow.sttBaseUrl && { baseURL: voiceCfgRow.sttBaseUrl }),
              ...(opts.voiceFetchOverride && { fetch: opts.voiceFetchOverride }),
            })
          : undefined;
      voiceCfgForTurn = { ttsVoice: voiceCfgRow.ttsVoice, ttsModel: voiceCfgRow.ttsModel };
    }
  }

  const handleMessage = createHandleMessage({
    agentStore,
    transportStore,
    resolveProvider,
    tools,
    memory,
    promptSource,
    fileService,
    attachments: attachmentStore,
    debounceConfig,
    deliveryRouter,
    runStreamingAgentLoop,
    codingServiceFactory,
    skillRunner,
    mcpRegistry,
    ...(ttsProvider && { ttsProvider }),
    ...(sttProvider && { sttProvider }),
    ...(voiceCfgForTurn && { voiceConfig: voiceCfgForTurn }),
  });

  const observer = createObserver({
    agentStore,
    resolveProvider,
    memory,
  });

  const recoverConversation = createRecoverConversation({ agentStore });

  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [
    handleMessage,
    idleTimer,
    observer,
    recoverConversation,
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
    resolveProvider,
    memory,
    skillRunner,
    skillStore,
    mcpRegistry,
  };
}
