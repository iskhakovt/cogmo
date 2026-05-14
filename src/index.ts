import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { S3Client } from "@aws-sdk/client-s3";
import Docker from "dockerode";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ClaudeCodeBackend } from "./agent/coding/claude.js";
import { createOrphanRunBranchSweepFunctions } from "./agent/coding/cleanup-orphan-run-branches.js";
import { createRunBranchCleanupSubscriber } from "./agent/coding/cleanup-run-branch.js";
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
import { ImageToolsLoader } from "./agent/image-tools-loader.js";
import { runStreamingAgentLoop } from "./agent/loop.js";
import { memoryTools } from "./agent/memory-tools.js";
import { DefaultPromptSource } from "./agent/prompt.js";
import { createRecoverConversation } from "./agent/recover-conversation.js";
import { createScheduledTaskFireHandler } from "./agent/scheduling/fire-handler.js";
import { createScheduledTaskTicker } from "./agent/scheduling/ticker.js";
import { schedulingTools } from "./agent/scheduling/tools.js";
import type { Service } from "./agent/service.js";
import { CORE_MEMORY_PROMPT_GUIDANCE, MEMORY_PROMPT_GUIDANCE } from "./agent/service.js";
import { DrizzleAgentStore } from "./agent/store/index.js";
import { createDefaultTools } from "./agent/tools.js";
import { createWebTools } from "./agent/web-tools.js";
import {
  checkHindsightVersion,
  checkS3Bucket,
  checkUuidv7,
  loadHindsightCompat,
} from "./boot/checks.js";
import { type Database, db, type Transactor, transactor } from "./db/index.js";
import { env } from "./env.js";
import { inboundArrived, inngest } from "./inngest/index.js";
import type { LlmProvider } from "./llm/provider.js";
import {
  constantResolver,
  createDbProviderResolver,
  type LlmProviderResolver,
} from "./llm/resolver.js";
import { logger } from "./logger.js";
import { HostRunner as McpHostRunner, type Runner as McpRunner } from "./mcp/client/runner.js";
import { McpRegistryImpl } from "./mcp/registry.js";
import { DrizzleMcpStore } from "./mcp/store/index.js";
import { HindsightMemoryProvider } from "./memory/hindsight.js";
import { DAYTONA_API_KEY_SECRET } from "./sandbox/daytona/auth.js";
import { createSandboxBackend } from "./sandbox/factory.js";
import { CogmoSocketProxy, type SandboxClient } from "./sandbox/index.js";
import { createSandboxReaper } from "./sandbox/reaper.js";
import { DrizzleSandboxStore } from "./sandbox/store/index.js";
import { deriveMasterKey, parseMasterKey } from "./secrets/encryption.js";
import { DrizzleSecretsStore } from "./secrets/store/index.js";
import { ensureFalImageDefaults } from "./setup/seed.js";
import { bootstrapSkillsRepo, ensureSkillsCodingRepo } from "./skills/repo.js";
import { SkillRunnerImpl } from "./skills/runner.js";
import { registerSkillTool, SKILLS_PROMPT_GUIDANCE } from "./skills/skills-tool.js";
import { DrizzleSkillStore } from "./skills/store/index.js";
import type { AttachmentStore } from "./transport/attachment-store.js";
import { createAttachmentStore } from "./transport/attachment-store.js";
import { createDeliveryRouter } from "./transport/delivery-router.js";
import { wrapAttachmentStoreWithEncryption } from "./transport/encrypted-attachment-store.js";
import { startChannels } from "./transport/registry.js";
import { DrizzleTransportStore } from "./transport/store/index.js";
import type { SttProvider, TtsProvider } from "./voice/types.js";

