import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import type { LlmProviderResolver } from "../../llm/resolver.js";
import type { ToolDefinition } from "../../llm/types.js";
import type { MemoryProvider } from "../../memory/provider.js";
import type { SkillRunner } from "../../skills/runner.js";
import { createSkillsService } from "../../skills/skills-service.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { CodingService } from "../coding/service.js";
import type { CoreMemoryScope } from "../core-memory/scope.js";
import { createPipelinesService } from "../pipeline/pipelines-service.js";
import type { PipelineRunStore, PipelineStore } from "../pipeline/store/index.js";
import { PIPELINE_TOOL_NAMES } from "../pipeline/tools.js";
import { createSchedulingService } from "../scheduling/scheduling-service.js";
import type { Service } from "../service.js";
import type { AgentStore, Profile } from "../store/index.js";
import { buildTurnService } from "../turn-service.js";

export interface ChatTurnServiceDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  memory: MemoryProvider;
  fileService: Service["files"];
  resolveProvider: LlmProviderResolver;
  userTimezone: string;
  codingServiceFactory?: (conversationId: string) => CodingService;
  skillRunner?: SkillRunner;
  pipelineStore?: PipelineStore;
  pipelineRunStore?: PipelineRunStore;
  pipelineGateChannelTypes?: ReadonlySet<string>;
}

export interface ChatTurnServiceArgs {
  conversationId: string;
  userId: string;
  profileId: string;
  profile: Profile | undefined;
  coreMemoryScope: CoreMemoryScope;
  /** The turn snapshot's model, which the pipeline compiler runs on. */
  model: string;
  /** The turn's offered tools, which a pipeline stage's tool-globs are validated against. */
  toolDefs: ReadonlyArray<ToolDefinition>;
}

/**
 * The scoped `Service` a chat turn's tools run against, with every namespace a
 * chat turn exposes. Bare body, on every invocation: services hold handlers,
 * not state.
 */
export async function buildChatTurnService(
  deps: ChatTurnServiceDeps,
  args: ChatTurnServiceArgs,
): Promise<Service> {
  const { conversationId, userId, profileId } = args;
  const codingService = deps.codingServiceFactory?.(conversationId);
  const skillsService = deps.skillRunner
    ? createSkillsService({
        runner: deps.skillRunner,
        inngest,
        conversationId,
        origin: { userId, profileId },
      })
    : undefined;
  // Scheduling service is scoped per-turn to (userId, profileId)
  // so `schedule_task` / `list_tasks` / `remove_task` can't leak
  // across users. Always constructed when handle-message runs —
  // unlike coding/skills there's no env-gated absence.
  const schedulingService = createSchedulingService({
    runInTx: deps.runInTx,
    agentStore: deps.agentStore,
    userId,
    profileId,
    defaultTimezone: deps.userTimezone,
  });
  // Pipelines service compiles on the conversation's current model and
  // validates stage tool-globs against this turn's composed tool list,
  // so a definition can't allowlist a tool the profile can't see. The
  // pipeline tools themselves are excluded — a run defining/activating
  // pipelines mid-run is a self-modification surface the
  // preview/confirm gate exists to prevent.
  const pipelinesService = deps.pipelineStore
    ? createPipelinesService({
        runInTx: deps.runInTx,
        store: deps.pipelineStore,
        userId,
        resolveProvider: deps.resolveProvider,
        model: args.model,
        validation: {
          availableTools: args.toolDefs
            .map((d) => d.name)
            .filter((name) => !PIPELINE_TOOL_NAMES.includes(name)),
          knownEventSources: [],
        },
        ...(deps.pipelineRunStore !== undefined && {
          run: {
            deps: {
              runInTx: deps.runInTx,
              pipelineStore: deps.pipelineStore,
              runStore: deps.pipelineRunStore,
              agentStore: deps.agentStore,
              transportStore: deps.transportStore,
              inngest,
              gateChannelTypes: deps.pipelineGateChannelTypes ?? new Set<string>(),
            },
            profileId,
            originConversationId: conversationId,
          },
        }),
      })
    : undefined;
  // Scoped service for this turn — must precede auto-recall so the recall
  // goes through the same `memoryScope` ACL filter every other memory
  // operation does.
  return buildTurnService(
    {
      runInTx: deps.runInTx,
      agentStore: deps.agentStore,
      memory: deps.memory,
      fileService: deps.fileService,
    },
    {
      userId,
      profile: args.profile,
      coreMemoryScope: args.coreMemoryScope,
      coding: codingService,
      skills: skillsService,
      scheduling: schedulingService,
      pipelines: pipelinesService,
    },
  );
}
