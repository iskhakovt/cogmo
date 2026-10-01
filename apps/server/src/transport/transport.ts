import type { Inngest } from "inngest";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { CompactConversationResult } from "../agent/conversation/compact-conversation.js";
import type { TriggerReflectionResult } from "../agent/evolution/trigger-reflection.js";
import type { PipelineRunStore } from "../agent/pipeline/store/index.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { SkillRunner } from "../skills/runner.js";
import type { SkillStore } from "../skills/store/index.js";
import type { AttachmentStore } from "./attachment-store.js";
import { type BoundaryNamespace, createBoundary } from "./namespaces/boundary.js";
import { type ChatsNamespace, createChats } from "./namespaces/chats.js";
import { type CodingNamespace, createCoding } from "./namespaces/coding.js";
import { type CompartmentsNamespace, createCompartments } from "./namespaces/compartments.js";
import type { TransportContext } from "./namespaces/context.js";
import { type ConversationsNamespace, createConversations } from "./namespaces/conversations.js";
import { createEvolution, type EvolutionNamespace } from "./namespaces/evolution.js";
import { createMcp, type McpNamespace } from "./namespaces/mcp.js";
import { createModels, type ModelsNamespace } from "./namespaces/models.js";
import { createPipelines, type PipelinesNamespace } from "./namespaces/pipelines.js";
import {
  createProfileClasses,
  type ProfileClassesNamespace,
} from "./namespaces/profile-classes.js";
import { createProfiles, type ProfilesNamespace } from "./namespaces/profiles.js";
import { createRepos, type ReposNamespace } from "./namespaces/repos.js";
import { createScheduling, type SchedulingNamespace } from "./namespaces/scheduling.js";
import { createSessions, type TransportSessions } from "./namespaces/sessions.js";
import { createSkills, type SkillsNamespace } from "./namespaces/skills.js";
import type { TransportStore } from "./store/index.js";

export type {
  CompactConversationOutcome,
  ConversationStatusSummary,
  CurrentConversation,
} from "./namespaces/conversations.js";
export type { EvolutionEventEntry, TriggerReflectionOutcome } from "./namespaces/evolution.js";
export type { ProfileInput } from "./namespaces/profiles.js";
export type { RepoCloneAndAddInput, RepoInput, RepoSummary } from "./namespaces/repos.js";
export type { ScheduledTaskAdminEntry } from "./namespaces/scheduling.js";
export type { SkillListEntry } from "./namespaces/skills.js";
export type { TransportError } from "./transport-error.js";

/**
 * Transport — the adapter-facing contract for session management and inbound emission.
 *
 * Scoped to a channel (channelId baked in). Adapters call it without knowing
 * about channelId, userId resolution, or event emission mechanics.
 *
 * Returns Result<T, TransportError> — adapters handle errors gracefully.
 */
export interface Transport extends TransportSessions {
  boundary: BoundaryNamespace;
  conversations: ConversationsNamespace;
  chats: ChatsNamespace;
  profiles: ProfilesNamespace;
  profileClasses: ProfileClassesNamespace;
  compartments: CompartmentsNamespace;
  models: ModelsNamespace;
  repos: ReposNamespace;
  coding: CodingNamespace;
  pipelines: PipelinesNamespace;
  skills: SkillsNamespace;
  scheduling: SchedulingNamespace;
  mcp: McpNamespace;
  evolution: EvolutionNamespace;
}