/**
 * Per-stage option ownership — keep in sync when adding fields:
 *
 * - `providerOverride` → read by `bootstrapCore` (LLM provider resolver).
 * - `falFetchOverride`, `voiceFetchOverride` → read by `bootstrapRuntime`
 *   (fal.ai + OpenAI voice provider construction; both clients live next
 *   to the agent loop that consumes them).
 * - `sandboxClientOverride` → read by `bootstrapSandbox` (skips env-driven
 *   backend selection so tests can wire `FakeDaytonaSandboxClient`
 *   without hitting Daytona Cloud or a self-hosted compose).
 * - `mcpRunnerOverride` → read by `bootstrapRuntime` (swaps the production
 *   `HostRunner` for a test runner backed by `InMemoryTransport` so the
 *   pipeline-MCP integration test can drive the agent loop against an
 *   in-process MCP server without spawning a subprocess).
 *
 * `bootstrapSkillRunner` takes no options today. Adding a new field?
 * Add it to the relevant stage's signature and update this map so the
 * next reader knows where to wire it.
 */
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
  /**
   * Inject a fully-constructed sandbox client — skips backend selection
   * entirely (no env read, no secret read, no Docker handle). Used by
   * the bootstrap-daytona integration test to wire
   * `FakeDaytonaSandboxClient` so the daytona arm + cleanup-cron arm of
   * `bootstrapRuntime` exercise without paying for Daytona Cloud or
   * pulling a 10-service self-hosted compose. The override is treated
   * as a coding-capable backend: `sandbox` AND `codingSandbox` both
   * resolve to it (the orchestrator branches on `capabilities`, not
   * backend identity).
   */
  sandboxClientOverride?: SandboxClient;
  /**
   * Inject a custom MCP `Runner` — used by the pipeline-MCP integration
   * test to back the registry with an `InMemoryTransport` pair against
   * an in-process MCP server, avoiding subprocess spawn + readiness
   * probes for an LLM-driven recorded test. Production wiring leaves
   * this undefined so `new HostRunner()` is used.
   */
  mcpRunnerOverride?: McpRunner;
}

/**
 * Pure data layer — no Inngest registration, no long-lived background work.
 *
 * Returned by `bootstrapCore` and consumed by every other bootstrap stage.
 * One-shot CLIs (`cogmo migrate-memories`, `cogmo backfill`) call only
 * `bootstrapCore` and pull what they need directly off this object — they
 * never construct a sandbox client and never run the reaper, so they can't
 * race a live `cogmo serve` for its containers.
 */
export interface CoreDeps {
  db: Database;
  runInTx: Transactor;
  agentStore: DrizzleAgentStore;
  transportStore: DrizzleTransportStore;
  sandboxStore: DrizzleSandboxStore;
  codingStore: DrizzleCodingStore;
  mcpStore: DrizzleMcpStore;
  skillStore: DrizzleSkillStore;
  secretsStore: DrizzleSecretsStore;
  s3Client: S3Client;
  attachmentStore: AttachmentStore;
  fileService: Service["files"];
  /** Non-null when `S3_CLIENT_ENCRYPT=true`. Same key feeds files + attachments. */
  attachmentEncryptionKey: Uint8Array | null;
  /**
   * Tool-credential strings only. The data layer reads secrets; clients
   * (web tools, image generation provider, doc tools) are constructed in
   * `bootstrapRuntime` next to the agent loop that consumes them.
   */
  tavilyKey: string | undefined;
  openrouterKey: string | undefined;
  resolveProvider: LlmProviderResolver;
  user: { id: string };
  profile: { id: string };
  memory: HindsightMemoryProvider;
}

/**
 * Sandbox client + lifecycle handles. Returned by `bootstrapSandbox`.
 *
 * `bootstrapSandbox` schedules `reconcileCrashedInstances` as a background
 * task (see `scheduleReconcileCrashedInstances`) — it reaps any managed
 * container whose `cogmo.instance` label doesn't match this run's id but
 * does not block boot on the docker-daemon scan. Only `cogmo serve` calls
 * the stage at all — running it from a one-shot CLI would reap the live
 * `cogmo serve` instance's coding-task containers (no liveness check on
 * other instance rows). All fields are `null` when the configured backend
 * is unavailable (no `SANDBOX_RUNTIME`, missing `daytona_api_key`).
 */
export interface SandboxDeps {
  sandbox: SandboxClient | null;
  /**
   * Same handle as `sandbox` whenever a sandbox is configured. Coding
   * orchestrators take the wide `SandboxClient` type and branch on
   * `capabilities.workingTreeTransport` (`bind-mount` for local-docker,
   * `git-remote` for daytona) rather than backend identity. The split
   * exists because the registration gate is `codingSandbox !== null` —
   * keeping it as a separate field leaves room for a future backend
   * that's sandbox-capable but not coding-capable without widening the
   * `SandboxClient` interface.
   */
  codingSandbox: SandboxClient | null;
  sandboxInstanceId: string | null;
  sandboxDocker: Docker | null;
}

export const NO_SANDBOX: SandboxDeps = {
  sandbox: null,
  codingSandbox: null,
  sandboxInstanceId: null,
  sandboxDocker: null,
};

