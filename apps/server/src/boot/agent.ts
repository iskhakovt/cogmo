/**
 * The agent: its tools and prompt source, the `/reflect` and `/compact`
 * drivers, and the Inngest functions that run turns, pipelines, the Observer
 * and scheduled tasks.
 */

import { BUILT_IN_SERVICE_GUIDANCE, builtInToolSpecs } from "../agent/built-ins.js";
import type { CodingService } from "../agent/coding/service.js";
import { compactConversation } from "../agent/conversation/compact-conversation.js";
import { createDocumentTools } from "../agent/document-tools.js";
import { createObserver, triggerReflection } from "../agent/evolution/index.js";
import { createHandleMessage } from "../agent/handle-message.js";
import { ImageToolsLoader } from "../agent/image-tools-loader.js";
import { runStreamingAgentLoop } from "../agent/loop.js";
import { createPipelineGateResolver } from "../agent/pipeline/gate-resolver.js";
import { createPipelineGateWaiter } from "../agent/pipeline/gate-waiter.js";
import { type AgenticStageDeps, runAgenticStage } from "../agent/pipeline/run-agentic-stage.js";
import { createPipelineStageRunner } from "../agent/pipeline/stage-runner.js";
import { DefaultPromptSource } from "../agent/prompt.js";
import { createHandleMessageReconcile } from "../agent/reconcile-on-failure.js";
import { createRecoverConversation } from "../agent/recover-conversation.js";
import { createScheduledTaskFireHandler } from "../agent/scheduling/fire-handler.js";
import { createScheduledTaskTicker } from "../agent/scheduling/ticker.js";
import { createDefaultTools, type ToolSpec } from "../agent/tools.js";
import { env } from "../env.js";
import { inngest } from "../inngest/index.js";
import type { McpRegistryImpl } from "../mcp/registry.js";
import type { SkillRunnerImpl } from "../skills/runner.js";
import { adapterModules } from "../transport/adapters/index.js";
import type { DeliveryRouter } from "../transport/delivery-router.js";
import { createDbVoiceResolver } from "../voice/resolver.js";
import type { BootstrapOptions, CoreDeps } from "./stages.js";
import type { SessionTiming } from "./transport.js";

/** The tool registry and prompt source every turn and agentic stage runs with. */
export function createAgentTools(
  core: CoreDeps,
  webTools: ReadonlyArray<ToolSpec>,
  opts: BootstrapOptions,
) {
  const imageToolsLoader = new ImageToolsLoader({
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    secretsStore: core.secretsStore,
    attachments: core.attachmentStore,
    ...((opts.falFetchOverride || opts.veniceFetchOverride) && {
      fetchOverrides: {
        ...(opts.falFetchOverride && { fal: opts.falFetchOverride }),
        ...(opts.veniceFetchOverride && { venice: opts.veniceFetchOverride }),
      },
    }),
  });
  const documentTools = createDocumentTools(core.attachmentStore);

  const tools = createDefaultTools(
    builtInToolSpecs({ webTools, documentTools }),
    env.USER_TIMEZONE,
  );
  const promptSource = new DefaultPromptSource({
    serviceGuidance: BUILT_IN_SERVICE_GUIDANCE,
  });
  return { imageToolsLoader, tools, promptSource };
}

type AgentTools = ReturnType<typeof createAgentTools>;

/** In-process `/reflect` and `/compact`, injected into every Transport. */
export function createConversationTriggers(core: CoreDeps, promptSource: DefaultPromptSource) {
  // Sync Observer driver injected into every Transport so `/reflect` can
  // run the Observer in-process and reply with the digest in the same turn.
  // Shares deps with `createObserver` — the autonomous Inngest path and the
  // manual path execute the same `runObserver` body.
  const reflectionTrigger = (conversationId: string) =>
    triggerReflection(conversationId, observerDeps(core));

  // Sync compaction driver injected into every Transport so `/compact` can
  // summarize and store in-process, ahead of the budget pressure that would
  // otherwise trigger it at the front of the user's next turn.
  const compactionTrigger = (conversationId: string) =>
    compactConversation(conversationId, {
      runInTx: core.runInTx,
      agentStore: core.agentStore,
      resolveProvider: core.resolveProvider,
      promptSource,
    });

  return { reflectionTrigger, compactionTrigger };
}

export interface AgentFunctionWiring {
  agentTools: AgentTools;
  timing: SessionTiming;
  deliveryRouter: DeliveryRouter;
  codingServiceFactory: (conversationId: string) => CodingService;
  skillRunner: SkillRunnerImpl;
  mcpRegistry: McpRegistryImpl;
}

