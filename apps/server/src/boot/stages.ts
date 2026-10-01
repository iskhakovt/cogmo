/**
 * The contracts between bootstrap stages: the options each stage reads and
 * what each returns to the next.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import type { Octokit } from "@octokit/rest";
import type Docker from "dockerode";
import type { CodingOrchestratorDeps } from "../agent/coding/orchestrator.js";
import type { DrizzleCodingStore } from "../agent/coding/store/index.js";
import type { CodingStreamingRegistry } from "../agent/coding/streaming-registry.js";
import type { DrizzleModelCatalogStore } from "../agent/model-catalog/store/index.js";
import type {
  DrizzlePipelineRunStore,
  DrizzlePipelineStore,
} from "../agent/pipeline/store/index.js";
import type { Service } from "../agent/service.js";
import type { DrizzleAgentStore } from "../agent/store/index.js";
import type { BootstrapLock } from "../db/bootstrap-lock.js";
import type { Database, Transactor } from "../db/index.js";
import type { LlmProvider } from "../llm/provider.js";
import type { LlmProviderResolver } from "../llm/resolver.js";
import type { McpRegistryImpl } from "../mcp/registry.js";
import type { DrizzleMcpStore } from "../mcp/store/index.js";
import type { HindsightMemoryProvider } from "../memory/hindsight.js";
import type { SandboxClient } from "../sandbox/index.js";
import type { DrizzleSandboxStore } from "../sandbox/store/index.js";
import type { DrizzleSecretsStore } from "../secrets/store/index.js";
import type { SkillRunnerImpl, SkillRunnerOptions } from "../skills/runner.js";
import type { DrizzleSkillStore } from "../skills/store/index.js";
import type { WebStreamRegistry } from "../transport/adapters/web/stream-registry.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import type { startChannels } from "../transport/registry.js";
import type { DrizzleTransportStore } from "../transport/store/index.js";
import type { Transport } from "../transport/transport.js";
import type { DrizzleWebSessionStore } from "../web/store/index.js";
import type { HindsightCompat } from "./checks.js";

/**
 * Per-stage option ownership — keep in sync when adding fields:
 *
 * - `providerOverride` → read by `bootstrapCore` (LLM provider resolver).
 * - `falFetchOverride`, `veniceFetchOverride`, `voiceFetchOverride` → read by
 *   `bootstrapRuntime` (fal.ai / Venice.ai image + OpenAI voice provider
 *   construction; all clients live next to the agent loop that consumes
 *   them).
 * - `sandboxClientOverride` → read by `bootstrapSandbox` (skips env-driven
 *   backend selection so tests can wire `FakeDaytonaSandboxClient`
 *   without hitting Daytona Cloud or a self-hosted compose).
 * - `skillCtxHttpOverride` → read by `bootstrapSkillRunner` (the network
 *   skills reach through `ctx.http`).
 * - `codingAuthOverride`, `octokitFactory` → read by `bootstrapRuntime`
 *   (the coding orchestrators' in-sandbox auth and GitHub client).
 *
 * Adding a new field? Add it to the relevant stage's signature and update
 * this map so the next reader knows where to wire it.
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
   * Custom `fetch` for the Venice.ai image provider — used by integration
   * tests to intercept Venice HTTP traffic (see `src/test/venice-mock.ts`).
   * Production wiring leaves this undefined so the adapter uses
   * `globalThis.fetch`. Scoped to the venice provider instance only.
   */
  veniceFetchOverride?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
   * Test-only override for the in-sandbox coding-auth resolver. When
   * omitted, the orchestrators use the real `loadCodingSandboxEnv` —
   * missing `claude_code_oauth_token` then fails fast (no silent
   * fallback to metered API-key billing for users who forgot to run
   * `claude setup-token`).
   */
  codingAuthOverride?: CodingOrchestratorDeps["loadCodingSandboxEnv"];
  /** Test seam — stub injected by replay tests in lieu of real GitHub. */
  octokitFactory?: (pat: string) => Octokit;
  /**
   * Stand-in network for `ctx.http` — a resolver and a `fetch` that
   * answer a skill's request inside the test process, so a suite that
   * invokes a network-calling skill stays off the public internet. The
   * allowlist and address checks still run against what it answers.
   * Production wiring leaves this undefined: real DNS, global `fetch`.
   */
  skillCtxHttpOverride?: SkillRunnerOptions["ctxHttp"];
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
  /** The bootstrap lock on `db`'s pool, held by later stages' boot seeding. */
  bootstrapLock: BootstrapLock;
  agentStore: DrizzleAgentStore;
  transportStore: DrizzleTransportStore;
  sandboxStore: DrizzleSandboxStore;
  codingStore: DrizzleCodingStore;
  modelCatalogStore: DrizzleModelCatalogStore;
  pipelineStore: DrizzlePipelineStore;
  pipelineRunStore: DrizzlePipelineRunStore;
  mcpStore: DrizzleMcpStore;
  skillStore: DrizzleSkillStore;
  secretsStore: DrizzleSecretsStore;
  webSessionStore: DrizzleWebSessionStore;
  /** Bootstrap login token, derived from the master key. Stored nowhere. */
  webLoginToken: string;
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
  /** Supported Hindsight server range, read once from `package.json`. */
  hindsightCompat: HindsightCompat;
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
  /**
   * Web-scoped Transport for the UI server's oRPC layer. `null` is
   * defensive-only: `seedRuntimeDefaults` provisions the web channel first, so a real boot always
   * resolves a channel — the null arm backstops a since-deleted channel and is
   * exercised by tests, not a runtime gap.
   */
  webTransport: Transport | null;
  /**
   * SSE bridge shared by the WebUiAdapter and the UI server's chat routes.
   * Always present (created unconditionally); empty until tabs connect.
   */
  webStreamRegistry: WebStreamRegistry;
  /** Coding progress streams; `cogmo serve` closes their sweep on shutdown. */
  codingStreams: Pick<CodingStreamingRegistry, "close">;
}