/**
 * Skill runner + its construction inputs. Returned by `bootstrapSkillRunner`.
 *
 * Tier-2 (sysbox / Daytona) only runs when `sandbox` is non-null. CLIs that
 * call `bootstrapSkillRunner(core, NO_SANDBOX)` get a runner that supports
 * tier-1 (Pyodide) skills + every admin subcommand (list / register /
 * approve / deny / rollback / deregister); tier-2 invocations throw a
 * clear "no sandbox configured" error at call time.
 */
export interface SkillRunnerHandle {
  skillRunner: SkillRunnerImpl;
}

/**
 * Inngest functions + transport adapters + per-runtime resources. Returned
 * by `bootstrapRuntime` for `cogmo serve`. Carries everything the orchestrator
 * needs to handle messages and the long-lived bookkeeping (MCP registry,
 * sandbox reaper) that must NOT run from a one-shot CLI.
 */
export interface RuntimeDeps {
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  functions: any[];
  adapters: Awaited<ReturnType<typeof startChannels>>["adapters"];
  mcpRegistry: McpRegistryImpl;
}

/**
 * Stage 1: data layer. Migrations, stores, secrets, S3, file service,
 * tool credentials, LLM provider resolver, the boot user/profile pair,
 * the Hindsight memory client. Constructs no sandbox, registers no
 * Inngest functions, starts no background work — concurrent invocations
 * with `cogmo serve` can't reap each other's sandboxes, which is the
 * specific race this stage was carved out to prevent. (Drizzle's PG
 * migrator advisory-locks against parallel migrate runs; the skills-repo
 * bootstrap is idempotent file writes.)
 */