export function createAgentFunctions(
  core: CoreDeps,
  wiring: AgentFunctionWiring,
  opts: BootstrapOptions,
) {
  const { agentTools, timing, deliveryRouter, codingServiceFactory, skillRunner, mcpRegistry } =
    wiring;
  const { tools, imageToolsLoader, promptSource } = agentTools;

  // Voice — lazy per-turn resolver. Reads `voice_config` + decrypts both
  // secrets per call (sub-ms each), caches constructed providers by content
  // hash so steady-state is one cache hit per turn. Config edits (swap
  // voice id, change model, switch provider) and secret rotations take
  // effect on the next message with no process restart. See
  // `src/voice/resolver.ts` and design/voice.md.
  const voiceResolver = createDbVoiceResolver({
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    secretsStore: core.secretsStore,
    ...(opts.voiceFetchOverride && { fetch: opts.voiceFetchOverride }),
  });

  // What a chat turn and an agentic pipeline stage both run the agent loop with.
  const turnDeps: AgenticStageDeps = {
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    transportStore: core.transportStore,
    resolveProvider: core.resolveProvider,
    tools,
    imageToolsLoader,
    memory: core.memory,
    promptSource,
    fileService: core.fileService,
    deliveryRouter,
    runStreamingAgentLoop,
    codingServiceFactory,
    skillRunner,
    mcpRegistry,
    userTimezone: env.USER_TIMEZONE,
  };

  const handleMessage = createHandleMessage({
    ...turnDeps,
    attachments: core.attachmentStore,
    debounceConfig: timing.debounceConfig,
    voiceResolver,
    pipelineStore: core.pipelineStore,
    pipelineRunStore: core.pipelineRunStore,
    pipelineGateChannelTypes: new Set(
      adapterModules
        .filter((module) => module.pipelineGates === true)
        .map((module) => module.channelType),
    ),
  });

  // User-defined pipeline runs (design/pipelines.md → Execution Model): one
  // short function per stage, gates parked in the DB behind a timeout waiter,
  // and a resolver that owns the `waiting_gate` transition for taps and
  // timeouts alike.
  const pipelineStageRunner = createPipelineStageRunner({
    runInTx: core.runInTx,
    runStore: core.pipelineRunStore,
    deliveryRouter,
    executeAgenticStage: (args, steps, log) => runAgenticStage(turnDeps, args, steps, log),
  });
  const pipelineGateWaiter = createPipelineGateWaiter({ deliveryRouter });
  const pipelineGateResolver = createPipelineGateResolver({
    runInTx: core.runInTx,
    runStore: core.pipelineRunStore,
    deliveryRouter,
  });

  const observer = createObserver(observerDeps(core));

  const recoverConversation = createRecoverConversation({
    runInTx: core.runInTx,
    agentStore: core.agentStore,
  });

  // Worker-death reconcile — subscribes to `inngest/function.failed` and
  // re-emits `conversation/errored` with bus-level dedup
  // (`id: errored-${runId}`) when `handle-message`'s `onFailure` couldn't
  // fire (Inngest connect-mode worker-death class). Mirrors the coding
  // reconciler shape. See design/agent-resilience.md → Triggers.
  const handleMessageReconcile = createHandleMessageReconcile(inngest);

  // Scheduled-task ticker — static 1-min cron that locks due rows from
  // `scheduled_tasks` and fans out `agent/scheduled-task.fire` events.
  // See `src/agent/scheduling/ticker.ts`.
  const scheduledTaskTicker = createScheduledTaskTicker(
    { runInTx: core.runInTx, store: core.agentStore },
    inngest,
  );

  // Scheduled-task fire handler — receives `agent/scheduled-task.fire`,
  // reuses the user's engaged conversation or rotates onto a fresh one,
  // persists a synthetic inbound, and re-enters the pipeline via
  // `inbound/arrived`. See `src/agent/scheduling/fire-handler.ts`.
  const scheduledTaskFire = createScheduledTaskFireHandler(
    {
      runInTx: core.runInTx,
      agentStore: core.agentStore,
      transportStore: core.transportStore,
      idleTimeoutMs: timing.idleTimeoutMs,
    },
    inngest,
  );

  return {
    handleMessage,
    pipelineStageRunner,
    pipelineGateWaiter,
    pipelineGateResolver,
    observer,
    recoverConversation,
    handleMessageReconcile,
    scheduledTaskTicker,
    scheduledTaskFire,
  };
}

/** The Observer's deps, shared by its Inngest function and the `/reflect` driver. */
function observerDeps(core: CoreDeps) {
  return {
    runInTx: core.runInTx,
    agentStore: core.agentStore,
    transportStore: core.transportStore,
    resolveProvider: core.resolveProvider,
    memory: core.memory,
  };
}