export interface TransportDeps {
  channelId: string;
  defaultUserId: string;
  defaultProfileId: string;
  runInTx: Transactor;
  transportStore: TransportStore;
  agentStore: AgentStore;
  /**
   * Optional — when undefined, `repos.*` returns `sandbox_disabled`.
   * Bootstrap supplies it whenever the sandbox module is initialized.
   */
  codingStore?: CodingStore;
  /**
   * Optional — when undefined, `repos.cloneAndAdd` returns
   * `github_identity_unavailable`. Bootstrap supplies it once the
   * encrypted-secrets store is initialized.
   */
  secretsStore?: SecretsStore;
  /**
   * Host root for git clones registered via `/repo add`. When undefined,
   * `repos.cloneAndAdd` returns `github_identity_unavailable` (we
   * intentionally re-use the same error rather than introducing a third
   * code; both indicate "the orchestrator can't talk to GitHub yet").
   */
  reposDir?: string;
  /**
   * Skills runner for the approve-tier callback. Optional — when
   * undefined, `skills.*` returns `skills_disabled`. Production wiring
   * always supplies it; some test setups omit.
   */
  skillRunner?: SkillRunner;
  /**
   * Skills store for resolving the deploy → skill → user owner during the
   * Telegram callback identity check. Optional — see `skillRunner`.
   */
  skillStore?: SkillStore;
  /**
   * Run store for the pipeline gate callback. Optional — when undefined,
   * `pipelines.*` returns `pipelines_disabled`.
   */
  pipelineRunStore?: PipelineRunStore;
  /**
   * MCP client registry. Production bootstrap always supplies it (the
   * registry is lazy-connect, so it carries zero cost when unused).
   * Optional only so tests don't have to wire a real registry when they
   * don't exercise `transport.mcp.*` — when absent, every method on the
   * namespace returns `mcp_disabled`.
   */
  mcpRegistry?: McpRegistry;
  /**
   * Synchronous Observer driver for the `/reflect` manual trigger.
   * Production bootstrap supplies it once the Observer is wired; test
   * setups that don't exercise `evolution.triggerReflection` may omit, in
   * which case the method returns `evolution_unavailable` while the
   * read-side methods on the same namespace stay available.
   */
  triggerReflection?: (conversationId: string) => Promise<TriggerReflectionResult>;
  /**
   * Synchronous compaction driver for the `/compact` manual trigger. Optional
   * for the same reason as `triggerReflection` — test setups that never call
   * `conversations.compact` can omit it, and the method returns
   * `compaction_unavailable`.
   */
  compactConversation?: (conversationId: string) => Promise<CompactConversationResult>;
  inngest: Inngest;
  inboundArrived: typeof InboundArrivedEvent;
  attachments: AttachmentStore;
  idleTimeoutMs: number;
  /**
   * `receive` mode stamped on sessions this transport opens
   * (`createConversation` / `resumeConversation`). Defaults to `"routed"`
   * (source routing). The web channel passes `"all"` so every tab watching a
   * conversation receives its streamed responses, not just the tab that sent
   * the turn.
   */
  sessionReceive?: "routed" | "all";
}

/**
 * Create a Transport scoped to a channel: one namespace module per surface,
 * each handed only the dependencies it reads.
 */
export function createTransport(deps: TransportDeps): Transport {
  const ctx: TransportContext = {
    channelId: deps.channelId,
    runInTx: deps.runInTx,
    transportStore: deps.transportStore,
    agentStore: deps.agentStore,
  };
  const { inngest } = deps;
  return {
    ...createSessions({
      ...ctx,
      defaultProfileId: deps.defaultProfileId,
      inngest,
      inboundArrived: deps.inboundArrived,
      attachments: deps.attachments,
      idleTimeoutMs: deps.idleTimeoutMs,
      sessionReceive: deps.sessionReceive ?? "routed",
    }),
    boundary: createBoundary({ ...ctx, inngest, defaultProfileId: deps.defaultProfileId }),
    conversations: createConversations({
      ...ctx,
      inngest,
      mcpRegistry: deps.mcpRegistry,
      compactConversation: deps.compactConversation,
    }),
    chats: createChats(ctx),
    profiles: createProfiles({ ...ctx, inngest }),
    profileClasses: createProfileClasses(ctx),
    compartments: createCompartments(ctx),
    models: createModels(ctx),
    repos: createRepos({
      runInTx: deps.runInTx,
      codingStore: deps.codingStore,
      secretsStore: deps.secretsStore,
      reposDir: deps.reposDir,
    }),
    coding: createCoding({ ...ctx, inngest, codingStore: deps.codingStore }),
    pipelines: createPipelines({ ...ctx, inngest, pipelineRunStore: deps.pipelineRunStore }),
    skills: createSkills({ ...ctx, skillRunner: deps.skillRunner, skillStore: deps.skillStore }),
    scheduling: createScheduling(ctx),
    mcp: createMcp({ ...ctx, mcpRegistry: deps.mcpRegistry }),
    evolution: createEvolution({ ...ctx, triggerReflection: deps.triggerReflection }),
  };
}