export async function bootstrapCore(opts: BootstrapOptions = {}): Promise<CoreDeps> {
  await migrate(db, { migrationsFolder: "./migrations" });
  logger.info("database migrations applied");

  // Schema PKs default to `uuidv7()`. Verify the function is callable
  // before any code path inserts a row — a missing extension turns
  // every INSERT into a mid-turn `function does not exist` error
  // instead of a clear boot-time failure.
  await checkUuidv7(db);

  // Bring the skills bare repo to its expected state on every boot —
  // idempotent. The pre-receive hook is rewritten unconditionally so a Cogmo
  // upgrade that tightens the policy takes effect on existing deployments.
  // See `design/skills.md` → Skill storage.
  const skillsRepo = await bootstrapSkillsRepo({ path: env.COGMO_SKILLS_PATH });
  if (skillsRepo.initialized) {
    logger.info({ path: skillsRepo.path }, "skills bare repo initialized");
  }

  const tx = transactor(db);
  const agentStore = new DrizzleAgentStore();
  const transportStore = new DrizzleTransportStore();
  const sandboxStore = new DrizzleSandboxStore();
  const codingStore = new DrizzleCodingStore();
  const mcpStore = new DrizzleMcpStore();
  const skillStore = new DrizzleSkillStore();

  // DB half of the skills-repo bootstrap: keep `coding_repos.skills.remote_url`
  // in sync with the bare repo's `origin`. Idempotent — inserts on first run,
  // updates on subsequent boots after the operator changes origin via the
  // wizard or `cogmo migrate-skills-remote`, no-ops when already in sync.
  // When the bare repo has no origin yet, the call returns `skipped_no_origin`
  // and `delegate_coding({ repo: "skills" })` will fail with a clear message
  // until the wizard/CLI runs.
  await ensureSkillsCodingRepo({ runInTx: tx, codingStore }, { skillsRepoPath: skillsRepo.path });

  if (!env.COGMO_MASTER_KEY) {
    throw new Error(
      "COGMO_MASTER_KEY is required. Generate one with: cogmo gen-key\n" + "Then run: cogmo setup",
    );
  }
  const secretsStore = new DrizzleSecretsStore(
    deriveMasterKey(parseMasterKey(env.COGMO_MASTER_KEY), "cogmo/secrets-at-rest/v1"),
  );

  const { user, profile } = await tx(async (trx) => {
    const u = await agentStore.getFirstUser(trx);
    const defaultProfile = await agentStore.getDefaultProfile(trx);
    if (!u || !defaultProfile) {
      throw new Error("no user or profile found — run `cogmo setup` first");
    }
    const p = await agentStore.getProfile(trx, defaultProfile.id);
    if (!p) {
      throw new Error("default profile disappeared — database inconsistency");
    }
    return { user: u, profile: p };
  });

  // Per-turn provider dispatch: handle-message and observer call this
  // resolver with the snapshot's model on every fire. The DB-backed
  // implementation memoizes by model so each (process, model) pair pays
  // one DB read + one AES decrypt total, then a Map lookup. Tests pass a
  // `providerOverride` to short-circuit to a single provider for every
  // model. See design/providers.md → Provider dispatch.
  const resolveProvider: LlmProviderResolver = opts.providerOverride
    ? constantResolver(opts.providerOverride)
    : createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });

  // S3-compatible file storage (MinIO locally, AWS S3 / R2 in production).
  const s3Client = new S3Client({
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    region: env.S3_REGION,
    ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }
      : {}),
  });
  // Confirm the bucket is reachable + credentials work before tools that
  // depend on it (image generation, file workspace, attachment delivery)
  // start handling traffic. HeadBucket is the cheapest probe.
  await checkS3Bucket(s3Client, env.S3_BUCKET);
  // Optional client-side encryption — when enabled, attachment bodies AND
  // workspace file bodies are AES-256-GCM-encrypted before upload using
  // a key derived from `COGMO_MASTER_KEY` (already validated above).
  // Storage provider only ever sees ciphertext. Object keys remain
  // plaintext (matches the AWS S3 Encryption Client convention — if
  // file names need to stay secret, choose non-revealing names). See
  // the `S3_CLIENT_ENCRYPT` env-var doc for the full trade-off.
  const attachmentEncryptionKey = env.S3_CLIENT_ENCRYPT
    ? deriveMasterKey(parseMasterKey(env.COGMO_MASTER_KEY), "cogmo/s3-objects/v1")
    : null;
  const fileService = createFileService(
    s3Client,
    env.S3_BUCKET,
    attachmentEncryptionKey ? { key: attachmentEncryptionKey } : undefined,
  );
  const baseAttachmentStore = createAttachmentStore(s3Client, env.S3_BUCKET);
  const attachmentStore = attachmentEncryptionKey
    ? wrapAttachmentStoreWithEncryption(baseAttachmentStore, attachmentEncryptionKey)
    : baseAttachmentStore;
  if (env.S3_CLIENT_ENCRYPT) {
    logger.info(
      "S3_CLIENT_ENCRYPT=true — attachments and workspace files encrypted client-side with AES-256-GCM",
    );
  }

  // Tool credentials: DB first (wizard-configured), env fallback (dev convenience).
  const tavilyKey =
    (await tx((trx) => secretsStore.getSecret(trx, "tavily_api_key"))) ?? env.TAVILY_API_KEY;
  const openrouterKey =
    (await tx((trx) => secretsStore.getSecret(trx, "openrouter_api_key"))) ??
    env.OPENROUTER_API_KEY;
  const memory = new HindsightMemoryProvider(env.HINDSIGHT_URL, {
    maxQueryTokens: env.HINDSIGHT_RECALL_MAX_QUERY_TOKENS,
  });
  // Hard-fail when the running server reports a version outside the
  // compat range pinned in `package.json` → `cogmo.hindsightCompat`.
  // Soft-fail (warn) when /version itself can't be reached — memory
  // tools surface their own errors at request time. See `src/boot/checks.ts`.
  await checkHindsightVersion(memory, loadHindsightCompat());

  return {
    db,
    runInTx: tx,
    agentStore,
    transportStore,
    sandboxStore,
    codingStore,
    mcpStore,
    skillStore,
    secretsStore,
    s3Client,
    attachmentStore,
    fileService,
    attachmentEncryptionKey,
    tavilyKey,
    openrouterKey,
    resolveProvider,
    user,
    profile,
    memory,
  };
}

/**
 * Fire-and-forget orphan reaping. The per-minute sandbox reaper (local-docker)
 * and per-task TTL deletes (both backends) cover ongoing orphans; the boot-
 * time pass only matters for containers labelled with a *prior* instance id
 * that the periodic reaper would also catch on its next tick. Deferring it
 * keeps `cogmo serve` startup independent of how many orphan containers the
 * daemon happens to be carrying.
 */
export function scheduleReconcileCrashedInstances(client: SandboxClient, instanceId: string): void {
  const backendLabel = client.backendId;
  void client.reconcileCrashedInstances(instanceId).then(
    ({ orphansReaped }) => {
      if (orphansReaped > 0) {
        logger.warn(
          { orphansReaped, backendLabel },
          "reaped orphan sandboxes from prior instance(s)",
        );
      }
    },
    (err: unknown) => {
      logger.error(
        { err, instanceId, backendLabel },
        "background reconcileCrashedInstances failed",
      );
    },
  );
}

/**
 * Stage 2: sandbox client + crash-instance reconciliation. Inserts a row
 * into `cogmo_instances` (local-docker backend) so other Cogmo processes
 * can see this instance is live, then schedules an asynchronous pass that
 * reaps any container labeled with a dead instance id. The reaping is
 * fire-and-forget — see `scheduleReconcileCrashedInstances`. Only `cogmo
 * serve` should call this stage — running it from a one-shot CLI reaps the
 * live `cogmo serve`'s coding-task containers (no liveness check on other
 * instance rows).
 *
 * Returns `NO_SANDBOX` (all-null) when the configured backend is
 * unavailable: `local-docker` requires `SANDBOX_RUNTIME`; `daytona`
 * requires `daytona_api_key` in the encrypted secrets table.
 */
export async function bootstrapSandbox(
  core: CoreDeps,
  opts: BootstrapOptions = {},
): Promise<SandboxDeps> {
  // Test-only injection — see `BootstrapOptions.sandboxClientOverride`
  // for shape + intent. `sandboxDocker` stays null because the override
  // may not be a Docker-based backend; the reaper Inngest function is
  // local-docker-specific (queries the daemon via dockerode) and skips
  // registration when `sandboxDocker === null`.
  if (opts.sandboxClientOverride) {
    const sandbox = opts.sandboxClientOverride;
    const sandboxInstanceId = randomUUID();
    scheduleReconcileCrashedInstances(sandbox, sandboxInstanceId);
    logger.info(
      { backendId: sandbox.backendId, instanceId: sandboxInstanceId },
      "sandbox client override active (test-only)",
    );
    return {
      sandbox,
      codingSandbox: sandbox,
      sandboxInstanceId,
      sandboxDocker: null,
    };
  }
  // Sandbox is opt-in by backend:
  //   - `SANDBOX_BACKEND=local-docker` (default) requires `SANDBOX_RUNTIME`;
  //     unset = sandbox disabled (coding-delegation features fail at call
  //     time with a clear error). No silent fallback.
  //   - `SANDBOX_BACKEND=daytona` requires `daytona_api_key` in the
  //     encrypted secrets table; missing = sandbox disabled.
  // Both backends are coding-capable: local-docker via host-bind-mount
  // worktrees, daytona via git-as-transport (`cogmo/run/<task-id>` push
  // → sandbox-side clone). `codingSandbox` is the same handle as
  // `sandbox` whenever a backend is configured; the orchestrator
  // branches on `capabilities.workingTreeTransport`, not backend
  // identity. The split exists because the reaper Inngest function
  // remains local-docker-specific (queries the Docker daemon).
  if (env.SANDBOX_BACKEND === "local-docker") {
    if (!env.SANDBOX_RUNTIME) {
      logger.info(
        "SANDBOX_RUNTIME unset — sandbox module disabled (coding-delegation unavailable)",
      );
      return NO_SANDBOX;
    }
    const docker = new Docker();
    const instance = await core.runInTx((trx) =>
      core.sandboxStore.insertInstance(trx, { host: hostname(), pid: process.pid }),
    );
    const proxy = await CogmoSocketProxy.create({
      socketDir: env.SANDBOX_PROXY_SOCKET_DIR,
      hostDockerSocket: env.SANDBOX_HOST_DOCKER_SOCKET,
    });
    const localDocker = await createSandboxBackend({
      backend: "local-docker",
      docker,
      store: core.sandboxStore,
      runInTx: core.runInTx,
      runtime: env.SANDBOX_RUNTIME,
      instanceId: instance.id,
      proxy,
      askpassBaseDir: env.SANDBOX_ASKPASS_DIR,
    });
    const codingSandbox = localDocker;
    scheduleReconcileCrashedInstances(localDocker, instance.id);
    logger.info(
      {
        runtime: env.SANDBOX_RUNTIME,
        instanceId: instance.id,
        proxySocketDir: env.SANDBOX_PROXY_SOCKET_DIR,
      },
      "local-docker sandbox initialized",
    );
    return {
      sandbox: localDocker,
      codingSandbox,
      sandboxInstanceId: instance.id,
      sandboxDocker: docker,
    };
  }
  if (env.SANDBOX_BACKEND === "daytona") {
    const apiKey = await core.runInTx((trx) =>
      core.secretsStore.getSecret(trx, DAYTONA_API_KEY_SECRET),
    );
    if (!apiKey) {
      logger.warn(
        `SANDBOX_BACKEND=daytona but \`${DAYTONA_API_KEY_SECRET}\` secret is absent — sandbox disabled. Run \`cogmo setup\` to add it.`,
      );
      return NO_SANDBOX;
    }
    // Daytona needs a process-run id for label-stamping orphan
    // detection in a future reconcile pass. We don't insert into
    // sandbox_instances (that table FK's to local-docker
    // `containers`) — just generate one for symmetry with the
    // local-docker `cogmo.instance` label.
    const sandboxInstanceId = randomUUID();
    const sandbox = await createSandboxBackend({
      backend: "daytona",
      apiKey,
      instanceId: sandboxInstanceId,
      ...(env.DAYTONA_API_URL && { apiUrl: env.DAYTONA_API_URL }),
      ...(env.DAYTONA_ORGANIZATION_ID && { organizationId: env.DAYTONA_ORGANIZATION_ID }),
    });
    scheduleReconcileCrashedInstances(sandbox, sandboxInstanceId);
    logger.info(
      {
        instanceId: sandboxInstanceId,
        apiUrl: env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
      },
      "daytona sandbox initialized",
    );
    return { sandbox, codingSandbox: sandbox, sandboxInstanceId, sandboxDocker: null };
  }
  return NO_SANDBOX;
}

/**
 * Stage 3: skill runner. Used by both `cogmo serve` (where the runner is
 * shared between handle-message's `register_skill` tool and the channel
 * adapters' `/skill` admin commands) and `cogmo skills` (where the CLI
 * drives it directly). Tier-2 (sysbox/Daytona) skill execution requires
 * a non-null `sandbox`; CLIs pass `NO_SANDBOX` and accept that tier-2
 * invocations throw at call time.
 */
export async function bootstrapSkillRunner(
  core: CoreDeps,
  sandbox: SandboxDeps,
): Promise<SkillRunnerHandle> {
  const skillRunner = await SkillRunnerImpl.create({
    store: core.skillStore,
    runInTx: core.runInTx,
    secretsStore: core.secretsStore,
    memory: core.memory,
    files: core.fileService,
    ...(sandbox.sandbox && { sandbox: sandbox.sandbox }),
    tier2Image: env.COGMO_SKILLS_IMAGE,
    user: { id: core.user.id, timezone: env.USER_TIMEZONE },
    memoryBankId: core.user.id,
    skillsRepoPath: env.COGMO_SKILLS_PATH,
    // Cache Pyodide's pre-built packages under the skills repo's git dir
    // so JsDelivr fetches don't repeat across worker spawns. Only matters
    // for skills that micropip-install pure-Python wheels — the stdlib is
    // always bundled.
    pyodidePackageCacheDir: `${env.COGMO_SKILLS_PATH}/.pyodide-cache`,
    poolOptions: {
      min: env.COGMO_SKILLS_POOL_MIN,
      idleShutdownMs: env.COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS,
    },
  });
  return { skillRunner };
}

/**
 * Stage 4: agent runtime. Wires tools, prompt source, MCP registry,
 * channel adapters, voice provider, debounce / idle / observer / coding
 * orchestrator, and the sandbox reaper Inngest function. Only `cogmo
 * serve` calls this — every Inngest registration here goes into the
 * connect-mode app. Long-lived background work that must not run from a
 * one-shot CLI lives in this stage.
 */
export async function bootstrapRuntime(
  core: CoreDeps,
  sandbox: SandboxDeps,
  skillRunner: SkillRunnerImpl,
  opts: BootstrapOptions = {},
): Promise<RuntimeDeps> {
  const codingBackend = new ClaudeCodeBackend();
  const codingStreamingRegistry = new CodingStreamingRegistry();
  const codingServiceFactory = (conversationId: string) =>
    createCodingService(
      {
        runInTx: core.runInTx,
        codingStore: core.codingStore,
        inngest,
        sandboxAvailable: sandbox.codingSandbox !== null,
      },
      conversationId,
    );

  // Register the durable orchestrator only when the LOCAL-DOCKER sandbox
  // is available — coding-delegation needs the host-bind-mount + askpass
  // surface that Phase 3a doesn't expose on Daytona. Phase 3b lifts this.
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const codingFunctions: any[] = [];
  if (sandbox.codingSandbox) {
    const orchestratorDeps = {
      runInTx: core.runInTx,
      store: core.codingStore,
      sandbox: sandbox.codingSandbox,
      backend: codingBackend,
      // Threaded for the failure-cascade WIP-ref push (`safeTeardownWorktree`).
      // Verify-orchestrator already needs it for commit signing + push auth;
      // the plan/execute orchestrators reuse the same identity to push
      // dirty/unpushed worktrees to `refs/cogmo-wip/<taskId>` on failure.
      secretsStore: core.secretsStore,
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
          runInTx: core.runInTx,
          store: core.codingStore,
          sandbox: sandbox.codingSandbox,
          secretsStore: core.secretsStore,
          askpassBaseDir: env.SANDBOX_ASKPASS_DIR,
          devbaseImage: env.COGMO_DEVBASE_IMAGE,
          defaultResourceLimits: orchestratorDeps.defaultResourceLimits,
          taskTtlMs: orchestratorDeps.taskTtlMs,
          openExecuteStream: orchestratorDeps.openExecuteStream,
        },
        inngest,
      ),
    );

    // Event-driven cleanup of `cogmo/run/*` branches once a task reaches
    // a terminal state (`pr_open` or `failed`). Best-effort — the weekly
    // cron in `cleanup-orphan-run-branches.ts` is the safety net for
    // events that never fired.
    codingFunctions.push(
      createRunBranchCleanupSubscriber(
        {
          runInTx: core.runInTx,
          store: core.codingStore,
          secretsStore: core.secretsStore,
        },
        inngest,
      ),
    );

    // Weekly orphan-run-branch sweep — safety net for refs the
    // event-driven cleanup missed (host crash before emit, drift,
    // foreign refs). Cron emits one event per repo; the per-repo
    // handler queries origin + DB and force-deletes stale refs.
    codingFunctions.push(
      ...createOrphanRunBranchSweepFunctions(
        {
          runInTx: core.runInTx,
          store: core.codingStore,
          secretsStore: core.secretsStore,
        },
        inngest,
      ),
    );

    // Sandbox reaper — runs every minute, kills TTL-expired containers,
    // discovers orphans tagged with dead instance ids, marks stale DB
    // rows exited. See `src/sandbox/reaper.ts`.
    if (sandbox.sandboxDocker && sandbox.sandboxInstanceId) {
      codingFunctions.push(
        createSandboxReaper(
          {
            docker: sandbox.sandboxDocker,
            store: core.sandboxStore,
            runInTx: core.runInTx,
            instanceId: sandbox.sandboxInstanceId,
          },
          inngest,
        ),
      );
    }
  }

  // Tool clients live with the agent loop that consumes them. Core
  // exposes credentials as strings; runtime turns them into clients.
  const webTools = createWebTools(core.tavilyKey, core.openrouterKey);

  // Image gen catalog is DB-driven (image_providers + image_models). At boot
  // we seed the canonical fal catalog if a fal secret exists — handles both
  // wizard-driven setups and the legacy FAL_API_KEY env var path. The
  // catalog itself is loaded per-turn by `ImageToolsLoader`, so wizard / CLI
  // CRUD takes effect immediately without a restart; provider adapters are
  // memoized inside the loader so we only decrypt + construct each provider's
  // SDK client once per process.
  await ensureFalImageDefaults({
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    secretsStore: core.secretsStore,
    ...(env.FAL_API_KEY && { envFalApiKey: env.FAL_API_KEY }),
  });
  const imageToolsLoader = new ImageToolsLoader({
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    secretsStore: core.secretsStore,
    attachments: core.attachmentStore,
    ...(opts.falFetchOverride && { fetchOverrides: { fal: opts.falFetchOverride } }),
  });
  const documentTools = createDocumentTools(core.attachmentStore);

  const tools = createDefaultTools(
    [
      ...memoryTools,
      ...webTools,
      ...fileTools,
      ...coreMemoryTools,
      ...documentTools,
      ...schedulingTools,
      delegateCodingTool,
      registerSkillTool,
    ],
    env.USER_TIMEZONE,
  );
  const promptSource = new DefaultPromptSource({
    timezone: env.USER_TIMEZONE,
    serviceGuidance: [
      MEMORY_PROMPT_GUIDANCE,
      FILES_PROMPT_GUIDANCE,
      CORE_MEMORY_PROMPT_GUIDANCE,
      DELEGATE_CODING_GUIDANCE,
      SKILLS_PROMPT_GUIDANCE,
    ],
    getUserContext: async () => {
      const blocks = await core.runInTx((trx) =>
        core.agentStore.getCoreMemoryBlocks(trx, core.user.id),
      );
      if (blocks.length === 0) return null;
      return blocks.map((b) => `## ${b.key}\n${b.content}`).join("\n\n");
    },
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
  const mcpRegistry = new McpRegistryImpl({
    store: core.mcpStore,
    secrets: core.secretsStore,
    runInTx: core.runInTx,
    runner: opts.mcpRunnerOverride ?? new McpHostRunner(),
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
    defaultUserId: core.user.id,
    defaultProfileId: core.profile.id,
    runInTx: core.runInTx,
    transportStore: core.transportStore,
    agentStore: core.agentStore,
    codingStore: core.codingStore,
    codingStreamingRegistry,
    skillRunner,
    skillStore: core.skillStore,
    mcpRegistry,
    inngest,
    inboundArrived,
    attachments: core.attachmentStore,
    idleTimeoutMs,
    secretsStore: core.secretsStore,
    reposDir: env.COGMO_REPOS_DIR,
  });

  const deliveryRouter = createDeliveryRouter({
    runInTx: core.runInTx,
    adapters: adapterMap,
    transportStore: core.transportStore,
  });
  const idleTimer = createIdleTimer({
    idleTimeoutMs,
    runInTx: core.runInTx,
    transportStore: core.transportStore,
  });
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
  const voiceCfgRow = await core.runInTx((trx) => core.agentStore.getVoiceConfig(trx));
  let ttsProvider: TtsProvider | undefined;
  let sttProvider: SttProvider | undefined;
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
    const ttsKey = await core.runInTx((trx) =>
      core.secretsStore.getSecretById(trx, voiceCfgRow.ttsSecretId),
    );
    const sttKey = await core.runInTx((trx) =>
      core.secretsStore.getSecretById(trx, voiceCfgRow.sttSecretId),
    );
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
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    transportStore: core.transportStore,
    resolveProvider: core.resolveProvider,
    tools,
    imageToolsLoader,
    memory: core.memory,
    promptSource,
    fileService: core.fileService,
    attachments: core.attachmentStore,
    debounceConfig,
    deliveryRouter,
    runStreamingAgentLoop,
    codingServiceFactory,
    skillRunner,
    mcpRegistry,
    userTimezone: env.USER_TIMEZONE,
    ...(ttsProvider && { ttsProvider }),
    ...(sttProvider && { sttProvider }),
    ...(voiceCfgForTurn && { voiceConfig: voiceCfgForTurn }),
  });

  const observer = createObserver({
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    transportStore: core.transportStore,
    resolveProvider: core.resolveProvider,
    memory: core.memory,
  });

  const recoverConversation = createRecoverConversation({
    runInTx: core.runInTx,
    agentStore: core.agentStore,
  });

  // Scheduled-task ticker — static 1-min cron that locks due rows from
  // `scheduled_tasks` and fans out `agent/scheduled-task.fire` events.
  // See `src/agent/scheduling/ticker.ts`.
  const scheduledTaskTicker = createScheduledTaskTicker(
    { runInTx: core.runInTx, store: core.agentStore },
    inngest,
  );

  // Scheduled-task fire handler — receives `agent/scheduled-task.fire`
  // events from the ticker, finds the user's active session for the
  // task's profile, persists a synthetic inbound, and re-enters the
  // normal pipeline via `inbound/arrived`. See
  // `src/agent/scheduling/fire-handler.ts`.
  const scheduledTaskFire = createScheduledTaskFireHandler(
    { runInTx: core.runInTx, transportStore: core.transportStore },
    inngest,
  );

  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [
    handleMessage,
    idleTimer,
    observer,
    recoverConversation,
    scheduledTaskTicker,
    scheduledTaskFire,
    ...debounceFunctions,
    ...channelFunctions,
    ...codingFunctions,
  ];

  return { functions, adapters, mcpRegistry };
}

/**
 * Aggregate bootstrap — wires every stage together. Used by `cogmo serve`
 * and the integration test harness.
 *
 * One-shot CLIs (`cogmo skills`, `cogmo migrate-memories`, `cogmo backfill`)
 * call only the stages they need. See `src/main.ts` for the dispatch.
 */
export async function bootstrap(opts: BootstrapOptions = {}) {
  const core = await bootstrapCore(opts);
  const sandbox = await bootstrapSandbox(core, opts);
  const { skillRunner } = await bootstrapSkillRunner(core, sandbox);
  const runtime = await bootstrapRuntime(core, sandbox, skillRunner, opts);

  // Spread every stage so any field added to a stage interface flows
  // through to callers without touching the aggregate. `inngest` and
  // `skillRunner` are added explicitly because they're not on any stage
  // shape (the inngest client is a module-level singleton; the skill
  // runner returns from its own factory, unwrapped here).
  return {
    ...core,
    ...sandbox,
    ...runtime,
    inngest,
    skillRunner,
  };
}
